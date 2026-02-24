/**
 * Deepgram API backend for transcription
 *
 * Uses Deepgram's WebSocket streaming API for real-time transcription.
 * Each participant gets its own WebSocket connection.
 */

import { randomUUID } from 'crypto';
import { config } from '../config';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig, AudioFormat } from './TranscriptionBackend';
import type { TranscriptionMessage } from '../transcriberproxy';
import { writeMetric } from '../metrics';

// Deepgram WebSocket API endpoint
const DEEPGRAM_WS_BASE = 'wss://api.deepgram.com/v1/listen';

// KeepAlive interval (send every 5 seconds to keep connection alive)
const KEEPALIVE_INTERVAL_MS = 5000;

export class DeepgramBackend implements TranscriptionBackend {
	private ws?: WebSocket;
	private status: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private backendConfig?: BackendConfig;
	private participantInfo: any;
	private tag: string;
	private keepAliveTimer?: NodeJS.Timeout;

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

		if (!config.deepgram?.apiKey) {
			throw new Error('DEEPGRAM_API_KEY not configured');
		}

		return new Promise((resolve, reject) => {
			try {
				// Build query parameters based on encoding type
				// Use per-connection encoding if specified, otherwise use global config
				const encoding = backendConfig.encoding || config.deepgram.encoding;
				const isContainerized = encoding === 'ogg-opus';

				const params = new URLSearchParams({
					channels: '1',
					interim_results: 'true',
				});

				// For containerized audio (ogg-opus), omit encoding and sample_rate
				// Deepgram will auto-detect from the container header
				// See: https://developers.deepgram.com/docs/determining-your-audio-format-for-live-streaming-audio
				if (!isContainerized) {
					params.set('encoding', encoding);
					const sampleRate = encoding === 'opus' ? '48000' : '24000';
					params.set('sample_rate', sampleRate);
				}

				// Add model if specified
				if (backendConfig.model) {
					params.set('model', backendConfig.model);
				}

				// Language configuration
				// Use per-connection language if specified, otherwise use global config
				const language = backendConfig.language || config.deepgram.language;
				if (language) {
					params.set('language', language);
					// For multilingual streaming, add recommended endpointing
					// See: https://developers.deepgram.com/docs/multilingual-code-switching
					if (language === 'multi') {
						params.set('endpointing', '100');
					}
				}

				// Note: detect_language is NOT supported for streaming
				// See: https://developers.deepgram.com/docs/language-detection

				// Add other Deepgram-specific features
				if (config.deepgram.punctuate !== undefined) {
					params.set('punctuate', config.deepgram.punctuate.toString());
				}
				if (config.deepgram.diarize !== undefined) {
					params.set('diarize', config.deepgram.diarize.toString());
				}

				// Add tags from config and URL parameter
				const allTags = [...(config.deepgram.tags || []), ...(backendConfig.tags || [])];
				if (allTags.length > 0) {
					allTags.forEach((tag) => {
						params.append('tag', tag);
					});
				}

				const deepgramUrl = `${DEEPGRAM_WS_BASE}?${params.toString()}`;

				// Create WebSocket with Sec-WebSocket-Protocol for authentication
				// See: https://developers.deepgram.com/docs/using-the-sec-websocket-protocol
				const ws = new WebSocket(deepgramUrl, ['token', config.deepgram.apiKey]);

				logger.info(`Opening Deepgram WebSocket to ${deepgramUrl} for tag: ${this.tag}`);

				this.ws = ws;

				ws.addEventListener('open', () => {
					logger.info(`Deepgram WebSocket connected for tag: ${this.tag}`);
					this.status = 'connected';

					// Start KeepAlive timer
					this.startKeepAlive();

					resolve();
				});

				ws.addEventListener('message', async (event) => {
					await this.handleMessage(event.data);
				});

				ws.addEventListener('error', (event) => {
					const errorMessage = event instanceof ErrorEvent ? event.message || 'WebSocket error' : 'WebSocket error';
					logger.error(`Deepgram WebSocket error for tag ${this.tag}: ${errorMessage}`);
					writeMetric(undefined, {
						name: 'deepgram_api_error',
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
						`Deepgram WebSocket closed for tag ${this.tag}: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`,
					);
					this.status = 'closed';
					this.close();
					// Notify OutgoingConnection that the backend has closed
					this.onClosed?.();
				});
			} catch (error) {
				logger.error(`Failed to create Deepgram WebSocket connection for tag ${this.tag}:`, error);
				writeMetric(undefined, {
					name: 'deepgram_api_error',
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
			// Convert base64 to binary Buffer
			const audioBuffer = Buffer.from(audioBase64, 'base64');

			// Send as binary frame
			this.ws.send(audioBuffer);
		} catch (error) {
			logger.error(`Failed to send audio to Deepgram for tag ${this.tag}`, error);
			throw error;
		}
	}

	forceCommit(): void {
		// Send a Finalize message to flush any pending audio
		if (this.ws && this.status === 'connected') {
			try {
				this.ws.send(JSON.stringify({ type: 'Finalize' }));
				logger.debug(`Sent Finalize message to Deepgram for tag ${this.tag}`);
			} catch (error) {
				logger.error(`Failed to send Finalize message for tag ${this.tag}`, error);
			}
		}
	}

	updatePrompt(prompt: string): void {
		// Deepgram doesn't support dynamic prompt updates
		// Would require reconnecting with new keywords/phrases parameter
		logger.warn(`Cannot update prompt for ${this.tag}: Deepgram requires reconnection to change configuration`);
	}

	close(): void {
		logger.debug(`Closing Deepgram backend for tag: ${this.tag}`);

		// Stop KeepAlive timer
		if (this.keepAliveTimer) {
			clearInterval(this.keepAliveTimer);
			this.keepAliveTimer = undefined;
		}

		// Send CloseStream message
		if (this.ws && this.status === 'connected') {
			try {
				this.ws.send(JSON.stringify({ type: 'CloseStream' }));
			} catch (error) {
				logger.debug(`Error sending CloseStream for tag ${this.tag}:`, error);
			}
		}

		this.ws?.close();
		this.ws = undefined;
		this.status = 'closed';
	}

	getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
		return this.status;
	}

	getDesiredAudioFormat(inputFormat: AudioFormat): AudioFormat {
		if (inputFormat.encoding === 'opus' || inputFormat.encoding === 'ogg') {
			return inputFormat;
		}
		return { encoding: 'L16', sampleRate: 24000 };
	}

	private startKeepAlive(): void {
		this.keepAliveTimer = setInterval(() => {
			if (this.ws && this.status === 'connected') {
				try {
					this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
					logger.debug(`Sent KeepAlive to Deepgram for tag ${this.tag}`);
				} catch (error) {
					logger.error(`Failed to send KeepAlive for tag ${this.tag}`, error);
				}
			}
		}, KEEPALIVE_INTERVAL_MS);
	}

	private async handleMessage(data: any): Promise<void> {
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
				// Already a parsed object?
				parsedMessage = data;
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
			logger.debug(`Deepgram event for ${this.tag}: ${JSON.stringify(sanitized)}`);
		} catch (parseError) {
			logger.error(`Failed to parse Deepgram message as JSON for tag ${this.tag}:`, parseError);
			return;
		}

		// Handle different message types
		if (parsedMessage.type === 'Results') {
			this.handleTranscriptResult(parsedMessage);
		} else if (parsedMessage.type === 'UtteranceEnd') {
			logger.debug(`Utterance ended for ${this.tag}`);
		} else if (parsedMessage.type === 'SpeechStarted') {
			logger.debug(`Speech started for ${this.tag}`);
		} else if (parsedMessage.type === 'Metadata') {
			logger.debug(`Received metadata for ${this.tag}: ${JSON.stringify(parsedMessage)}`);
		} else if (parsedMessage.type === 'Error') {
			logger.error(`Deepgram API error for ${this.tag}:`, JSON.stringify(parsedMessage));
			writeMetric(undefined, {
				name: 'deepgram_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'api_error',
			});
			this.onError?.('api_error', parsedMessage.message || JSON.stringify(parsedMessage));
		} else {
			logger.debug(`Unhandled Deepgram message type for ${this.tag}: ${parsedMessage.type}`);
		}
	}

	private handleTranscriptResult(result: any): void {
		// Extract transcript from results
		const channel = result.channel;
		if (!channel || !channel.alternatives || channel.alternatives.length === 0) {
			return;
		}

		const alternative = channel.alternatives[0];
		let transcript = alternative.transcript;

		// Skip empty transcripts
		if (!transcript || transcript.trim() === '') {
			return;
		}

		const confidence = alternative.confidence;
		const isFinal = result.is_final === true;

		// Append detected language if configured
		if (config.deepgram.includeLanguage && alternative.languages && alternative.languages.length > 0) {
			// Use the first (dominant) language
			const detectedLanguage = alternative.languages[0];
			transcript = `${transcript} [${detectedLanguage}]`;
		}

		logger.debug(
			`Received ${isFinal ? 'final' : 'interim'} transcription from Deepgram for ${this.tag}: ${transcript} (confidence: ${confidence})`,
		);

		// Create transcription message
		// Note: Deepgram's request_id is per-session, not per-message, so we generate unique UUIDs
		const transcriptionMessage = this.createTranscriptionMessage(
			transcript,
			confidence,
			Date.now(),
			randomUUID(),
			!isFinal,
		);

		// Call appropriate callback
		if (isFinal) {
			this.onCompleteTranscription?.(transcriptionMessage);
		} else {
			this.onInterimTranscription?.(transcriptionMessage);
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
