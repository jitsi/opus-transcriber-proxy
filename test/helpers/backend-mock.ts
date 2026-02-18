/**
 * TranscriptionBackend mock for testing
 * Mocks the TranscriptionBackend interface without external API calls
 */

import type { TranscriptionBackend, BackendConfig, AudioFormat } from '../../src/backends/TranscriptionBackend';
import type { TranscriptionMessage } from '../../src/transcriberproxy';

export interface MockTranscriptionBackendOptions {
	status?: 'pending' | 'connected' | 'failed' | 'closed';
	wantsRawOpus?: boolean;
	connectDelay?: number;
	autoConnect?: boolean;
}

export class MockTranscriptionBackend implements TranscriptionBackend {
	private _status: 'pending' | 'connected' | 'failed' | 'closed';
	private _wantsRawOpus: boolean;
	private _connectDelay: number;
	private _sentAudio: string[] = [];
	private _promptHistory: string[] = [];
	private _connectCallCount: number = 0;
	private _forceCommitCallCount: number = 0;
	private _closeCallCount: number = 0;

	// Callbacks
	onInterimTranscription?: (message: TranscriptionMessage) => void;
	onCompleteTranscription?: (message: TranscriptionMessage) => void;
	onError?: (errorType: string, errorMessage: string) => void;
	onClosed?: () => void;

	constructor(options: MockTranscriptionBackendOptions = {}) {
		this._status = options.status || 'pending';
		this._wantsRawOpus = options.wantsRawOpus || false;
		this._connectDelay = options.connectDelay || 0;

		// Auto-connect if requested
		if (options.autoConnect !== false && this._status === 'pending') {
			setImmediate(() => {
				if (this._connectDelay > 0) {
					setTimeout(() => {
						if (this._status === 'pending') {
							this._status = 'connected';
						}
					}, this._connectDelay);
				} else {
					this._status = 'connected';
				}
			});
		}
	}

	async connect(config: BackendConfig): Promise<void> {
		this._connectCallCount++;

		if (this._promptHistory.length === 0 && config.prompt) {
			this._promptHistory.push(config.prompt);
		}

		if (this._connectDelay > 0) {
			await new Promise((resolve) => setTimeout(resolve, this._connectDelay));
		}

		if (this._status === 'failed') {
			throw new Error('Connection failed');
		}

		this._status = 'connected';
	}

	async sendAudio(audioBase64: string): Promise<void> {
		if (this._status !== 'connected') {
			throw new Error(`Cannot send audio: backend status is ${this._status}`);
		}
		this._sentAudio.push(audioBase64);
	}

	forceCommit(): void {
		this._forceCommitCallCount++;
	}

	updatePrompt(prompt: string): void {
		this._promptHistory.push(prompt);
	}

	close(): void {
		this._closeCallCount++;
		this._status = 'closed';
	}

	getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
		return this._status;
	}

	wantsRawOpus?(): boolean {
		return this._wantsRawOpus;
	}

	getDesiredAudioFormat(inputFormat: AudioFormat): AudioFormat {
		if (this._wantsRawOpus && (inputFormat.encoding === 'opus' || inputFormat.encoding === 'ogg')) {
			return inputFormat;
		}
		return { encoding: 'L16', sampleRate: 24000 };
	}

	// Test helper methods

	/**
	 * Simulate receiving an interim transcription
	 */
	simulateInterimTranscription(message: TranscriptionMessage): void {
		if (this.onInterimTranscription) {
			this.onInterimTranscription(message);
		}
	}

	/**
	 * Simulate receiving a complete transcription
	 */
	simulateCompleteTranscription(message: TranscriptionMessage): void {
		if (this.onCompleteTranscription) {
			this.onCompleteTranscription(message);
		}
	}

	/**
	 * Simulate an error
	 */
	simulateError(errorType: string, errorMessage: string): void {
		if (this.onError) {
			this.onError(errorType, errorMessage);
		}
	}

	/**
	 * Simulate backend closure
	 */
	simulateClosed(): void {
		this._status = 'closed';
		if (this.onClosed) {
			this.onClosed();
		}
	}

	/**
	 * Get all sent audio
	 */
	getSentAudio(): string[] {
		return [...this._sentAudio];
	}

	/**
	 * Get the last sent audio
	 */
	getLastSentAudio(): string | undefined {
		return this._sentAudio[this._sentAudio.length - 1];
	}

	/**
	 * Get sent audio count
	 */
	getSentAudioCount(): number {
		return this._sentAudio.length;
	}

	/**
	 * Get prompt history
	 */
	getPromptHistory(): string[] {
		return [...this._promptHistory];
	}

	/**
	 * Get the last prompt
	 */
	getLastPrompt(): string | undefined {
		return this._promptHistory[this._promptHistory.length - 1];
	}

	/**
	 * Get connect call count
	 */
	getConnectCallCount(): number {
		return this._connectCallCount;
	}

	/**
	 * Get force commit call count
	 */
	getForceCommitCallCount(): number {
		return this._forceCommitCallCount;
	}

	/**
	 * Get close call count
	 */
	getCloseCallCount(): number {
		return this._closeCallCount;
	}

	/**
	 * Set backend status
	 */
	setStatus(status: 'pending' | 'connected' | 'failed' | 'closed'): void {
		this._status = status;
	}

	/**
	 * Clear all history and counters
	 */
	clear(): void {
		this._sentAudio = [];
		this._promptHistory = [];
		this._connectCallCount = 0;
		this._forceCommitCallCount = 0;
		this._closeCallCount = 0;
	}
}

/**
 * Factory function to create a MockTranscriptionBackend
 */
export function createMockBackend(options: MockTranscriptionBackendOptions = {}): MockTranscriptionBackend {
	return new MockTranscriptionBackend(options);
}
