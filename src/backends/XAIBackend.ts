/**
 * xAI Speech-to-Text backend for transcription
 *
 * Uses xAI's WebSocket-based STT streaming API for real-time transcription.
 * Audio is sent as raw binary signed-16-bit little-endian PCM frames.
 * Responses: transcript.partial (interim) and transcript.done (final).
 */

import { randomUUID } from 'crypto';
import WsWebSocket from 'ws';
import { config } from '../config';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig, AudioFormat } from './TranscriptionBackend';
import type { TranscriptionMessage } from '../transcriberproxy';
import { writeMetric } from '../metrics';

// Reused across messages; TextDecoder is stateless for our usage (one full frame per call).
const textDecoder = new TextDecoder();

// PCM sample rate sent to xAI. 16 kHz is the model's native rate (per xAI STT docs),
// which avoids a server-side resample. Used for the request param, the desired decoder
// output format, and the idle-silence buffer — keep these in sync.
const XAI_SAMPLE_RATE = 16000;

// Extra silence (ms) injected beyond the endpointing threshold on idle commit, to be
// sure xAI's VAD crosses the silence boundary and emits the final. See forceCommit().
const XAI_IDLE_SILENCE_MARGIN_MS = 300;

export class XAIBackend implements TranscriptionBackend {
	private ws?: WsWebSocket;
	private status: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private backendConfig?: BackendConfig;
	private participantInfo: any;
	private tag: string;
	private apiKey: string;
	private wsUrl: string;

	onInterimTranscription?: (message: TranscriptionMessage) => void;
	onCompleteTranscription?: (message: TranscriptionMessage) => void;
	onError?: (errorType: string, errorMessage: string, recoverable?: boolean) => void;
	onClosed?: () => void;

	constructor(tag: string, participantInfo: any) {
		this.tag = tag;
		this.participantInfo = participantInfo;
		this.apiKey = config.xai.apiKey;
		this.wsUrl = config.xai.sttUrl;
	}

	async connect(backendConfig: BackendConfig): Promise<void> {
		this.backendConfig = backendConfig;

		if (!this.apiKey) {
			throw new Error('XAI_API_KEY not configured');
		}

		return new Promise((resolve, reject) => {
			try {
				const params = new URLSearchParams({
					sample_rate: XAI_SAMPLE_RATE.toString(),
					encoding: 'pcm',
					interim_results: 'true',
				});

				const language = backendConfig.language || config.xai.language;
				if (language) {
					params.set('language', language);
				}

				if (config.xai.diarize) {
					params.set('diarize', 'true');
				}

				// Endpointing (silence-based finalization) is the correct finalizer for our
				// one-stream-per-participant topology; always sent. Per-connection override
				// (`endpointing` URL param) wins over the XAI_ENDPOINTING config default.
				const endpointing = backendConfig.xaiEndpointing ?? config.xai.endpointing;
				params.set('endpointing', endpointing.toString());

				// smart_turn is end-of-turn detection for a multi-speaker single stream. We
				// run one WS per participant, so there are no turns — it's opt-in (disabled
				// by default; it otherwise holds finals across mid-sentence pauses, producing
				// very long chunks). Sent only when configured via XAI_SMART_TURN or the
				// `smart_turn` URL param. smart_turn_timeout requires smart_turn.
				const smartTurn = backendConfig.xaiSmartTurn ?? config.xai.smartTurn;
				if (smartTurn !== undefined) {
					params.set('smart_turn', smartTurn.toString());
					const smartTurnTimeout = backendConfig.xaiSmartTurnTimeout ?? config.xai.smartTurnTimeout;
					params.set('smart_turn_timeout', smartTurnTimeout.toString());
				}

				const url = `${this.wsUrl}?${params.toString()}`;

				// Use the `ws` npm package so we can pass Authorization header.
				// The global WebSocket (undici) does not support custom headers.
				const ws = new WsWebSocket(url, {
					headers: { Authorization: `Bearer ${this.apiKey}` },
				});

				logger.info(`Opening xAI WebSocket to ${new URL(url).hostname} for tag: ${this.tag}`);

				this.ws = ws;

				ws.addEventListener('open', () => {
					logger.info(`xAI WebSocket connected for tag: ${this.tag}`);
					this.status = 'connected';
					resolve();
				});

				ws.addEventListener('message', async (event) => {
					await this.handleMessage(event.data);
				});

				ws.addEventListener('error', (event) => {
					const errorMessage = (event as any)?.message || 'WebSocket error';
					logger.error(`xAI WebSocket error for tag ${this.tag}: ${errorMessage}`);
					writeMetric(undefined, {
						name: 'xai_api_error',
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
						`xAI WebSocket closed for tag ${this.tag}: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`,
					);
					// close() fires onClosed exactly once and is idempotent, so the
					// error → close() → 'close' event → close() sequence cannot double-fire.
					this.close();
				});
			} catch (error) {
				logger.error(`Failed to create xAI WebSocket connection for tag ${this.tag}:`, error);
				writeMetric(undefined, {
					name: 'xai_api_error',
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
			const audioBuffer = Buffer.from(audioBase64, 'base64');
			this.ws.send(audioBuffer);
		} catch (error) {
			logger.error(`Failed to send audio to xAI for tag ${this.tag}`, error);
			throw error;
		}
	}

	forceCommit(): void {
		// Finalize the trailing utterance when the stream goes idle WITHOUT closing it.
		//
		// xAI exposes no flush/commit message (unlike OpenAI's input_audio_buffer.commit
		// or Deepgram's Finalize) — only `audio.done`, which makes xAI close the WS
		// (code 1006). Closing forces a full OutgoingConnection teardown + cold-start of
		// the next utterance (clipped post-pause burst, lost context, churn). #94 instead
		// made this a no-op, but then the trailing utterance before a pause/mute was never
		// finalized once audio stopped.
		//
		// Finalization is driven by `endpointing`: xAI's VAD emits speech_final once it
		// sees `endpointing` ms of silence in the audio. When the client stops sending
		// (pause/mute) no further frames arrive, so the VAD never crosses the threshold.
		// We bridge that by injecting a short tail of digital silence — enough to exceed
		// the endpointing window — which makes xAI finalize the pending utterance while
		// the WS stays open for the next one. (Same idea as jitsi/skynet's idle flush
		// worker, adapted: we can't force-transcribe xAI's model locally.)
		if (!this.ws || this.status !== 'connected') {
			return;
		}
		const endpointingMs = this.backendConfig?.xaiEndpointing ?? config.xai.endpointing;
		const silenceMs = endpointingMs + XAI_IDLE_SILENCE_MARGIN_MS;
		// Signed 16-bit mono PCM (2 bytes/sample) at the stream rate; a zero-filled buffer is silence.
		const silence = Buffer.alloc(Math.round((XAI_SAMPLE_RATE * silenceMs) / 1000) * 2);
		try {
			this.ws.send(silence);
			logger.debug(`Injected ${silenceMs}ms idle silence to flush xAI final (WS kept open) for tag ${this.tag}`);
		} catch (error) {
			logger.error(`Failed to inject idle silence for tag ${this.tag}`, error);
		}
	}

	updatePrompt(_prompt: string): void {
		// xAI STT does not support dynamic prompt updates via the streaming API
		logger.warn(`Cannot update prompt for ${this.tag}: xAI STT does not support dynamic prompts`);
	}

	close(): void {
		logger.debug(`Closing xAI backend for tag: ${this.tag}`);
		// Null callbacks before tearing down the socket so events fired during/after
		// ws.close() (and any re-entrant close() call) are dropped; onClosed fires once.
		const onClosed = this.onClosed;
		this.onClosed = undefined;
		this.onError = undefined;
		this.ws?.close();
		this.ws = undefined;
		this.status = 'closed';
		onClosed?.();
	}

	getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
		return this.status;
	}

	getDesiredAudioFormat(_inputFormat: AudioFormat): AudioFormat {
		return { encoding: 'l16', sampleRate: XAI_SAMPLE_RATE };
	}

	private async handleMessage(data: any): Promise<void> {
		let parsedMessage: any;
		try {
			let messageText: string | undefined;
			if (typeof data === 'string') {
				messageText = data;
			} else if (data instanceof ArrayBuffer) {
				messageText = textDecoder.decode(data);
			} else if (Buffer.isBuffer(data)) {
				messageText = data.toString('utf-8');
			} else if (data instanceof Blob) {
				messageText = await data.text();
			} else if (typeof data === 'object' && data !== null) {
				parsedMessage = data;
			} else {
				logger.error(`Unsupported message data type for tag ${this.tag}: ${typeof data}`);
				return;
			}

			if (!parsedMessage && messageText) {
				parsedMessage = JSON.parse(messageText);
			}

			logger.debug(`xAI event for ${this.tag}: ${JSON.stringify(parsedMessage)}`);
		} catch (parseError) {
			logger.error(`Failed to parse xAI message as JSON for tag ${this.tag}:`, parseError);
			return;
		}

		const type = parsedMessage?.type;
		if (type === 'transcript.partial') {
			this.handlePartial(parsedMessage);
		} else if (type === 'transcript.done') {
			this.handleDone(parsedMessage);
		} else if (type === 'error') {
			logger.error(`xAI API error for ${this.tag}: ${JSON.stringify(parsedMessage)}`);
			const message: string = parsedMessage.message || JSON.stringify(parsedMessage);
			// xAI closes the ASR stream after a stretch of silence/inactivity. The exact
			// message observed on wss://api.x.ai/v1/stt (2026-06-16) is:
			//   {type:"error", message:"ASR stream timed out"}
			// This is a transient, stream-level condition for a still-active participant,
			// so we flag it recoverable and OutgoingConnection reopens the stream in place
			// instead of dropping the participant (JIT-15901).
			// NOTE: the match is on the message text. If xAI changes the wording this
			// silently reverts to the fatal path. The full parsedMessage is logged at
			// error level just above, so if the "ASR stream timed out" error rate climbs
			// after an xAI API change, audit that log and update this matcher.
			const recoverable = /timed out/i.test(message);
			writeMetric(undefined, {
				name: 'xai_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: recoverable ? 'stream_timeout' : 'api_error',
			});
			this.onError?.('api_error', message, recoverable);
			this.close();
		} else {
			logger.debug(`Unhandled xAI message type for ${this.tag}: ${type}`);
		}
	}

	private handlePartial(msg: any): void {
		const text: string = msg.text ?? '';
		if (!text.trim()) return;

		// xAI accumulates text within an utterance and emits multiple is_final=true
		// partials, each a superset of the previous. speech_final=true marks the true
		// end of an utterance — only that should be emitted as a final transcription.
		// transcript.done fires at stream end with empty text — not useful for finals.
		const isFinal: boolean = msg.speech_final === true;
		const language: string | undefined = msg.language || undefined;

		if (
			config.xai.diarize &&
			Array.isArray(msg.words) &&
			msg.words.length > 0 &&
			msg.words[0].speaker !== undefined
		) {
			this.emitDiarized(msg.words, language, !isFinal);
			return;
		}

		const confidence = this.avgConfidence(msg.words);
		const transcript = config.xai.includeLanguage && language && isFinal ? `${text} [${language}]` : text;
		const message = this.createMessage(transcript, confidence, Date.now(), randomUUID(), !isFinal, undefined, language);

		if (isFinal) {
			this.onCompleteTranscription?.(message);
		} else {
			this.onInterimTranscription?.(message);
		}
	}

	private handleDone(msg: any): void {
		const text: string = msg.text ?? '';
		if (!text.trim()) return;

		const language: string | undefined = msg.language || undefined;

		if (
			config.xai.diarize &&
			Array.isArray(msg.words) &&
			msg.words.length > 0 &&
			msg.words[0].speaker !== undefined
		) {
			this.emitDiarized(msg.words, language, false);
			return;
		}

		const confidence = this.avgConfidence(msg.words);
		const transcript = config.xai.includeLanguage && language ? `${text} [${language}]` : text;

		this.onCompleteTranscription?.(
			this.createMessage(transcript, confidence, Date.now(), randomUUID(), false, undefined, language),
		);
	}

	private emitDiarized(words: any[], language: string | undefined, isInterim: boolean): void {
		const segments: Array<{ speaker: number; words: any[] }> = [];
		for (const word of words) {
			const speaker = word.speaker as number;
			const last = segments[segments.length - 1];
			if (last && last.speaker === speaker) {
				last.words.push(word);
			} else {
				segments.push({ speaker, words: [word] });
			}
		}

		const languageSuffix = config.xai.includeLanguage && language ? ` [${language}]` : '';
		const now = Date.now();

		for (const segment of segments) {
			let text = segment.words
				.map((w: any) => w.punctuated_word ?? w.text)
				.join(' ')
				.trim();

			if (!text) continue;
			if (languageSuffix) text += languageSuffix;

			const confidence = this.avgConfidence(segment.words);

			logger.debug(
				`Received ${isInterim ? 'interim' : 'final'} transcription from xAI for ${this.tag} speaker ${segment.speaker}: ${text}`,
			);

			const message = this.createMessage(text, confidence, now, randomUUID(), isInterim, segment.speaker, language);
			if (isInterim) {
				this.onInterimTranscription?.(message);
			} else {
				this.onCompleteTranscription?.(message);
			}
		}
	}

	private avgConfidence(words: any[] | undefined): number | undefined {
		if (!Array.isArray(words) || words.length === 0) return undefined;
		const vals = words.map((w: any) => w.confidence).filter((c: any) => typeof c === 'number');
		if (vals.length === 0) return undefined;
		return vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
	}

	private createMessage(
		transcript: string,
		confidence: number | undefined,
		timestamp: number,
		message_id: string,
		isInterim: boolean,
		speaker?: number,
		language?: string,
	): TranscriptionMessage {
		return {
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
			...(speaker !== undefined && { speaker }),
			...(language !== undefined && { language }),
		};
	}
}
