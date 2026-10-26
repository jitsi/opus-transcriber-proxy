/*
 * Copyright @ 2025 - present 8x8, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getContainer } from '@cloudflare/containers';
import type { Env } from './env';
import { handleTranslate } from './handleTranslate';
import { TranscriberContainer } from './TranscriberContainer';
import { buildContainerEnvVars } from './containerEnv';
import { selectContainerInstance } from './routing';
import { handleWebSocketWithDispatcher } from './sessionProxy';
import { startContainer, startResult } from './startRetry';
import { containerStartPoints, pushCounters } from './metrics';

// wrangler resolves Durable Object classes from the entry module; the message types are
// re-exported so the entry module stays the Worker's public surface.
export { TranscriberContainer } from './TranscriberContainer';
// The SDK's outbound-interception entrypoint. Not used for interception here, but since 0.2 the
// Container constructor looks it up via `ctx.exports.ContainerProxy` whenever the Durable Object is
// rebuilt around an already-running container (a deploy, an isolate eviction) and logs an unhandled
// rejection if it is missing; exporting it keeps those rebuilds quiet. Needs `enable_ctx_exports`.
export { ContainerProxy } from '@cloudflare/containers';
export type { DispatcherTranscriptionMessage, TranscriptionDispatcher } from './types';
export { ContainerCoordinator } from './ContainerCoordinator';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Handle /translate entirely in this Worker (no container). The accepted WebSocket keeps the
		// Worker alive for the session; the bridge's pings keep it active. Transcribe stays on the
		// container path below (Worker outbound-connection limits — translate's fan-out is bounded).
		if (url.pathname.endsWith('/translate')) {
			// Same gate the container applies (ENABLE_TRANSLATE defaults to enabled): a disabled
			// deployment must not accept bridges and open paid OpenAI sessions.
			if (env.ENABLE_TRANSLATE === 'false') {
				return new Response('Translation endpoint disabled', { status: 404 });
			}
			return handleTranslate(request, env, ctx);
		}

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
		const sessionId = url.searchParams.get('sessionId') || crypto.randomUUID();

		// Select which container instance to use based on routing strategy
		const containerInstanceId = await selectContainerInstance(request, env);

		// Start the container and wait for ports to be ready. A start that fails for one of the
		// platform's transient reasons (the Durable Object briefly unreachable while Cloudflare
		// recovers; see startRetry.ts) is retried twice, through a fresh stub each time and with about
		// a second of waits in between, before the bridge is told to come back.
		const startedAt = Date.now();
		let attempts = 0;
		const colo = (request.cf as { colo?: string } | undefined)?.colo;
		const countStart = (error?: unknown) =>
			ctx.waitUntil(pushCounters(env, containerStartPoints(startResult(attempts, error), attempts, colo)));
		let container: DurableObjectStub<TranscriberContainer>;
		try {
			container = await startContainer(
				() => {
					attempts++;
					return getContainer<TranscriberContainer>(env.TRANSCRIBER, containerInstanceId);
				},
				(stub) =>
					stub.startAndWaitForPorts({
						// The class-level envVars already carry the instance name from ctx.id.name; passing
						// it explicitly with the name the Worker routed by keeps a request-driven start
						// independent of whether the Durable Object's id arrived with its name.
						startOptions: {
							envVars: { ...buildContainerEnvVars(env), CONTAINER_INSTANCE_NAME: containerInstanceId },
						},
						cancellationOptions: {
							waitInterval: 100, // Poll every 100ms (default: 1000ms)
						},
					}),
				{
					onRetry: (attempt, error, delayMs) => {
						const msg = error instanceof Error ? error.message : String(error);
						console.warn(`Container start attempt ${attempt} failed transiently, retrying in ${delayMs}ms: ${msg}, container=${containerInstanceId}`);
					},
				},
			);
			console.log(`Container started and ready: ${containerInstanceId} after ${attempts} attempt(s) in ${Date.now() - startedAt}ms`);
			countStart();
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Container failed to start';
			const errorStack = error instanceof Error ? error.stack : undefined;
			console.error(`Container failed to start after ${attempts} attempt(s) in ${Date.now() - startedAt}ms: ${errorMsg}, container=${containerInstanceId}${errorStack ? '\n' + errorStack : ''}`);
			countStart(error);
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
		// Header values are case-insensitive (RFC 6455 clients send both `websocket` and `WebSocket`);
		// the same normalised test is used by TranscriberContainer.fetch, so both layers agree.
		const isWebSocketUpgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
		if (routingMode === 'autoscale' && isWebSocketUpgrade) {
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
		if (useDispatcher && isWebSocketUpgrade && env.DISPATCHER_DO) {
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
			return new Response(
				isWebSocketUpgrade
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
