/**
 * OpenAI Realtime API backend for transcription
 *
 * Uses OpenAI's WebSocket-based Realtime API for low-latency transcription.
 * Supports streaming audio input and receives interim/final transcription results.
 */

import { config } from '../config';
import { getTurnDetectionConfig } from '../utils';
import { writeMetric } from '../metrics';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig } from './TranscriptionBackend';
import type { TranscriptionMessage } from '../transcriberproxy';

const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

export class OpenAIBackend implements TranscriptionBackend {
	private ws?: WebSocket;
	private status: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private backendConfig?: BackendConfig;
	private participantInfo: any;
	private tag: string;
	private lastTranscriptTime?: number;

	onInterimTranscription?: (message: TranscriptionMessage) => void;
	onCompleteTranscription?: (message: TranscriptionMessage) => void;
	onError?: (errorType: string, errorMessage: string) => void;

	constructor(tag: string, participantInfo: any) {
		this.tag = tag;
		this.participantInfo = participantInfo;
	}

	async connect(backendConfig: BackendConfig): Promise<void> {
		this.backendConfig = backendConfig;

		return new Promise((resolve, reject) => {
			try {
				const ws = new WebSocket(OPENAI_WS_URL, ['realtime', `openai-insecure-api-key.${config.openai.apiKey}`]);

				logger.debug(`Opening OpenAI WebSocket to ${OPENAI_WS_URL} for tag: ${this.tag}`);

				this.ws = ws;

				ws.addEventListener('open', () => {
					logger.info(`OpenAI WebSocket connected for tag: ${this.tag}`);
					this.status = 'connected';

					// Send initial session configuration
					this.sendSessionUpdate();

					resolve();
				});

				ws.addEventListener('message', (event) => {
					this.handleMessage(event.data);
				});

				ws.addEventListener('error', (event) => {
					const errorMessage = event instanceof ErrorEvent ? event.message || 'WebSocket error' : 'WebSocket error';
					logger.error(`OpenAI WebSocket error for tag ${this.tag}: ${errorMessage}`);
					writeMetric(undefined, {
						name: 'openai_api_error',
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
						`OpenAI WebSocket closed for tag ${this.tag}: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`,
					);
					this.status = 'failed';
					this.close();
				});
			} catch (error) {
				logger.error(`Failed to create OpenAI WebSocket connection for tag ${this.tag}:`, error);
				writeMetric(undefined, {
					name: 'openai_api_error',
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
			const audioMessage = {
				type: 'input_audio_buffer.append',
				audio: audioBase64,
			};

			this.ws.send(JSON.stringify(audioMessage));
		} catch (error) {
			logger.error(`Failed to send audio to OpenAI for tag ${this.tag}`, error);
			throw error;
		}
	}

	forceCommit(): void {
		if (this.status !== 'connected' || !this.ws) {
			return;
		}

		logger.debug(`Forcing commit for idle connection ${this.tag}`);
		const commitMessage = { type: 'input_audio_buffer.commit' };
		this.ws.send(JSON.stringify(commitMessage));
	}

	updatePrompt(prompt: string): void {
		if (this.status !== 'connected' || !this.ws || !this.backendConfig) {
			logger.warn(`Cannot update prompt for ${this.tag}: connection not ready`);
			return;
		}

		try {
			// Update the config and resend session update
			this.backendConfig.prompt = prompt;
			this.sendSessionUpdate();

			logger.debug(`Updated session prompt for ${this.tag} (prompt size: ${prompt.length} bytes)`);
		} catch (error) {
			logger.error(`Failed to update session prompt for ${this.tag}:`, error);
		}
	}

	close(): void {
		logger.debug(`Closing OpenAI backend for tag: ${this.tag}`);
		this.ws?.close();
		this.ws = undefined;
		this.status = 'closed';
	}

	getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
		return this.status;
	}

	private sendSessionUpdate(): void {
		if (!this.ws || !this.backendConfig) {
			return;
		}

		const transcriptionConfig: { model: string; language?: string; prompt?: string } = {
			model: this.backendConfig.model || config.openai.model,
		};

		if (this.backendConfig.language !== null) {
			transcriptionConfig.language = this.backendConfig.language;
		}

		if (this.backendConfig.prompt) {
			transcriptionConfig.prompt = this.backendConfig.prompt;
		}

		const sessionConfig = {
			type: 'session.update',
			session: {
				type: 'transcription',
				audio: {
					input: {
						format: {
							type: 'audio/pcm',
							rate: 24000,
						},
						noise_reduction: {
							type: 'near_field',
						},
						transcription: transcriptionConfig,
						turn_detection: getTurnDetectionConfig(),
					},
				},
				include: ['item.input_audio_transcription.logprobs'],
			},
		};

		const sessionConfigMessage = JSON.stringify(sessionConfig);
		logger.debug(`Sending session.update for tag ${this.tag}:`, sessionConfigMessage);
		this.ws.send(sessionConfigMessage);
	}

	private handleMessage(data: any): void {
		let parsedMessage;
		try {
			parsedMessage = JSON.parse(data);
		} catch (parseError) {
			logger.error(`Failed to parse OpenAI message as JSON for tag ${this.tag}:`, parseError);
			return;
		}

		if (parsedMessage.type === 'conversation.item.input_audio_transcription.delta') {
			const now = Date.now();
			if (this.lastTranscriptTime === undefined) {
				this.lastTranscriptTime = now;
			}
			const confidence = parsedMessage.logprobs?.[0]?.logprob !== undefined ? Math.exp(parsedMessage.logprobs[0].logprob) : undefined;
			const transcription = this.createTranscriptionMessage(parsedMessage.delta, confidence, now, parsedMessage.item_id, true);
			this.onInterimTranscription?.(transcription);
		} else if (parsedMessage.type === 'conversation.item.input_audio_transcription.completed') {
			let transcriptTime;
			if (this.lastTranscriptTime !== undefined) {
				transcriptTime = this.lastTranscriptTime;
				this.lastTranscriptTime = undefined;
			} else {
				transcriptTime = Date.now();
			}
			const confidence = parsedMessage.logprobs?.[0]?.logprob !== undefined ? Math.exp(parsedMessage.logprobs[0].logprob) : undefined;
			const transcription = this.createTranscriptionMessage(
				parsedMessage.transcript,
				confidence,
				transcriptTime,
				parsedMessage.item_id,
				false,
			);
			this.onCompleteTranscription?.(transcription);
		} else if (parsedMessage.type === 'conversation.item.input_audio_transcription.failed') {
			logger.error(`OpenAI failed to transcribe audio for tag ${this.tag}: ${data}`);
			writeMetric(undefined, {
				name: 'transcription_failure',
				worker: 'opus-transcriber-proxy',
			});
		} else if (parsedMessage.type === 'session.created') {
			logger.debug(`Received session.created for tag ${this.tag}:`, data);
		} else if (parsedMessage.type === 'session.updated') {
			logger.debug(`Received session.updated for tag ${this.tag}:`, data);
		} else if (parsedMessage.type === 'error') {
			if (parsedMessage.error?.type === 'invalid_request_error' && parsedMessage.error?.code === 'input_audio_buffer_commit_empty') {
				// Empty buffer commit - can happen with VAD, ignore
				logger.debug(`OpenAI reported empty audio buffer commit for ${this.tag}, ignoring.`);
				return;
			}
			logger.error(`OpenAI sent error message for ${this.tag}: ${data}`);
			writeMetric(undefined, {
				name: 'openai_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'api_error',
			});
			this.onError?.('api_error', parsedMessage.error?.message || data);
			this.close();
		} else if (
			parsedMessage.type !== 'input_audio_buffer.committed' &&
			parsedMessage.type !== 'input_audio_buffer.speech_started' &&
			parsedMessage.type !== 'input_audio_buffer.speech_stopped' &&
			parsedMessage.type !== 'conversation.item.added' &&
			parsedMessage.type !== 'conversation.item.done'
		) {
			// Log unexpected message types
			logger.warn(`Unhandled OpenAI message type for ${this.tag}: ${parsedMessage.type}`);
		}
	}

	private createTranscriptionMessage(
		transcript: string,
		confidence: number | undefined,
		timestamp: number,
		message_id: string,
		isInterim: boolean,
	): TranscriptionMessage {
		const message: TranscriptionMessage = {
			transcript: [
				{
					...(confidence !== undefined && { confidence }),
					text: transcript,
				},
			],
			is_interim: isInterim,
			message_id,
			type: 'transcription-result',
			event: 'transcription-result',
			participant: this.participantInfo,
			timestamp,
		};
		return message;
	}
}
