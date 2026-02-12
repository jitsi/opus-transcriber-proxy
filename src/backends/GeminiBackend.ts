/**
 * Google Gemini API backend for transcription
 *
 * Uses Google's Gemini WebSocket-based BidiGenerateContent API for real-time transcription.
 * This API supports streaming PCM audio directly without needing WAV containers.
 */

import { config } from '../config';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig } from './TranscriptionBackend';
import type { TranscriptionMessage } from '../transcriberproxy';
import { writeMetric } from '../metrics';
import { toLanguageName } from '../languageMap';

// Gemini WebSocket API endpoint (v1beta - more stable than v1alpha)
const GEMINI_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Gemini uses 16kHz sample rate for audio
const GEMINI_SAMPLE_RATE = 16000;

export class GeminiBackend implements TranscriptionBackend {
	private ws?: WebSocket;
	private status: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private setupComplete: boolean = false;
	private backendConfig?: BackendConfig;
	private participantInfo: any;
	private tag: string;

	onInterimTranscription?: (message: TranscriptionMessage) => void;
	onCompleteTranscription?: (message: TranscriptionMessage) => void;
	onError?: (errorType: string, errorMessage: string) => void;
	onClosed?: () => void;

	constructor(tag: string, participantInfo: any) {
		this.tag = tag;
		this.participantInfo = participantInfo;
	}

	async connect(backendConfig: BackendConfig): Promise<void> {
		this.backendConfig = backendConfig;

		if (!config.gemini?.apiKey) {
			throw new Error('GEMINI_API_KEY not configured');
		}

		return new Promise((resolve, reject) => {
			try {
				const geminiUrl = `${GEMINI_WS_BASE}?key=${config.gemini.apiKey}`;
				const ws = new WebSocket(geminiUrl);

				logger.debug(`Opening Gemini WebSocket to ${geminiUrl} for tag: ${this.tag}`);

				this.ws = ws;

				ws.addEventListener('open', () => {
					logger.info(`Gemini WebSocket opened for tag: ${this.tag}`);
					// Note: Status stays 'pending' until setup is complete

					// Send setup message to configure the model
					this.sendSetupMessage();

					// Note: We'll resolve after setup is complete, handled in message handler
				});

				ws.addEventListener('message', async (event) => {
					await this.handleMessage(event.data, resolve, reject);
				});

				ws.addEventListener('error', (event) => {
					const errorMessage = event instanceof ErrorEvent ? event.message || 'WebSocket error' : 'WebSocket error';
					logger.error(`Gemini WebSocket error for tag ${this.tag}: ${errorMessage}`);
					writeMetric(undefined, {
						name: 'gemini_api_error',
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
						`Gemini WebSocket closed for tag ${this.tag}: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`,
					);
					this.status = 'failed';
					this.close();
					// Notify OutgoingConnection that the backend has closed
					this.onClosed?.();
				});
			} catch (error) {
				logger.error(`Failed to create Gemini WebSocket connection for tag ${this.tag}:`, error);
				writeMetric(undefined, {
					name: 'gemini_api_error',
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
		if (!this.ws || this.status !== 'connected' || !this.setupComplete) {
			throw new Error(`Cannot send audio: connection not ready (status: ${this.status}, setupComplete: ${this.setupComplete})`);
		}

		try {
			// Note: We need to resample from 24kHz to 16kHz
			// For now, sending at 24kHz and letting Gemini handle it
			// TODO: Add proper resampling if needed
			const realtimeInput = {
				realtime_input: {
					media_chunks: [
						{
							mime_type: `audio/pcm;rate=24000`, // Using 24kHz for now
							data: audioBase64,
						},
					],
				},
			};

			this.ws.send(JSON.stringify(realtimeInput));
		} catch (error) {
			logger.error(`Failed to send audio to Gemini for tag ${this.tag}`, error);
			throw error;
		}
	}

	forceCommit(): void {
		// Gemini doesn't have an explicit commit - it processes audio as it arrives
		logger.debug(`Force commit called for Gemini backend ${this.tag} (no-op)`);
	}

	updatePrompt(prompt: string): void {
		// Gemini setup is sent once at connection time
		// Updating prompts mid-stream would require reconnecting
		logger.warn(`Cannot update prompt for ${this.tag}: Gemini requires reconnection to change prompts`);
	}

	close(): void {
		logger.debug(`Closing Gemini backend for tag: ${this.tag}`);
		this.ws?.close();
		this.ws = undefined;
		this.status = 'closed';
		this.setupComplete = false;
	}

	getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
		return this.status;
	}

	private sendSetupMessage(): void {
		if (!this.ws || !this.backendConfig) {
			return;
		}

		const model = this.backendConfig.model || config.gemini.model || 'gemini-2.0-flash-exp';

		// Build system instruction
		let systemInstruction = this.backendConfig.prompt || 'Transcribe the following audio. Output only the transcribed text.';

		if (this.backendConfig.language) {
			const languageName = toLanguageName(this.backendConfig.language);
			systemInstruction += ` The audio is in ${languageName}.`;
		}

		const setupMessage = {
			setup: {
				model: `models/${model}`,
				generation_config: {
					response_modalities: ['TEXT'], // We only want text transcriptions
				},
				system_instruction: {
					parts: [
						{
							text: systemInstruction,
						},
					],
				},
			},
		};

		const setupString = JSON.stringify(setupMessage);
		logger.debug(`Sending Gemini setup for tag ${this.tag}: ${setupString}`);
		this.ws.send(setupString);
	}

	private async handleMessage(data: any, resolve?: (value: void) => void, reject?: (reason?: any) => void): Promise<void> {
		let parsedMessage;
		try {
			// Handle different message formats (string, ArrayBuffer, Buffer, Blob)
			let messageText: string | undefined;
			if (typeof data === 'string') {
				messageText = data;
			} else if (data instanceof ArrayBuffer) {
				const decoder = new TextDecoder();
				messageText = decoder.decode(data);
			} else if (Buffer.isBuffer(data)) {
				messageText = data.toString('utf-8');
			} else if (data instanceof Blob) {
				// Handle Blob objects (from undici WebSocket)
				messageText = await data.text();
			} else if (typeof data === 'object' && data !== null) {
				// Try to handle as object with toString or directly as JSON
				logger.debug(`Received object data for tag ${this.tag}, constructor: ${data.constructor?.name}, keys: ${Object.keys(data).join(',')}`);
				if (typeof data.toString === 'function') {
					messageText = data.toString('utf-8');
				} else {
					// Already a parsed object?
					parsedMessage = data;
				}
			} else {
				logger.error(`Unsupported message data type for tag ${this.tag}: ${typeof data}`);
				return;
			}

			if (!parsedMessage && messageText) {
				parsedMessage = JSON.parse(messageText);
			}

			// Log the event (sanitized)
			const sanitized = JSON.parse(
				JSON.stringify(parsedMessage, (key, value) => {
					if (key === 'data' && typeof value === 'string' && value.length > 100) {
						return `[BASE64 DATA - ${value.length} chars]`;
					}
					return value;
				}),
			);
			logger.debug(`Gemini event for ${this.tag}: ${JSON.stringify(sanitized)}`);
		} catch (parseError) {
			logger.error(`Failed to parse Gemini message as JSON for tag ${this.tag}:`, parseError);
			return;
		}

		// Handle setup complete
		if (parsedMessage.setupComplete !== undefined) {
			logger.info(`Gemini setup complete for tag ${this.tag}`);
			this.setupComplete = true;
			this.status = 'connected';

			// Resolve the connect promise
			if (resolve) {
				resolve();
			}
			return;
		}

		// Handle server content (responses)
		if (parsedMessage.serverContent) {
			const parts = parsedMessage.serverContent.modelTurn?.parts || [];

			for (const part of parts) {
				// Handle text transcript
				if (part.text && part.text.trim()) {
					const transcriptText = part.text.trim();
					logger.debug(`Received transcription from Gemini for ${this.tag}: ${transcriptText}`);

					// Create transcription message
					const transcription = this.createTranscriptionMessage(
						transcriptText,
						undefined, // Gemini doesn't provide confidence scores
						Date.now(),
						Date.now().toString(),
						false, // Gemini returns complete transcriptions
					);

					this.onCompleteTranscription?.(transcription);
				}
			}
			return;
		}

		// Handle errors
		if (parsedMessage.error) {
			logger.error(`Gemini API error for ${this.tag}:`, JSON.stringify(parsedMessage.error));
			writeMetric(undefined, {
				name: 'gemini_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'api_error',
			});
			this.onError?.('api_error', parsedMessage.error.message || JSON.stringify(parsedMessage.error));

			if (reject) {
				reject(new Error(parsedMessage.error.message || 'Gemini API error'));
			}
			return;
		}

		// Log any other message types
		logger.debug(`Unhandled Gemini message type for ${this.tag}: ${JSON.stringify(parsedMessage)}`);
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
