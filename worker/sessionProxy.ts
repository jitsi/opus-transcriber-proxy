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

import type { Env } from './env';
import type { TranscriberContainer } from './TranscriberContainer';
import type { DispatcherTranscriptionMessage, TranscriptionMessage } from './types';
import { buildWorkerInfo } from './containerEnv';
import type { AppliedOverrides } from './providerOverride';
import { closeReason } from '../src/agent/closeReason';
import { DISPATCHER_QUEUE_LIMIT } from './dispatcherForwarder';
import { containerFailureReason, containerUnreachablePoints, countLater, requestColo } from './metrics';
import { sendableCloseCode } from './closeCode';

export { sendableCloseCode };

const OPEN_OR_CLOSING = (ws: WebSocket) =>
	ws.readyState === WebSocket.READY_STATE_OPEN || ws.readyState === WebSocket.READY_STATE_CLOSING;

/**
 * Handle WebSocket connection with dispatcher interception.
 * Creates a proxy between client and container, dispatching transcriptions asynchronously.
 */
export async function handleWebSocketWithDispatcher(
	request: Request,
	container: DurableObjectStub<TranscriberContainer>,
	env: Env,
	ctx: ExecutionContext,
	sessionId: string,
	overrides?: AppliedOverrides,
): Promise<Response> {
	// Create WebSocket pair for the client
	const clientPair = new WebSocketPair();
	const [clientWs, serverWs] = Object.values(clientPair);

	// Accept the server side of the client connection
	serverWs.accept();

	// Forward the upgrade request to the container
	const colo = requestColo(request);
	let containerResponse: Response;
	try {
		containerResponse = await container.fetch(request);
	} catch (error) {
		// Container connection failed - close client WebSocket with error
		const errorMsg = error instanceof Error ? error.message : 'Container connection failed';
		console.error(`Container fetch failed during WebSocket upgrade: ${errorMsg}`);
		countLater(ctx, env, () => containerUnreachablePoints('dispatcher', 'stub_failed', colo));
		serverWs.close(1011, closeReason(`Container unreachable: ${errorMsg}`));
		return new Response('Service Unavailable: Container connection failed', {
			status: 503,
			statusText: 'Container Unreachable',
		});
	}

	if (containerResponse.status !== 101 || !containerResponse.webSocket) {
		// Container didn't upgrade - return error to client
		const failure = containerFailureReason(containerResponse);
		if (failure) countLater(ctx, env, () => containerUnreachablePoints('dispatcher', failure, colo));
		serverWs.close(1011, 'Container failed to upgrade WebSocket');
		return containerResponse;
	}

	const containerWs = containerResponse.webSocket;
	containerWs.accept();

	// Dispatcher state and helpers. Declared before the container message listener below: that
	// listener runs as soon as the container's first message arrives, which can be before the
	// Dispatcher DO connect has resolved, so everything it references must already exist.
	let dispatcherWs: WebSocket | null = null;
	// Queue for messages while dispatcher is disconnected or reconnecting
	const messageQueue: DispatcherTranscriptionMessage[] = [];
	let reconnectAttempts = 0;
	let isReconnecting = false;
	// The backoff timer before a reconnect dial, cleared when the session ends.
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	// Whichever dispatcher dial is in flight (the initial connect or a reconnect), so a queued final
	// does not start another one and a flush-on-close waits for it instead of dialling a second socket.
	let pendingConnect: Promise<WebSocket | null> | null = null;
	let sessionClosed = false;
	// Set once we have sent the dispatcher socket a close, so its close event can be told apart
	// from the dispatcher closing on us.
	let dispatcherCloseSent = false;
	let queueOverflowLogged = false;

	// Function to connect/reconnect to dispatcher DO
	async function connectToDispatcher(allowDuringClose = false): Promise<WebSocket | null> {
		if (!env.DISPATCHER_DO || (sessionClosed && !allowDuringClose)) return null;

		try {
			const doId = env.DISPATCHER_DO.idFromName(sessionId);
			const stub = env.DISPATCHER_DO.get(doId);

			const upgradeRequest = new Request('http://dispatcher/websocket', {
				headers: { 'Upgrade': 'websocket' },
			});
			const doResponse = await stub.fetch(upgradeRequest);

			if (doResponse.webSocket) {
				doResponse.webSocket.accept();
				console.log(`Connected to Dispatcher DO via WebSocket for session: ${sessionId}`);
				reconnectAttempts = 0;
				return doResponse.webSocket;
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`Failed to connect to Dispatcher DO: ${msg}, sessionId=${sessionId}`);
		}
		return null;
	}

	// Function to flush queued messages
	function flushMessageQueue() {
		if (messageQueue.length > 0 && dispatcherWs?.readyState === WebSocket.READY_STATE_OPEN) {
			console.log(`Flushing ${messageQueue.length} queued messages to dispatcher, sessionId=${sessionId}`);
			while (messageQueue.length > 0) {
				const msg = messageQueue.shift()!;
				dispatcherWs.send(JSON.stringify(msg));
			}
		}
	}

	// Function to schedule reconnection with exponential backoff
	function scheduleReconnect() {
		if (isReconnecting || sessionClosed) return;
		isReconnecting = true;

		const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
		reconnectAttempts++;

		console.log(`Scheduling dispatcher reconnect in ${delay}ms (attempt ${reconnectAttempts}), sessionId=${sessionId}, queued=${messageQueue.length}`);

		reconnectTimer = setTimeout(async () => {
			reconnectTimer = null;
			if (sessionClosed) {
				isReconnecting = false;
				return;
			}
			// Stays set across the await so a final arriving meanwhile does not open a second socket.
			pendingConnect = connectToDispatcher();
			const newWs = await pendingConnect;
			pendingConnect = null;
			isReconnecting = false;
			if (sessionClosed) {
				// The session ended during the connect: use the socket for what is still queued, then
				// close it rather than leave it open until the Worker is torn down.
				if (newWs) {
					dispatcherWs = newWs;
					flushMessageQueue();
					newWs.close(1000, 'Session ended');
				}
				return;
			}
			if (newWs) {
				dispatcherWs = newWs;
				setupDispatcherHandlers();
				flushMessageQueue();
			} else {
				scheduleReconnect();
			}
		}, delay);
	}

	// Setup close/error handlers for dispatcher WebSocket
	function setupDispatcherHandlers() {
		const ws = dispatcherWs;
		if (!ws) return;

		ws.addEventListener('close', (event) => {
			// A 1000 after we sent our close is the Dispatcher DO's reply: the handshake completing as
			// it should, not a failure. Anything else is one: mid-session the dispatcher dropping us
			// (1006 and the like), which the reconnect below has to recover from, and after our close
			// a DO that vanished instead of replying.
			const healthy = dispatcherCloseSent && event.code === 1000;
			(healthy ? console.log : console.error)(`Dispatcher WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}, sessionId=${sessionId}`);
			// Complete the close handshake, as for the client and container sockets: with no automatic
			// reply on our compatibility date the socket would otherwise sit CLOSING until it times out.
			if (ws.readyState === WebSocket.READY_STATE_CLOSING) {
				try {
					ws.close(sendableCloseCode(event.code, 1000), closeReason(event.reason));
				} catch {
					// Already closed by the time we got here; nothing to complete.
				}
			}
			// A socket that has already been replaced (a late close from one that errored earlier) must
			// not start another reconnect and orphan the live one.
			if (!sessionClosed && ws === dispatcherWs) {
				scheduleReconnect();
			}
		});

		// An error leaves the socket CLOSED, so it is deliberately not reconnected here: the next final
		// finds it not OPEN, queues itself and schedules the reconnect, and a session that ends with
		// finals still queued reconnects once in flushBeforeClose. Reconnecting eagerly would dial for
		// sessions that may never produce another final.
		ws.addEventListener('error', () => {
			console.error(`Dispatcher WebSocket error, sessionId=${sessionId}`);
		});
	}

	// Flush remaining messages before closing session
	async function flushBeforeClose(): Promise<void> {
		if (messageQueue.length === 0) return;

		console.log(`Flushing ${messageQueue.length} queued messages before session close, sessionId=${sessionId}`);

		// If the session ended while a dial (the initial connect or a reconnect) was in flight, let it
		// finish and flush (it does both when it finds the session closed) rather than dial again.
		if (pendingConnect) {
			await pendingConnect;
			if (messageQueue.length === 0) return;
		}

		// Try to reconnect if not connected (allow during close)
		if (!dispatcherWs || dispatcherWs.readyState !== WebSocket.READY_STATE_OPEN) {
			const newWs = await connectToDispatcher(true);
			if (newWs) {
				dispatcherWs = newWs;
			}
		}

		// Flush if connected, then close: the session is over and nothing else will close a socket
		// opened by the reconnect above (the close handler's own close ran before that await).
		if (dispatcherWs?.readyState === WebSocket.READY_STATE_OPEN) {
			while (messageQueue.length > 0) {
				const msg = messageQueue.shift()!;
				dispatcherWs.send(JSON.stringify(msg));
			}
			console.log(`Successfully flushed all queued messages, sessionId=${sessionId}`);
			dispatcherCloseSent = true;
			dispatcherWs.close(1000, 'Session ended');
		} else {
			console.error(`Failed to flush ${messageQueue.length} queued messages - dispatcher not connected, sessionId=${sessionId}`);
		}
	}

	// Pipe: container → client (downstream, intercept for dispatcher). Attached immediately after
	// accept() and before any `await` below (e.g. the Dispatcher DO connect) -- the container sends
	// its `info` message the instant it accepts the connection, and a message that arrives with no
	// listener registered yet is silently dropped (standard EventTarget semantics), not queued.
	containerWs.addEventListener('message', (event) => {
		// Parse text frames once; the info check and the dispatch check below share the result.
		let parsed: Record<string, unknown> | null = null;
		if (typeof event.data === 'string') {
			try {
				const p = JSON.parse(event.data);
				if (p && typeof p === 'object') parsed = p;
			} catch {
				parsed = null;
			}
		}

		// The container's `info` message: augment in-place with a `worker` block (edge/deployment
		// details) and forward the combined message, so the client sees the whole path in one message.
		if (parsed && parsed.event === 'info') {
			parsed.worker = buildWorkerInfo(request, env, overrides);
			if (serverWs.readyState === WebSocket.READY_STATE_OPEN) {
				serverWs.send(JSON.stringify(parsed));
			}
			return;
		}

		// Forward to client immediately
		if (serverWs.readyState === WebSocket.READY_STATE_OPEN) {
			serverWs.send(event.data);
		}

		// Dispatch transcriptions via DO WebSocket. Forward both normal transcriptions and /translate
		// transcripts (realtime-translation-result), finals only. `media` (audio) and other events have
		// no matching `type` and are skipped.
		if (parsed && (parsed.type === 'transcription-result' || parsed.type === 'realtime-translation-result') && !parsed.is_interim) {
			try {
				const data = parsed as unknown as TranscriptionMessage;
				const dispatcherMessage: DispatcherTranscriptionMessage = {
					sessionId,
					endpointId: data.participant?.id || 'unknown',
					text: data.transcript.map((t) => t.text).join(' '),
					timestamp: data.timestamp,
					language: data.language,
				};

				if (dispatcherWs?.readyState === WebSocket.READY_STATE_OPEN) {
					dispatcherWs.send(JSON.stringify(dispatcherMessage));
				} else if (env.DISPATCHER_DO) {
					// Queue message while disconnected, bounded like the /translate forwarder's queue so
					// a long outage of the session's Dispatcher DO cannot grow it without limit.
					messageQueue.push(dispatcherMessage);
					if (messageQueue.length > DISPATCHER_QUEUE_LIMIT) {
						messageQueue.shift();
						if (!queueOverflowLogged) {
							queueOverflowLogged = true;
							console.warn(`Dispatcher queue full (${DISPATCHER_QUEUE_LIMIT}), dropping oldest, sessionId=${sessionId}`);
						}
					}
					if (messageQueue.length === 1) {
						console.log(`Dispatcher not connected, queueing messages, sessionId=${sessionId}`);
					}
					if (!isReconnecting && !pendingConnect) {
						scheduleReconnect();
					}
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				console.error(`Failed to parse/dispatch transcription: ${msg}, sessionId=${sessionId}`);
			}
		}
	});

	// Keep the container alive for the life of the call by renewing its activity timeout.
	// WebSocket audio frames bypass the SDK's activity tracking (TranscriberContainer.fetch
	// passes upgrades straight through), so sleepAfter does NOT reset on its own — without
	// this the container sleeps (SIGTERM) ~sleepAfter after start, mid-call.
	// renewActivityTimeout() is the real Container method (there is no keepAlive()); each
	// call is one Worker subrequest, so we renew infrequently (every 3m) to stay well under
	// the 1000-subrequest-per-invocation limit on long sessions. The interval must stay
	// below `sleepAfter` (7m) with margin for a missed renewal.
	const keepAliveInterval = setInterval(() => {
		container.renewActivityTimeout().catch((error) => {
			const msg = error instanceof Error ? error.message : String(error);
			// A renewal failure is a control-plane RPC hiccup, NOT proof the call is dead —
			// the audio WS pipe is independent. Log and let the next tick retry; sleepAfter
			// (7m) leaves margin for a missed 3m renewal. Genuine container death is detected
			// and torn down by the containerWs close/error handlers below (which the client
			// then reconnects from) — don't duplicate that here, since closing on a transient
			// blip would force an unnecessary reconnect and drop the in-flight utterance.
			console.error(`Container renewActivityTimeout failed (will retry next tick): ${msg}, sessionId=${sessionId}`);
		});
	}, 180_000); // Every 3 minutes (subrequest-light; must stay < sleepAfter)


	// Pipe: client → container (upstream, no interception needed)
	serverWs.addEventListener('message', (event) => {
		if (containerWs.readyState === WebSocket.READY_STATE_OPEN) {
			containerWs.send(event.data);
		}
	});

	/**
	 * End the session from whichever side went away first; the other three events that follow
	 * (the peer's close reply, the dispatcher's close) find it already torn down. One path for all
	 * four close/error handlers so they cannot drift:
	 * - marks the session closed, so the dispatcher socket's own close event does not reconnect;
	 * - stops the keepalive renewals;
	 * - replies to the socket that closed. workerd does not answer a received close frame on our
	 *   compatibility date (`web_socket_auto_reply_to_close` is off), so without this the peer
	 *   waits out its close timeout and records an abnormal close. A socket that *errored* is
	 *   already closed and gets nothing;
	 * - closes the other side with a code workerd can send (see `sendableCloseCode`);
	 * - delivers what is still queued for the dispatcher (reconnecting if needed) and closes it.
	 */
	let tornDown = false;
	// Each close is attempted independently: this is the only teardown path, so one close() that
	// throws (a state or value workerd rejects that the checks above did not foresee) must not leave
	// the other socket open or the queued finals undelivered.
	function safeClose(ws: WebSocket, code: number, reason: string, which: string) {
		try {
			ws.close(code, closeReason(reason));
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`Closing the ${which} WebSocket failed (code=${code}): ${msg}, sessionId=${sessionId}`);
		}
	}
	function endSession(from: 'client' | 'container', code: number, reason: string, errored = false) {
		if (tornDown) return;
		tornDown = true;
		sessionClosed = true;
		clearInterval(keepAliveInterval);
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
			isReconnecting = false;
		}

		const [closedWs, otherWs] = from === 'client' ? [serverWs, containerWs] : [containerWs, serverWs];
		const other = from === 'client' ? 'container' : 'client';
		// Reasons are capped at 123 UTF-8 bytes (RFC 6455) inside safeClose; a longer one would throw.
		if (!errored && OPEN_OR_CLOSING(closedWs)) {
			safeClose(closedWs, sendableCloseCode(code, 1000), reason, from);
		}
		if (OPEN_OR_CLOSING(otherWs)) {
			if (errored) {
				safeClose(otherWs, 1011, reason, other);
			} else if (from === 'container') {
				safeClose(otherWs, sendableCloseCode(code, 1011), reason || 'Container connection closed', other);
			} else {
				safeClose(otherWs, sendableCloseCode(code, 1000), reason, other);
			}
		}

		if (messageQueue.length > 0) {
			// Finals still waiting for the dispatcher: deliver them in the background (this also closes
			// the socket it flushes through).
			ctx.waitUntil(flushBeforeClose());
		} else if (dispatcherWs?.readyState === WebSocket.READY_STATE_OPEN) {
			dispatcherCloseSent = true;
			safeClose(dispatcherWs, 1000, from === 'client' ? 'Session ended' : 'Container disconnected', 'dispatcher');
		}
	}

	serverWs.addEventListener('close', (event) => {
		console.log(`Client WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}, sessionId=${sessionId}`);
		endSession('client', event.code, event.reason);
	});

	containerWs.addEventListener('close', (event) => {
		console.log(`Container WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}, sessionId=${sessionId}`);
		endSession('container', event.code, event.reason);
	});

	// Errors fire when a connection fails abnormally; the socket is already closed afterwards.
	serverWs.addEventListener('error', () => {
		console.error(`Client WebSocket error, closing both connections, sessionId=${sessionId}`);
		endSession('client', 1011, 'Client WebSocket error', true);
	});

	containerWs.addEventListener('error', () => {
		console.error(`Container WebSocket error, closing client connection, sessionId=${sessionId}`);
		endSession('container', 1011, 'Container connection error', true);
	});

	// Connect to Dispatcher DO via WebSocket (preferred - avoids subrequest limit). Each session
	// gets its own DO instance for isolation. This is the only await after the container socket is
	// live, and every listener above is already attached, so whatever the container or the client
	// does meanwhile is handled: a final is queued and flushed below, and a close or error marks the
	// session closed, in which case the socket that resolves here is closed again right away rather
	// than left open until the Worker is torn down.
	pendingConnect = connectToDispatcher(true);
	dispatcherWs = await pendingConnect;
	pendingConnect = null;
	if (sessionClosed) {
		flushMessageQueue();
		if (dispatcherWs?.readyState === WebSocket.READY_STATE_OPEN) {
			dispatcherWs.close(1000, 'Session ended');
		}
	} else if (dispatcherWs) {
		setupDispatcherHandlers();
		flushMessageQueue();
	} else if (messageQueue.length > 0) {
		// The first connect failed with finals already waiting: retry on the usual backoff instead
		// of holding them until the next final or the session close.
		scheduleReconnect();
	}

	// Return the client WebSocket
	return new Response(null, {
		status: 101,
		webSocket: clientWs,
	});
}
