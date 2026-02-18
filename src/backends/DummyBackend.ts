/**
 * Dummy backend for testing and statistics
 *
 * Decodes Opus audio and tracks statistics but doesn't send to any transcription service.
 * Useful for testing the Opus decoder and measuring audio characteristics.
 */

import { config } from '../config';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig, AudioFormat } from './TranscriptionBackend';
import type { TranscriptionMessage } from '../transcriberproxy';
import { OpusDecoder } from '../OpusDecoder/OpusDecoder';

export class DummyBackend implements TranscriptionBackend {
	private status: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private backendConfig?: BackendConfig;
	private participantInfo: any;
	private tag: string;
	private opusDecoder?: OpusDecoder<24000>;

	// Statistics
	private stats = {
		packetCount: 0,
		encodedBytes: 0,
		decodedBytes: 0,
		totalSamples: 0,
		startTime: 0,
		endTime: 0,
	};

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

		logger.info(`Dummy backend connecting for tag: ${this.tag}`);

		// Initialize Opus decoder
		this.opusDecoder = new OpusDecoder({
			sampleRate: 24000,
			channels: 1,
		});

		await this.opusDecoder.ready;

		this.stats.startTime = Date.now();
		this.status = 'connected';

		logger.info(`Dummy backend connected for tag: ${this.tag}`);
	}

	async sendAudio(audioBase64: string): Promise<void> {
		if (!this.opusDecoder || this.status !== 'connected') {
			throw new Error(`Cannot send audio: connection not ready (status: ${this.status})`);
		}

		try {
			// Decode base64 to get Opus packet
			const opusPacket = Buffer.from(audioBase64, 'base64');
			this.stats.encodedBytes += opusPacket.length;
			this.stats.packetCount++;

			// Decode Opus to PCM
			const decoded = this.opusDecoder.decodeFrame(new Uint8Array(opusPacket));

			// Track decoded bytes and samples
			this.stats.decodedBytes += decoded.audioData.length;
			this.stats.totalSamples += decoded.samplesDecoded;

			// Audio is decoded but we throw it away (dummy backend)
		} catch (error) {
			logger.error(`Failed to decode audio in dummy backend for tag ${this.tag}`, error);
			throw error;
		}
	}

	forceCommit(): void {
		// No-op for dummy backend
		logger.debug(`Force commit called for dummy backend ${this.tag} (no-op)`);
	}

	updatePrompt(prompt: string): void {
		// No-op for dummy backend
		logger.debug(`Update prompt called for dummy backend ${this.tag} (no-op)`);
	}

	close(): void {
		logger.debug(`Closing dummy backend for tag: ${this.tag}`);

		this.stats.endTime = Date.now();

		// Print statistics
		this.printStatistics();

		// Free Opus decoder
		if (this.opusDecoder) {
			this.opusDecoder.free();
			this.opusDecoder = undefined;
		}

		this.status = 'closed';
	}

	getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
		return this.status;
	}

	getDesiredAudioFormat(_inputFormat: AudioFormat): AudioFormat {
		return { encoding: 'L16', sampleRate: 24000 };
	}

	private printStatistics(): void {
		const durationMs = this.stats.endTime - this.stats.startTime;
		const durationSec = durationMs / 1000;

		// Calculate audio duration from samples (24kHz sample rate)
		const audioDurationSec = this.stats.totalSamples / 24000;

		logger.info('='.repeat(60));
		logger.info(`Dummy Backend Statistics for tag: ${this.tag}`);
		logger.info('='.repeat(60));
		logger.info(`Packets received:      ${this.stats.packetCount}`);
		logger.info(`Encoded bytes:         ${this.stats.encodedBytes.toLocaleString()} bytes (${(this.stats.encodedBytes / 1024).toFixed(2)} KB)`);
		logger.info(`Decoded bytes:         ${this.stats.decodedBytes.toLocaleString()} bytes (${(this.stats.decodedBytes / 1024).toFixed(2)} KB)`);
		logger.info(`Total samples:         ${this.stats.totalSamples.toLocaleString()}`);
		logger.info(`Audio duration:        ${audioDurationSec.toFixed(2)} seconds`);
		logger.info(`Session duration:      ${durationSec.toFixed(2)} seconds`);
		logger.info(`Compression ratio:     ${(this.stats.decodedBytes / this.stats.encodedBytes).toFixed(2)}x`);
		logger.info(`Average bitrate:       ${((this.stats.encodedBytes * 8) / audioDurationSec / 1000).toFixed(2)} kbps`);
		logger.info('='.repeat(60));
	}
}
