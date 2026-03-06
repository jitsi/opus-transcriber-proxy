/**
 * Dummy backend for testing and statistics
 *
 * Receives pre-decoded PCM audio and tracks statistics but doesn't send to any
 * transcription service. Useful for testing the audio pipeline and measuring
 * audio characteristics.
 */

import logger from '../logger';
import type { TranscriptionBackend, BackendConfig, AudioFormat } from './TranscriptionBackend';
import type { TranscriptionMessage } from '../transcriberproxy';

const DUMMY_BACKEND_SAMPLE_RATE = 24000;
const BYTES_PER_L16_SAMPLE = 2;

export class DummyBackend implements TranscriptionBackend {
	private status: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private backendConfig?: BackendConfig;
	private participantInfo: any;
	private tag: string;

	// Statistics
	private stats = {
		packetCount: 0,
		audioBytes: 0,
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
		this.stats.startTime = Date.now();
		this.status = 'connected';
		logger.info(`Dummy backend connected for tag: ${this.tag}`);
	}

	async sendAudio(audioBase64: string): Promise<void> {
		if (this.status !== 'connected') {
			throw new Error(`Cannot send audio: connection not ready (status: ${this.status})`);
		}

		// Incoming audio is PCM l16 (2 bytes per sample). This is correct because
		// getDesiredAudioFormat() always returns { encoding: 'l16' }.
		const audioBytes = Buffer.byteLength(audioBase64, 'base64');
		this.stats.audioBytes += audioBytes;
		this.stats.totalSamples += audioBytes / BYTES_PER_L16_SAMPLE;
		this.stats.packetCount++;
	}

	forceCommit(): void {
		logger.debug(`Force commit called for dummy backend ${this.tag} (no-op)`);
	}

	updatePrompt(prompt: string): void {
		logger.debug(`Update prompt called for dummy backend ${this.tag} (no-op)`);
	}

	close(): void {
		logger.debug(`Closing dummy backend for tag: ${this.tag}`);
		this.stats.endTime = Date.now();
		this.printStatistics();
		this.status = 'closed';
	}

	getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
		return this.status;
	}

	getDesiredAudioFormat(_inputFormat: AudioFormat): AudioFormat {
		return { encoding: 'l16', sampleRate: DUMMY_BACKEND_SAMPLE_RATE };
	}

	private printStatistics(): void {
		const durationMs = this.stats.endTime - this.stats.startTime;
		const durationSec = durationMs / 1000;
		const audioDurationSec = this.stats.totalSamples / DUMMY_BACKEND_SAMPLE_RATE;

		logger.info('='.repeat(60));
		logger.info(`Dummy Backend Statistics for tag: ${this.tag}`);
		logger.info('='.repeat(60));
		logger.info(`Packets received:      ${this.stats.packetCount}`);
		logger.info(`Audio bytes:           ${this.stats.audioBytes.toLocaleString()} bytes (${(this.stats.audioBytes / 1024).toFixed(2)} KB)`);
		logger.info(`Total samples:         ${this.stats.totalSamples.toLocaleString()}`);
		logger.info(`Audio duration:        ${audioDurationSec.toFixed(2)} seconds`);
		logger.info(`Session duration:      ${durationSec.toFixed(2)} seconds`);
		logger.info('='.repeat(60));
	}
}
