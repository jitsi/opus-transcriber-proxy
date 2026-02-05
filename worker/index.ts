import { Container, getContainer } from '@cloudflare/containers';
import type { Env } from './env';

/**
 * Dispatcher message format for transcription events
 */
export interface DispatcherTranscriptionMessage {
	sessionId: string;
	endpointId: string;
	text: string;
	timestamp: number;
	language?: string;
}

/**
 * TranscriptionDispatcher service interface
 */
export interface TranscriptionDispatcher {
	fetch(request: Request): Promise<Response>;
}

/**
 * Transcription message from container
 */
interface TranscriptionMessage {
	type: 'transcription-result';
	is_interim: boolean;
	participant: {
		id?: string;
	};
	transcript: Array<{
		text: string;
	}>;
	timestamp: number;
	language?: string;
}

/**
 * TranscriberContainer wraps the Node.js transcription server
 * and forwards WebSocket requests to it.
 */
export class TranscriberContainer extends Container<Env> {
	// Port that the Node.js server listens on
	defaultPort = 8080;

	// How long to keep container running after last activity
	// After this period: Container goes to sleep (CPU/memory released)
	// Note: Cloudflare automatically manages sleep/wake - you cannot "destroy" containers
	// Shorter = More aggressive resource cleanup, but more wake-ups
	// Longer = Fewer cold starts, but uses more resources when idle
	// For pool-based routing: Keep this longer (containers serve many sessions)
	// For session-based routing: Keep this shorter (containers are session-specific)
	sleepAfter = this.env.SLEEP_AFTER || '1m';

	// Pass environment variables to the container
	envVars: Record<string, string> = {
		// These will be available as process.env in the container
		OPENAI_API_KEY: this.env.OPENAI_API_KEY,
		OPENAI_MODEL: this.env.OPENAI_MODEL || 'gpt-4o-transcribe',
		GEMINI_API_KEY: this.env.GEMINI_API_KEY || '',
		DEEPGRAM_API_KEY: this.env.DEEPGRAM_API_KEY || '',
		DEEPGRAM_MODEL: this.env.DEEPGRAM_MODEL || 'nova-3-general',
		DEEPGRAM_DETECT_LANGUAGE: this.env.DEEPGRAM_DETECT_LANGUAGE || 'true',
		DEEPGRAM_INCLUDE_LANGUAGE: this.env.DEEPGRAM_INCLUDE_LANGUAGE || 'false',
		DEEPGRAM_PUNCTUATE: this.env.DEEPGRAM_PUNCTUATE || 'true',
		DEEPGRAM_ENCODING: this.env.DEEPGRAM_ENCODING || 'opus',
		PROVIDERS_PRIORITY: this.env.PROVIDERS_PRIORITY || 'openai',
		FORCE_COMMIT_TIMEOUT: this.env.FORCE_COMMIT_TIMEOUT || '2',
		DEBUG: this.env.DEBUG || 'true',
		ROUTING_MODE: this.env.ROUTING_MODE || 'session',
		CONTAINER_POOL_SIZE: this.env.CONTAINER_POOL_SIZE || '5',
		MAX_CONNECTIONS_PER_CONTAINER: this.env.MAX_CONNECTIONS_PER_CONTAINER || '10',
		MIN_CONTAINERS: this.env.MIN_CONTAINERS || '2',
		SCALE_DOWN_IDLE_TIME: this.env.SCALE_DOWN_IDLE_TIME || '600000',
		TRANSLATION_MIXING_MODE: this.env.TRANSLATION_MIXING_MODE || 'true',
		PORT: '8080',
		HOST: '0.0.0.0',
	};

	override onStart() {
		console.log('Transcriber container started');
	}

	override onStop() {
		console.log('Transcriber container stopped');
	}

	override onError(error: unknown) {
		// Properly serialize error for Cloudflare Workers logging
		if (error instanceof Error) {
			console.error('Transcriber container error:', error.message, error.stack);
		} else if (typeof error === 'string') {
			console.error('Transcriber container error:', error);
		} else {
			// For other types (Date, objects, etc.), stringify them
			console.error('Transcriber container error:', JSON.stringify(error));
		}
	}

	/**
	 * Keep the container alive by renewing the activity timeout.
	 * Call this periodically for long-lived WebSocket connections
	 * where messages bypass the Container class's fetch method.
	 */
	keepAlive() {
		this.renewActivityTimeout();
	}
}

/**
 * Choose which container instance to route this request to.
 * Multiple routing strategies are available depending on your use case.
 */
async function selectContainerInstance(request: Request, env: Env): Promise<string> {
	const url = new URL(request.url);
	const sessionId = url.searchParams.get('sessionId');
	const routingMode = env.ROUTING_MODE || 'session'; // 'pool', 'session', 'shared', or 'autoscale'

	switch (routingMode) {
		case 'autoscale':
			// Auto-scaling with coordinator: Automatically creates containers as needed
			// Use when: Variable traffic, want automatic scaling
			// Scaling: Dynamic based on load (coordinator manages)
			if (!sessionId) {
				throw new Error('sessionId required for autoscale mode');
			}
			const coordinator = env.CONTAINER_COORDINATOR.get(env.CONTAINER_COORDINATOR.idFromName('global'));
			const assignResponse = await coordinator.fetch(new URL('http://coordinator/assign'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId }),
			});
			const { containerId } = await assignResponse.json<{ containerId: string }>();
			return containerId;

		case 'session':
			// Session affinity: Each sessionId gets its own container
			// Use when: You need persistent state per session
			// Scaling: One container per unique session (can be expensive)
			return sessionId || 'default';

		case 'shared':
			// Single shared container for all sessions
			// Use when: Low traffic, simple setup, minimal cold starts
			// Scaling: Fixed at 1 container
			return 'shared';

		case 'pool':
		default:
			// Pool-based routing: Distribute across a pool of containers
			// Use when: Many short-lived sessions, no per-session state needed
			// Scaling: Fixed pool size, containers stay warm, good for high throughput
			const poolSize = parseInt(env.CONTAINER_POOL_SIZE || '5', 10);

			// Hash the sessionId for consistent routing (optional)
			// If you want true randomness, use: Math.floor(Math.random() * poolSize)
			if (sessionId) {
				// Consistent hashing: Same sessionId → Same container (within pool)
				let hash = 0;
				for (let i = 0; i < sessionId.length; i++) {
					hash = (hash << 5) - hash + sessionId.charCodeAt(i);
					hash = hash & hash; // Convert to 32bit integer
				}
				const poolIndex = Math.abs(hash) % poolSize;
				return `pool-${poolIndex}`;
			} else {
				// No sessionId: Random load balancing
				const poolIndex = Math.floor(Math.random() * poolSize);
				return `pool-${poolIndex}`;
			}
	}
}

/**
 * Handle WebSocket connection with dispatcher interception.
 * Creates a proxy between client and container, dispatching transcriptions asynchronously.
 */
async function handleWebSocketWithDispatcher(
	request: Request,
	container: ReturnType<typeof getContainer<TranscriberContainer>>,
	env: Env,
	ctx: ExecutionContext,
	sessionId: string,
): Promise<Response> {
	// Create WebSocket pair for the client
	const clientPair = new WebSocketPair();
	const [clientWs, serverWs] = Object.values(clientPair);

	// Accept the server side of the client connection
	serverWs.accept();

	// Forward the upgrade request to the container
	let containerResponse: Response;
	try {
		containerResponse = await container.fetch(request);
	} catch (error) {
		// Container connection failed - close client WebSocket with error
		const errorMsg = error instanceof Error ? error.message : 'Container connection failed';
		console.error(`Container fetch failed during WebSocket upgrade: ${errorMsg}`);
		serverWs.close(1011, `Container unreachable: ${errorMsg}`);
		return new Response('Service Unavailable: Container connection failed', {
			status: 503,
			statusText: 'Container Unreachable',
		});
	}

	if (containerResponse.status !== 101 || !containerResponse.webSocket) {
		// Container didn't upgrade - return error to client
		serverWs.close(1011, 'Container failed to upgrade WebSocket');
		return containerResponse;
	}

	const containerWs = containerResponse.webSocket;
	containerWs.accept();

	// Connect to Dispatcher DO via WebSocket (preferred - avoids subrequest limit)
	let dispatcherWs: WebSocket | null = null;
	if (env.DISPATCHER_DO) {
		try {
			const doId = env.DISPATCHER_DO.idFromName('global');
			const stub = env.DISPATCHER_DO.get(doId);

			const upgradeRequest = new Request('http://dispatcher/websocket', {
				headers: { 'Upgrade': 'websocket' },
			});
			const doResponse = await stub.fetch(upgradeRequest);

			if (doResponse.webSocket) {
				dispatcherWs = doResponse.webSocket;
				dispatcherWs.accept();
				console.log(`Connected to Dispatcher DO via WebSocket for session: ${sessionId}`);
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`Failed to connect to Dispatcher DO: ${msg}`);
		}
	}

	// Keep container alive by periodically renewing activity timeout
	// WebSocket messages bypass the Container class, so sleepAfter doesn't reset automatically
	const keepAliveInterval = setInterval(() => {
		container.keepAlive().catch((error) => {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`Container keepAlive failed: ${msg}, closing connections, sessionId=${sessionId}`);

			// Clean up interval to prevent further keepAlive attempts
			clearInterval(keepAliveInterval);

			// Close all WebSocket connections when container connection is lost
			if (serverWs.readyState === WebSocket.READY_STATE_OPEN || serverWs.readyState === WebSocket.READY_STATE_CONNECTING) {
				serverWs.close(1011, `Container connection lost: ${msg}`);
			}
			if (containerWs.readyState === WebSocket.READY_STATE_OPEN || containerWs.readyState === WebSocket.READY_STATE_CONNECTING) {
				containerWs.close(1011, 'Container keepAlive failed');
			}
			dispatcherWs?.close(1000, 'Container connection lost');
		});
	}, 10_000); // Every 10 seconds

	// Pipe: client → container (upstream, no interception needed)
	serverWs.addEventListener('message', (event) => {
		if (containerWs.readyState === WebSocket.READY_STATE_OPEN) {
			containerWs.send(event.data);
		}
	});

	// Pipe: container → client (downstream, intercept for dispatcher)
	containerWs.addEventListener('message', (event) => {
		// Forward to client immediately
		if (serverWs.readyState === WebSocket.READY_STATE_OPEN) {
			serverWs.send(event.data);
		}

		// Dispatch transcriptions via DO WebSocket
		if (dispatcherWs && dispatcherWs.readyState === WebSocket.READY_STATE_OPEN && typeof event.data === 'string') {
			try {
				const data = JSON.parse(event.data) as TranscriptionMessage;
				if (data.type === 'transcription-result' && !data.is_interim) {
					const dispatcherMessage: DispatcherTranscriptionMessage = {
						sessionId,
						endpointId: data.participant?.id || 'unknown',
						text: data.transcript.map((t) => t.text).join(' '),
						timestamp: data.timestamp,
						language: data.language,
					};
					dispatcherWs.send(JSON.stringify(dispatcherMessage));
				}
			} catch {
				// Not JSON or parse error - ignore, still forwarded to client
			}
		}
	});

	// Handle close events
	serverWs.addEventListener('close', (event) => {
		clearInterval(keepAliveInterval);
		console.log(`Client WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}`);
		if (containerWs.readyState === WebSocket.READY_STATE_OPEN || containerWs.readyState === WebSocket.READY_STATE_CONNECTING) {
			containerWs.close(event.code, event.reason);
		}
		dispatcherWs?.close(1000, 'Session ended');
	});

	containerWs.addEventListener('close', (event) => {
		clearInterval(keepAliveInterval);
		console.log(`Container WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}, sessionId=${sessionId}`);
		if (serverWs.readyState === WebSocket.READY_STATE_OPEN || serverWs.readyState === WebSocket.READY_STATE_CONNECTING) {
			serverWs.close(event.code, event.reason || 'Container connection closed');
		}
		dispatcherWs?.close(1000, 'Container disconnected');
	});

	// Handle errors - these fire when connection fails abnormally
	serverWs.addEventListener('error', (event) => {
		clearInterval(keepAliveInterval);
		console.error(`Client WebSocket error, closing both connections, sessionId=${sessionId}`);
		if (containerWs.readyState === WebSocket.READY_STATE_OPEN || containerWs.readyState === WebSocket.READY_STATE_CONNECTING) {
			containerWs.close(1011, 'Client WebSocket error');
		}
		if (serverWs.readyState === WebSocket.READY_STATE_OPEN) {
			serverWs.close(1011, 'Client WebSocket error');
		}
	});

	containerWs.addEventListener('error', (event) => {
		clearInterval(keepAliveInterval);
		console.error(`Container WebSocket error, closing client connection, sessionId=${sessionId}`);
		if (serverWs.readyState === WebSocket.READY_STATE_OPEN || serverWs.readyState === WebSocket.READY_STATE_CONNECTING) {
			serverWs.close(1011, 'Container connection error');
		}
		if (containerWs.readyState === WebSocket.READY_STATE_OPEN) {
			containerWs.close(1011, 'Container WebSocket error');
		}
	});

	// Return the client WebSocket
	return new Response(null, {
		status: 101,
		webSocket: clientWs,
	});
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Handle stats endpoint for monitoring
		if (url.pathname === '/stats' && request.method === 'GET') {
			if (env.ROUTING_MODE === 'autoscale') {
				const coordinator = env.CONTAINER_COORDINATOR.get(env.CONTAINER_COORDINATOR.idFromName('global'));
				return coordinator.fetch(new URL('http://coordinator/stats'));
			} else {
				return Response.json({
					error: 'Stats only available in autoscale mode',
					routingMode: env.ROUTING_MODE || 'session',
				});
			}
		}

		// Check query param first, fall back to env var
		const useDispatcherParam = url.searchParams.get('useDispatcher');
		const useDispatcher = useDispatcherParam !== null
			? useDispatcherParam === 'true'
			: env.USE_DISPATCHER === 'true';
		const sessionId = url.searchParams.get('sessionId') || 'unknown';

		// Select which container instance to use based on routing strategy
		const containerInstanceId = await selectContainerInstance(request, env);

		// Get the container instance
		const container = getContainer<TranscriberContainer>(env.TRANSCRIBER, containerInstanceId);

		// Start the container and wait for ports to be ready
		// This is required for the fetch to work properly
		try {
			await container.startAndWaitForPorts({
				cancellationOptions: {
					waitInterval: 100, // Poll every 100ms (default: 1000ms)
				},
			});
			console.log(`Container started and ready: ${containerInstanceId}`);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Container failed to start';
			const errorStack = error instanceof Error ? error.stack : undefined;
			console.error(`Container failed to start: ${errorMsg}${errorStack ? '\n' + errorStack : ''}`);
			return new Response(`Service Unavailable: Container failed to start (${errorMsg})`, {
				status: 503,
				statusText: 'Container Start Failed',
				headers: {
					'Content-Type': 'text/plain',
				},
			});
		}

		// Report connection tracking for autoscale mode
		const routingMode = env.ROUTING_MODE || 'session';
		const upgradeHeader = request.headers.get('Upgrade');
		if (routingMode === 'autoscale' && upgradeHeader === 'websocket') {
			const coordinator = env.CONTAINER_COORDINATOR.get(env.CONTAINER_COORDINATOR.idFromName('global'));

			// Report connection opened
			ctx.waitUntil(
				coordinator
					.fetch(new URL('http://coordinator/connection-opened'), {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ sessionId, containerId: containerInstanceId }),
					})
					.catch((error) => {
						const msg = error instanceof Error ? error.message : JSON.stringify(error);
						const stack = error instanceof Error ? error.stack : undefined;
						console.error(`Failed to report connection opened: ${msg}${stack ? '\n' + stack : ''}`);
					}),
			);
		}

		// If dispatcher is enabled and this is a WebSocket upgrade, intercept the connection
		if (useDispatcher && upgradeHeader === 'websocket' && env.DISPATCHER_DO) {
			return handleWebSocketWithDispatcher(request, container, env, ctx, sessionId);
		}

		// Forward request directly to container (pass-through mode)
		try {
			return await container.fetch(request);
		} catch (error) {
			// Container connection failed
			const errorMsg = error instanceof Error ? error.message : 'Container connection failed';
			const errorStack = error instanceof Error ? error.stack : undefined;
			console.error(`Container fetch failed: ${errorMsg}${errorStack ? '\n' + errorStack : ''}`);

			// Return appropriate error response
			const isWebSocket = upgradeHeader === 'websocket';
			return new Response(
				isWebSocket
					? `WebSocket Upgrade Failed: Container unreachable (${errorMsg})`
					: `Service Unavailable: Container connection failed (${errorMsg})`,
				{
					status: 503,
					statusText: 'Container Unreachable',
					headers: {
						'Content-Type': 'text/plain',
					},
				},
			);
		}

	},
} satisfies ExportedHandler<Env>;

// Export the ContainerCoordinator Durable Object for auto-scaling
export { ContainerCoordinator } from './ContainerCoordinator';
