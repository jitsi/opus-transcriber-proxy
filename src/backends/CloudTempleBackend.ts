/**
 * CloudTemple LLMaaS realtime backend for transcription
 *
 * Uses CloudTemple's /v1/realtime WebSocket (Voxtral model) for streaming
 * transcription. Despite living under the same "Realtime" umbrella as
 * OpenAI's Realtime API, CloudTemple's actual wire protocol is its own,
 * smaller thing — confirmed against CloudTemple's own public reference
 * client (github.com/Cloud-Temple/product-llmaas-how-to, simple_voxtral/):
 *
 *  - Auth is a plain `Authorization: Bearer <key>` header, not the
 *    `openai-insecure-api-key.<key>` WS subprotocol OpenAI's backend uses —
 *    the global WebSocket (undici) can't set headers, so this backend uses
 *    the `ws` npm package directly (see XAIBackend.ts for the same pattern).
 *  - `session.update` is flat: `{ type: 'session.update', model }` — no
 *    nested `session` object.
 *  - Events are `transcription.delta` (incremental text in `delta`, often
 *    empty — a heartbeat, not an error) and `transcription.done` (carries a
 *    `usage` object, NOT the transcript text — the full text has to be
 *    reassembled client-side from the deltas).
 *  - Finalization is explicit: the closing `input_audio_buffer.commit` must
 *    carry `final: true`, or no `transcription.done` ever arrives.
 *  - Critically, a connection only ever finalizes ONCE: after
 *    `transcription.done`, CloudTemple stops responding to further audio on
 *    that socket (verified empirically — a second utterance sent on the
 *    same connection produced no further deltas or events at all). So unlike
 *    every other backend here (one persistent connection per participant for
 *    the whole call), this backend opens a FRESH connection per utterance:
 *    `forceCommit()` finalizes and retires the current socket, and the next
 *    `sendAudio()` call lazily opens a new one. `OutgoingConnection` already
 *    calls `forceCommit()` on ~2s of audio silence (`FORCE_COMMIT_TIMEOUT`),
 *    which lines up with natural inter-utterance pauses in conversation —
 *    there is no server-side VAD/turn_detection on CloudTemple's side to
 *    rely on instead.
 */

import WsWebSocket from 'ws';
import type { IncomingMessage } from 'node:http';

import { config } from '../config';
import { writeMetric } from '../metrics';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig, AudioFormat } from './TranscriptionBackend';
import type { TranscriptionMessage } from '../transcriberproxy';

const CLOUDTEMPLE_WS_URL = 'wss://api.ai.cloud-temple.com/v1/realtime';

export class CloudTempleBackend implements TranscriptionBackend {
	private ws?: WsWebSocket;
	private connectingPromise?: Promise<void>;
	private status: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private backendConfig?: BackendConfig;
	private participantInfo: any;
	private tag: string;
	private wsUrl: string;
	private apiKey: string;
	// Monotonic per-backend counter for turn message_ids — Date.now() alone can collide
	// for two turns opened back-to-back within the same millisecond.
	private turnCounter = 0;

	private nextTurnId(): string {
		this.turnCounter += 1;
		return `ct-${this.tag}-${this.turnCounter}`;
	}

	onInterimTranscription?: (message: TranscriptionMessage) => void;
	onCompleteTranscription?: (message: TranscriptionMessage, midUtterance?: boolean) => void;
	onError?: (errorType: string, errorMessage: string, recoverable?: boolean) => void;
	onClosed?: () => void;

	constructor(tag: string, participantInfo: any) {
		this.tag = tag;
		this.participantInfo = participantInfo;
		this.wsUrl = config.cloudtemple.wsUrl || CLOUDTEMPLE_WS_URL;
		this.apiKey = config.cloudtemple.apiKey;
	}

	async connect(backendConfig: BackendConfig): Promise<void> {
		this.backendConfig = backendConfig;
		await this.ensureSocket();
	}

	async sendAudio(audioBase64: string): Promise<void> {
		await this.ensureSocket();
		if (!this.ws || this.status !== 'connected') {
			throw new Error(`Cannot send audio: connection not ready (status: ${this.status})`);
		}
		this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audioBase64 }));
	}

	forceCommit(): void {
		if (!this.ws || this.status !== 'connected') {
			return;
		}
		logger.debug(`Forcing final commit for tag ${this.tag} (end of utterance)`);
		this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit', final: true }));
	}

	updatePrompt(_prompt: string): void {
		// CloudTemple's session.update has no documented prompt/context field — no-op.
	}

	close(): void {
		logger.debug(`Closing CloudTemple backend for tag: ${this.tag}`);
		this.ws?.close();
		this.ws = undefined;
		this.status = 'closed';
	}

	getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
		return this.status;
	}

	getDesiredAudioFormat(_inputFormat: AudioFormat): AudioFormat {
		// Matches CloudTemple's own reference client's conversion (16kHz mono PCM16).
		return { encoding: 'l16', sampleRate: 16000 };
	}

	/** Resolves once a connected socket is ready to receive audio, opening one if needed. */
	private async ensureSocket(): Promise<void> {
		if (this.ws && this.status === 'connected') {
			return;
		}
		if (this.status === 'closed') {
			throw new Error(`Cannot reconnect CloudTemple backend for tag ${this.tag}: backend closed`);
		}
		if (!this.connectingPromise) {
			this.connectingPromise = this.openSocket().finally(() => {
				this.connectingPromise = undefined;
			});
		}
		return this.connectingPromise;
	}

	/** Opens one CloudTemple realtime connection good for exactly one finalized utterance. */
	private openSocket(): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let turnBuffer = '';
			let messageId = this.nextTurnId();
			// Set once this socket has delivered transcription.done (or close()/a newer
			// socket superseded it). A retired socket's own teardown (error/close events
			// from its own ws.close()) must not affect backend-wide status — a fresh
			// socket may already be connecting for the next utterance by then.
			let retired = false;

			let ws: WsWebSocket;
			try {
				ws = new WsWebSocket(this.wsUrl, { headers: { Authorization: `Bearer ${this.apiKey}` } });
			} catch (error) {
				logger.error(`Failed to create CloudTemple WebSocket connection for tag ${this.tag}:`, error);
				this.status = 'failed';
				reject(error);
				return;
			}

			logger.info(`Opening CloudTemple WebSocket to ${new URL(this.wsUrl).hostname} for tag: ${this.tag}`);

			ws.addEventListener('open', () => {
				const model = this.backendConfig?.model || config.cloudtemple.model;
				ws.send(JSON.stringify({ type: 'session.update', model }));
				// CloudTemple's own reference client sends an empty (non-final) commit
				// right after session.update, before any audio — mirrored here even
				// though its purpose (reset? no-op?) isn't documented.
				ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
			});

			ws.addEventListener('message', (event) => {
				const data = event.data;
				let parsedMessage;
				try {
					parsedMessage = JSON.parse(data.toString());
				} catch (parseError) {
					logger.error(`Failed to parse CloudTemple message as JSON for tag ${this.tag}:`, parseError);
					return;
				}

				if (parsedMessage.type === 'session.created') {
					logger.debug(`CloudTemple session created for tag ${this.tag}: ${parsedMessage.id}`);
					if (this.ws && this.ws !== ws) {
						// Superseded by a newer socket before this one ever got used — shouldn't
						// normally happen (ensureSocket() de-dupes concurrent opens), but close
						// it defensively without letting its teardown affect backend status.
						const stale = this.ws;
						try {
							stale.close();
						} catch {
							// already dead — nothing to clean up
						}
					}
					this.ws = ws;
					this.status = 'connected';
					if (!settled) {
						settled = true;
						resolve();
					}
				} else if (parsedMessage.type === 'transcription.delta') {
					const delta = parsedMessage.delta;
					if (delta) {
						turnBuffer += delta;
						this.onInterimTranscription?.(this.createTranscriptionMessage(delta, Date.now(), messageId, true));
					}
				} else if (parsedMessage.type === 'transcription.done') {
					const now = Date.now();
					const transcript = turnBuffer;
					turnBuffer = '';
					if (transcript) {
						this.onCompleteTranscription?.(this.createTranscriptionMessage(transcript, now, messageId, false));
					}
					messageId = this.nextTurnId();
					// This connection is spent — CloudTemple does not accept further
					// audio on it. Retire it; the next sendAudio() lazily reopens one.
					retired = true;
					if (this.ws === ws) {
						this.ws = undefined;
						this.status = 'pending';
					}
					try {
						ws.close();
					} catch {
						// already closing — fine
					}
				} else if (parsedMessage.type === 'error') {
					logger.error(`CloudTemple sent error message for ${this.tag}: ${data}`);
					writeMetric(undefined, {
						name: 'cloudtemple_api_error',
						worker: 'opus-transcriber-proxy',
						errorType: 'api_error',
					});
					this.onError?.('api_error', typeof parsedMessage.error === 'string' ? parsedMessage.error : JSON.stringify(parsedMessage.error));
					if (!settled) {
						settled = true;
						reject(new Error(typeof parsedMessage.error === 'string' ? parsedMessage.error : 'CloudTemple error'));
					}
				} else {
					logger.warn(`Unhandled CloudTemple message type for ${this.tag}: ${parsedMessage.type}`);
				}
			});

			ws.on('unexpected-response', (_req, res: IncomingMessage) => {
				let body = '';
				res.on('data', (chunk) => {
					body += chunk;
				});
				res.on('end', () => {
					const message = `CloudTemple handshake rejected for tag ${this.tag}: ${res.statusCode} ${body}`;
					logger.error(message);
					this.status = 'failed';
					writeMetric(undefined, {
						name: 'cloudtemple_api_error',
						worker: 'opus-transcriber-proxy',
						errorType: 'connection_failed',
					});
					if (!settled) {
						settled = true;
						reject(new Error(message));
					}
				});
			});

			ws.addEventListener('error', (event) => {
				const errorMessage = (event as { message?: string })?.message || 'WebSocket error';
				if (retired) {
					// Teardown noise from a socket we already finalized and closed ourselves —
					// a fresh socket may already be connecting for the next utterance.
					logger.debug(`Late error on retired CloudTemple socket for tag ${this.tag}: ${errorMessage}`);
					return;
				}
				logger.error(`CloudTemple WebSocket error for tag ${this.tag}: ${errorMessage}`);
				writeMetric(undefined, {
					name: 'cloudtemple_api_error',
					worker: 'opus-transcriber-proxy',
					errorType: 'websocket_error',
				});
				this.onError?.('websocket_error', errorMessage);
				this.status = 'failed';
				if (!settled) {
					settled = true;
					reject(new Error(errorMessage));
				}
			});

			ws.addEventListener('close', (event) => {
				if (retired) {
					logger.debug(`Retired CloudTemple socket closed for tag ${this.tag}: code=${event.code}`);
					return;
				}
				logger.info(`CloudTemple WebSocket closed for tag ${this.tag}: code=${event.code} reason=${event.reason || 'none'}`);
				if (this.ws === ws) {
					this.ws = undefined;
					// Only a genuinely fatal close (one that never finalized a turn and
					// wasn't us retiring a spent connection) should fail the backend.
					if (this.status !== 'closed') {
						this.status = 'failed';
						this.onClosed?.();
					}
				}
				if (!settled) {
					settled = true;
					reject(new Error(`CloudTemple WebSocket closed before session.created: code=${event.code}`));
				}
			});
		});
	}

	private createTranscriptionMessage(transcript: string, timestamp: number, message_id: string, isInterim: boolean): TranscriptionMessage {
		return {
			transcript: [{ text: transcript }],
			is_interim: isInterim,
			message_id,
			type: 'transcription-result',
			event: 'transcription-result',
			participant: this.participantInfo,
			timestamp,
		};
	}
}
