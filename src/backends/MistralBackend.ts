/**
 * Mistral Voxtral realtime backend for transcription
 *
 * Uses Mistral's WebSocket realtime transcription API. Audio is sent as 16 kHz PCM
 * and the server streams text deltas, which are emitted as interim transcriptions.
 * forceCommit() sends input_audio.flush, which makes Mistral finish the pending text
 * and answer with transcription.done. The session stays open.
 */

import { randomUUID } from 'crypto';
import WsWebSocket from 'ws';
import { config } from '../config';
import { writeMetric } from '../metrics';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig, AudioFormat } from './TranscriptionBackend';
import type { TranscriptionMessage } from '../transcriberproxy';

const MISTRAL_WS_URL = 'wss://api.mistral.ai/v1/audio/transcriptions/realtime';
const MISTRAL_SAMPLE_RATE = 16000;

// Mistral closes a session that has had unflushed audio but no new audio for ~30s.
const MISTRAL_TIMEOUT_ERROR_CODE = 3804;

export class MistralBackend implements TranscriptionBackend {
	private ws?: WsWebSocket;
	private status: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private backendConfig?: BackendConfig;
	private participantInfo: any;
	private tag: string;
	// Text received so far, and the message id it is reported under.
	private pendingText = '';
	private messageId = randomUUID();

	onInterimTranscription?: (message: TranscriptionMessage) => void;
	onCompleteTranscription?: (message: TranscriptionMessage, midUtterance?: boolean) => void;
	onError?: (errorType: string, errorMessage: string, recoverable?: boolean) => void;
	onClosed?: () => void;

	constructor(tag: string, participantInfo: any) {
		this.tag = tag;
		this.participantInfo = participantInfo;
	}

	async connect(backendConfig: BackendConfig): Promise<void> {
		this.backendConfig = backendConfig;

		return new Promise((resolve, reject) => {
			try {
				const model = backendConfig.model || config.mistral.model;
				const url = `${MISTRAL_WS_URL}?model=${encodeURIComponent(model)}`;

				// Use the `ws` npm package so we can pass Authorization header.
				// The global WebSocket (undici) does not support custom headers.
				const ws = new WsWebSocket(url, {
					headers: { Authorization: `Bearer ${config.mistral.apiKey}` },
				});

				logger.info(`Opening Mistral WebSocket for tag ${this.tag}: ${url}`);

				this.ws = ws;

				ws.addEventListener('open', () => {
					logger.info(`Mistral WebSocket connected for tag: ${this.tag}`);
					this.status = 'connected';

					// Send session configuration before any audio
					this.sendSessionUpdate();

					resolve();
				});

				ws.addEventListener('message', (event) => {
					this.handleMessage(event.data);
				});

				ws.addEventListener('error', (event) => {
					const errorMessage = (event as { message?: string })?.message || 'WebSocket error';
					logger.error(`Mistral WebSocket error for tag ${this.tag}: ${errorMessage}`);
					writeMetric(undefined, {
						name: 'mistral_api_error',
						worker: 'opus-transcriber-proxy',
						errorType: 'websocket_error',
					});
					this.onError?.('websocket_error', 'WebSocket connection error');
					this.status = 'failed';
					this.close();
					reject(new Error(`WebSocket error: ${errorMessage}`));
				});

				ws.addEventListener('close', (event) => {
					logger.info(
						`Mistral WebSocket closed for tag ${this.tag}: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`,
					);
					this.status = 'failed';
					this.close();
					// Notify OutgoingConnection that the backend has closed
					this.onClosed?.();
				});
			} catch (error) {
				logger.error(`Failed to create Mistral WebSocket connection for tag ${this.tag}:`, error);
				writeMetric(undefined, {
					name: 'mistral_api_error',
					worker: 'opus-transcriber-proxy',
					errorType: 'connection_failed',
				});
				this.onError?.('connection_failed', error instanceof Error ? error.message : 'Unknown error');
				this.status = 'failed';
				reject(error);
			}
		});
	}

	async sendAudio(audioBase64: string): Promise<void> {
		if (!this.ws || this.status !== 'connected') {
			throw new Error(`Cannot send audio: connection not ready (status: ${this.status})`);
		}

		try {
			this.ws.send(JSON.stringify({ type: 'input_audio.append', audio: audioBase64 }));
		} catch (error) {
			logger.error(`Failed to send audio to Mistral for tag ${this.tag}`, error);
			throw error;
		}
	}

	forceCommit(): void {
		if (this.status !== 'connected' || !this.ws) {
			return;
		}

		// Mistral finishes the pending text and answers with transcription.done.
		// The session stays open.
		logger.debug(`Forcing flush for idle connection ${this.tag}`);
		this.ws.send(JSON.stringify({ type: 'input_audio.flush' }));
	}

	updatePrompt(_prompt: string): void {
		// Mistral rejects session changes once audio has started
		logger.warn(`Cannot update prompt for ${this.tag}: Mistral does not support session changes after audio has started`);
	}

	close(): void {
		logger.debug(`Closing Mistral backend for tag: ${this.tag}`);
		this.ws?.close();
		this.ws = undefined;
		this.status = 'closed';
	}

	getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
		return this.status;
	}

	getDesiredAudioFormat(_inputFormat: AudioFormat): AudioFormat {
		return { encoding: 'l16', sampleRate: MISTRAL_SAMPLE_RATE };
	}

	private sendSessionUpdate(): void {
		if (!this.ws || !this.backendConfig) {
			return;
		}

		const session: { audio_format: { encoding: string; sample_rate: number }; language?: string } = {
			audio_format: { encoding: 'pcm_s16le', sample_rate: MISTRAL_SAMPLE_RATE },
		};

		if (this.backendConfig.language) {
			session.language = this.backendConfig.language;
		}

		const message = JSON.stringify({ type: 'session.update', session });
		logger.debug(`Sending session.update for tag ${this.tag}:`, message);
		this.ws.send(message);
	}

	private handleMessage(data: any): void {
		let parsedMessage;
		try {
			parsedMessage = JSON.parse(data);
		} catch (parseError) {
			logger.error(`Failed to parse Mistral message as JSON for tag ${this.tag}:`, parseError);
			return;
		}

		if (parsedMessage.type === 'transcription.text.delta') {
			this.pendingText += parsedMessage.text ?? '';
			if (this.pendingText.trim()) {
				this.onInterimTranscription?.(this.createTranscriptionMessage(this.pendingText.trim(), Date.now(), true));
			}
		} else if (parsedMessage.type === 'transcription.done') {
			logger.debug(`Received transcription.done for tag ${this.tag}`);
		} else if (parsedMessage.type === 'session.created') {
			logger.debug(`Received session.created for tag ${this.tag}:`, data);
		} else if (parsedMessage.type === 'session.updated') {
			logger.debug(`Received session.updated for tag ${this.tag}:`, data);
		} else if (parsedMessage.type === 'error') {
			const message = parsedMessage.error?.message || data;
			// The idle timeout is not a provider failure: reopen the stream in place
			const recoverable = parsedMessage.error?.code === MISTRAL_TIMEOUT_ERROR_CODE;
			logger.error(`Mistral sent error message for ${this.tag}: ${data}`);
			writeMetric(undefined, {
				name: 'mistral_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: recoverable ? 'stream_timeout' : 'api_error',
			});
			this.onError?.('api_error', message, recoverable);
			this.close();
		} else {
			// Log unexpected message types
			logger.warn(`Unhandled Mistral message type for ${this.tag}: ${parsedMessage.type}`);
		}
	}

	private createTranscriptionMessage(transcript: string, timestamp: number, isInterim: boolean): TranscriptionMessage {
		return {
			transcript: [{ text: transcript }],
			is_interim: isInterim,
			message_id: this.messageId,
			type: 'transcription-result',
			event: 'transcription-result',
			participant: this.participantInfo,
			timestamp,
		};
	}
}
