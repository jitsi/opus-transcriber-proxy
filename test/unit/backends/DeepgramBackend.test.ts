/**
 * Tests for DeepgramBackend module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepgramBackend } from '../../../src/backends/DeepgramBackend';
import { mockGlobalWebSocket, MockWebSocket, type MockWebSocketInstance } from '../../helpers/websocket-mock';
import type { BackendConfig, AudioFormat } from '../../../src/backends/TranscriptionBackend';
import type { TranscriptionMessage } from '../../../src/transcriberproxy';
import { config } from '../../../src/config';

// Mock logger
vi.mock('../../../src/logger', () => ({
	default: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock metrics
vi.mock('../../../src/metrics', () => ({
	writeMetric: vi.fn(),
}));

// Mock config
vi.mock('../../../src/config', () => ({
	config: {
		deepgram: {
			apiKey: 'test-deepgram-key',
			encoding: 'opus',
			model: 'nova-2',
			language: 'en',
			punctuate: true,
			diarize: false,
			includeLanguage: false,
			mipOptOut: false,
			tags: ['test-tag-1', 'test-tag-2'],
		},
	},
}));

describe('DeepgramBackend', () => {
	let mockWsManager: { mockWs: MockWebSocketInstance; unmock: () => void };

	beforeEach(() => {
		vi.clearAllMocks();
		mockWsManager = mockGlobalWebSocket();
		vi.useFakeTimers();
	});

	afterEach(() => {
		mockWsManager.unmock();
		vi.useRealTimers();
	});

	describe('Constructor', () => {
		it('should initialize with tag and participantInfo', () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });

			expect(backend).toBeDefined();
			expect(backend.getStatus()).toBe('pending');
		});
	});

	describe('connect', () => {
		it('should connect to Deepgram WebSocket with correct URL and protocol', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const backendConfig: BackendConfig = {
				model: 'nova-2',
				language: 'en',
				prompt: undefined,
			};

			const connectPromise = backend.connect(backendConfig);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			// Default mock config has encoding='opus', so the URL uses raw-Opus params
			expect(mockWsManager.mockWs.url).toContain('wss://api.deepgram.com/v1/listen');
			expect(mockWsManager.mockWs.url).toContain('encoding=opus');
			expect(mockWsManager.mockWs.url).toContain('sample_rate=48000');
			expect(mockWsManager.mockWs.url).toContain('channels=1');
			expect(mockWsManager.mockWs.url).toContain('interim_results=true');
			expect(mockWsManager.mockWs.protocols).toEqual(['token', 'test-deepgram-key']);
		});

		it('should let per-endpoint backendConfig.diarize=true override the global diarize=false', async () => {
			// global config mock has diarize:false; the start-event override enables it
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const backendConfig: BackendConfig = { model: 'nova-2', diarize: true };

			const connectPromise = backend.connect(backendConfig);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(mockWsManager.mockWs.url).toContain('diarize=true');
		});

		it('should let per-endpoint backendConfig.diarize=false override a globally-enabled diarize', async () => {
			(config.deepgram as any).diarize = true;
			try {
				const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
				const connectPromise = backend.connect({ model: 'nova-2', diarize: false });
				mockWsManager.mockWs.simulateOpen();
				await connectPromise;

				expect(mockWsManager.mockWs.url).toContain('diarize=false');
			} finally {
				(config.deepgram as any).diarize = false;
			}
		});

		it('should use linear16 encoding params when DEEPGRAM_ENCODING=linear16', async () => {
			(config.deepgram as any).encoding = 'linear16';
			try {
				const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
				const backendConfig: BackendConfig = { model: 'nova-2', language: undefined, prompt: undefined };

				const connectPromise = backend.connect(backendConfig);
				mockWsManager.mockWs.simulateOpen();
				await connectPromise;

				expect(mockWsManager.mockWs.url).toContain('encoding=linear16');
				expect(mockWsManager.mockWs.url).toContain('sample_rate=24000');
			} finally {
				(config.deepgram as any).encoding = 'opus';
			}
		});

		it('should include model in URL if provided', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2-general',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(mockWsManager.mockWs.url).toContain('model=nova-2-general');
		});

		it('should include language in URL if provided', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: 'es',
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(mockWsManager.mockWs.url).toContain('language=es');
		});

		it('should add endpointing parameter for multilingual mode', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: 'multi',
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(mockWsManager.mockWs.url).toContain('language=multi');
			expect(mockWsManager.mockWs.url).toContain('endpointing=100');
		});

		it('should include punctuate and diarize parameters', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(mockWsManager.mockWs.url).toContain('punctuate=true');
			expect(mockWsManager.mockWs.url).toContain('diarize=false');
		});

		it('should include tags in URL if configured', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(mockWsManager.mockWs.url).toContain('tag=test-tag-1');
			expect(mockWsManager.mockWs.url).toContain('tag=test-tag-2');
		});

		it('should not include mip_opt_out by default', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const backendConfig: BackendConfig = { model: 'nova-2', language: undefined, prompt: undefined };

			const connectPromise = backend.connect(backendConfig);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(mockWsManager.mockWs.url).not.toContain('mip_opt_out');
		});

		it('should include mip_opt_out=true when config.deepgram.mipOptOut is true', async () => {
			(config.deepgram as any).mipOptOut = true;
			try {
				const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
				const backendConfig: BackendConfig = { model: 'nova-2', language: undefined, prompt: undefined };

				const connectPromise = backend.connect(backendConfig);
				mockWsManager.mockWs.simulateOpen();
				await connectPromise;

				expect(mockWsManager.mockWs.url).toContain('mip_opt_out=true');
			} finally {
				(config.deepgram as any).mipOptOut = false;
			}
		});

		it('should let per-connection deepgramMipOptOut=true override config false', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const backendConfig: BackendConfig = { model: 'nova-2', deepgramMipOptOut: true };

			const connectPromise = backend.connect(backendConfig);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(mockWsManager.mockWs.url).toContain('mip_opt_out=true');
		});

		it('should let per-connection deepgramMipOptOut=false override config true', async () => {
			(config.deepgram as any).mipOptOut = true;
			try {
				const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
				const backendConfig: BackendConfig = { model: 'nova-2', deepgramMipOptOut: false };

				const connectPromise = backend.connect(backendConfig);
				mockWsManager.mockWs.simulateOpen();
				await connectPromise;

				expect(mockWsManager.mockWs.url).not.toContain('mip_opt_out');
			} finally {
				(config.deepgram as any).mipOptOut = false;
			}
		});

		it('should start KeepAlive timer on connection', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			// Clear initial messages
			mockWsManager.mockWs.clearSentMessages();

			// Advance time by 5 seconds
			vi.advanceTimersByTime(5000);

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			expect(sentMessages.length).toBeGreaterThan(0);

			const keepAliveMessage = JSON.parse(sentMessages[0]);
			expect(keepAliveMessage.type).toBe('KeepAlive');
		});

		it('should set status to connected on successful connection', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			expect(backend.getStatus()).toBe('pending');

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(backend.getStatus()).toBe('connected');
		});

		it('should reject on WebSocket error', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateError(new Error('Connection failed'));

			await expect(connectPromise).rejects.toThrow('Connection failed');
			expect(backend.getStatus()).toBe('closed');
		});

		it('should call onError callback on WebSocket error', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const onErrorSpy = vi.fn();
			backend.onError = onErrorSpy;

			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateError(new Error('Connection failed'));

			await expect(connectPromise).rejects.toThrow();
			expect(onErrorSpy).toHaveBeenCalledWith('websocket_error', 'WebSocket connection error');
		});

		it('should call onClosed callback on WebSocket close', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const onClosedSpy = vi.fn();
			backend.onClosed = onClosedSpy;

			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			mockWsManager.mockWs.simulateClose(1000, 'Normal closure', true);

			expect(onClosedSpy).toHaveBeenCalled();
			expect(backend.getStatus()).toBe('closed');
		});
	});

	describe('sendAudio', () => {
		it('should send audio as binary buffer', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			mockWsManager.mockWs.clearSentMessages();

			const audioBase64 = 'T3B1c0F1ZGlvRGF0YQ==';
			await backend.sendAudio(audioBase64);

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			expect(sentMessages.length).toBe(1);

			// Message should be a Buffer, not a string
			expect(Buffer.isBuffer(sentMessages[0])).toBe(true);
			expect(sentMessages[0].toString('base64')).toBe(audioBase64);
		});

		it('should throw error when not connected', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });

			await expect(backend.sendAudio('T3B1c0F1ZGlvRGF0YQ==')).rejects.toThrow(
				'Cannot send audio: connection not ready (status: pending)',
			);
		});
	});

	describe('forceCommit', () => {
		it('should send Finalize message', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			mockWsManager.mockWs.clearSentMessages();

			backend.forceCommit();

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			expect(sentMessages.length).toBe(1);

			const finalizeMessage = JSON.parse(sentMessages[0]);
			expect(finalizeMessage.type).toBe('Finalize');
		});

		it('should not send Finalize when not connected', () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });

			backend.forceCommit();

			// Should not throw
		});
	});

	describe('updatePrompt', () => {
		it('should log warning (not supported)', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			mockWsManager.mockWs.clearSentMessages();

			backend.updatePrompt('New prompt');

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			expect(sentMessages.length).toBe(0);
		});
	});

	describe('handleMessage - Results', () => {
		it('should call onInterimTranscription for interim results', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const onInterimSpy = vi.fn();
			backend.onInterimTranscription = onInterimSpy;

			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const resultsMessage = {
				type: 'Results',
				is_final: false,
				channel: {
					alternatives: [
						{
							transcript: 'Hello world',
							confidence: 0.95,
						},
					],
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(resultsMessage));

			expect(onInterimSpy).toHaveBeenCalledTimes(1);
			const transcription: TranscriptionMessage = onInterimSpy.mock.calls[0][0];
			expect(transcription.transcript[0].text).toBe('Hello world');
			expect(transcription.transcript[0].confidence).toBe(0.95);
			expect(transcription.is_interim).toBe(true);
			expect(transcription.participant).toEqual({ id: 'participant-1' });
		});

		it('should call onCompleteTranscription for final results', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const onCompleteSpy = vi.fn();
			backend.onCompleteTranscription = onCompleteSpy;

			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const resultsMessage = {
				type: 'Results',
				is_final: true,
				channel: {
					alternatives: [
						{
							transcript: 'Final transcript',
							confidence: 0.98,
						},
					],
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(resultsMessage));

			expect(onCompleteSpy).toHaveBeenCalledTimes(1);
			const transcription: TranscriptionMessage = onCompleteSpy.mock.calls[0][0];
			expect(transcription.transcript[0].text).toBe('Final transcript');
			expect(transcription.transcript[0].confidence).toBe(0.98);
			expect(transcription.is_interim).toBe(false);
		});

		it('should set language property when backend provides languages', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const onCompleteSpy = vi.fn();
			backend.onCompleteTranscription = onCompleteSpy;

			const connectPromise = backend.connect({ model: 'nova-2', language: undefined, prompt: undefined });
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			mockWsManager.mockWs.simulateMessage(JSON.stringify({
				type: 'Results',
				is_final: true,
				channel: {
					alternatives: [{ transcript: 'Hello', confidence: 0.98, languages: ['es'] }],
				},
			}));

			const msg: TranscriptionMessage = onCompleteSpy.mock.calls[0][0];
			expect(msg.language).toBe('es');
			// text should NOT have suffix when includeLanguage=false (default)
			expect(msg.transcript[0].text).toBe('Hello');
		});

		it('should not set language property when backend provides no languages', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const onCompleteSpy = vi.fn();
			backend.onCompleteTranscription = onCompleteSpy;

			const connectPromise = backend.connect({ model: 'nova-2', language: undefined, prompt: undefined });
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			mockWsManager.mockWs.simulateMessage(JSON.stringify({
				type: 'Results',
				is_final: true,
				channel: {
					alternatives: [{ transcript: 'Hello', confidence: 0.98 }],
				},
			}));

			const msg: TranscriptionMessage = onCompleteSpy.mock.calls[0][0];
			expect(msg.language).toBeUndefined();
		});

		it('should skip empty transcripts', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const onInterimSpy = vi.fn();
			backend.onInterimTranscription = onInterimSpy;

			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const resultsMessage = {
				type: 'Results',
				is_final: false,
				channel: {
					alternatives: [
						{
							transcript: '',
							confidence: 0.5,
						},
					],
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(resultsMessage));

			expect(onInterimSpy).not.toHaveBeenCalled();
		});
	});

	describe('handleMessage - other types', () => {
		it('should handle UtteranceEnd messages', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const utteranceEndMessage = {
				type: 'UtteranceEnd',
			};

			// Should not throw
			mockWsManager.mockWs.simulateMessage(JSON.stringify(utteranceEndMessage));
		});

		it('should handle SpeechStarted messages', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const speechStartedMessage = {
				type: 'SpeechStarted',
			};

			// Should not throw
			mockWsManager.mockWs.simulateMessage(JSON.stringify(speechStartedMessage));
		});

		it('should handle Metadata messages', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const metadataMessage = {
				type: 'Metadata',
				request_id: 'test-id',
			};

			// Should not throw
			mockWsManager.mockWs.simulateMessage(JSON.stringify(metadataMessage));
		});

		it('should call onError for Error messages', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const onErrorSpy = vi.fn();
			backend.onError = onErrorSpy;

			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const errorMessage = {
				type: 'Error',
				message: 'Authentication failed',
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(errorMessage));

			expect(onErrorSpy).toHaveBeenCalledWith('api_error', 'Authentication failed');
		});
	});

	describe('close', () => {
		it('should send CloseStream and stop KeepAlive timer', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			mockWsManager.mockWs.clearSentMessages();

			backend.close();

			// Run any pending timers (for the close operation)
			vi.runAllTimers();

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			expect(sentMessages.length).toBe(1);

			const closeStreamMessage = JSON.parse(sentMessages[0]);
			expect(closeStreamMessage.type).toBe('CloseStream');

			expect(mockWsManager.mockWs.readyState).toBe(MockWebSocket.CLOSED);
			expect(backend.getStatus()).toBe('closed');

			// Verify KeepAlive timer is stopped
			mockWsManager.mockWs.clearSentMessages();
			vi.advanceTimersByTime(10000);
			expect(mockWsManager.mockWs.getSentMessages().length).toBe(0);
		});

		it('should be safe to call multiple times', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			backend.close();
			backend.close();
			backend.close();

			expect(backend.getStatus()).toBe('closed');
		});
	});

	describe('getStatus', () => {
		it('should return pending before connection', () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			expect(backend.getStatus()).toBe('pending');
		});

		it('should return connected after successful connection', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(backend.getStatus()).toBe('connected');
		});

		it('should return closed after error', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateError(new Error('Connection failed'));

			await expect(connectPromise).rejects.toThrow();
			expect(backend.getStatus()).toBe('closed');
		});

		it('should return closed after close', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: undefined,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			backend.close();

			expect(backend.getStatus()).toBe('closed');
		});
	});

	describe('getDesiredAudioFormat', () => {
		it('should return l16/24000 when DEEPGRAM_ENCODING=linear16', () => {
			(config.deepgram as any).encoding = 'linear16';
			try {
				const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
				expect(backend.getDesiredAudioFormat({ encoding: 'l16' })).toEqual({ encoding: 'l16', sampleRate: 24000 });
			} finally {
				(config.deepgram as any).encoding = 'opus';
			}
		});

		it('should return l16/24000 for opus input when DEEPGRAM_ENCODING=linear16', () => {
			(config.deepgram as any).encoding = 'linear16';
			try {
				const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
				expect(backend.getDesiredAudioFormat({ encoding: 'opus', sampleRate: 48000 })).toEqual({ encoding: 'l16', sampleRate: 24000 });
			} finally {
				(config.deepgram as any).encoding = 'opus';
			}
		});

		it('should pass through opus input when DEEPGRAM_ENCODING=opus (default)', () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const input: AudioFormat = { encoding: 'opus', sampleRate: 48000 };
			expect(backend.getDesiredAudioFormat(input)).toEqual({ encoding: 'opus', sampleRate: 48000 });
		});

		it('should pass through ogg input when DEEPGRAM_ENCODING=opus (default)', () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const input: AudioFormat = { encoding: 'ogg' };
			expect(backend.getDesiredAudioFormat(input)).toEqual({ encoding: 'ogg' });
		});

		it('should return a copy of inputFormat, not the same reference', () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const input: AudioFormat = { encoding: 'opus', sampleRate: 48000 };
			const result = backend.getDesiredAudioFormat(input);
			expect(result).toEqual(input);
			expect(result).not.toBe(input);
		});
	});

	describe('handleMessage - diarization', () => {
		async function connectBackend(diarize: boolean) {
			(config.deepgram as any).diarize = diarize;
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const onCompleteSpy = vi.fn();
			const onInterimSpy = vi.fn();
			backend.onCompleteTranscription = onCompleteSpy;
			backend.onInterimTranscription = onInterimSpy;
			const connectPromise = backend.connect({ model: 'nova-2', language: undefined, prompt: undefined });
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;
			return { backend, onCompleteSpy, onInterimSpy };
		}

		afterEach(() => {
			(config.deepgram as any).diarize = false;
		});

		it('should emit one message per speaker segment for multi-speaker result', async () => {
			const { onCompleteSpy } = await connectBackend(true);

			const resultsMessage = {
				type: 'Results',
				is_final: true,
				channel: {
					alternatives: [
						{
							transcript: 'Hello world yes indeed',
							confidence: 0.97,
							words: [
								{ word: 'Hello', punctuated_word: 'Hello', confidence: 0.99, speaker: 0 },
								{ word: 'world', punctuated_word: 'world,', confidence: 0.98, speaker: 0 },
								{ word: 'yes', punctuated_word: 'yes', confidence: 0.95, speaker: 1 },
								{ word: 'indeed', punctuated_word: 'indeed.', confidence: 0.96, speaker: 1 },
							],
						},
					],
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(resultsMessage));

			expect(onCompleteSpy).toHaveBeenCalledTimes(2);

			const msg0: TranscriptionMessage = onCompleteSpy.mock.calls[0][0];
			expect(msg0.speaker).toBe(0);
			expect(msg0.transcript[0].text).toBe('Hello world,');
			expect(msg0.is_interim).toBe(false);

			const msg1: TranscriptionMessage = onCompleteSpy.mock.calls[1][0];
			expect(msg1.speaker).toBe(1);
			expect(msg1.transcript[0].text).toBe('yes indeed.');
			expect(msg1.is_interim).toBe(false);
		});

		it('should emit one message with speaker 0 when all words have the same speaker', async () => {
			const { onCompleteSpy } = await connectBackend(true);

			const resultsMessage = {
				type: 'Results',
				is_final: true,
				channel: {
					alternatives: [
						{
							transcript: 'Hello world',
							confidence: 0.97,
							words: [
								{ word: 'Hello', punctuated_word: 'Hello', confidence: 0.99, speaker: 0 },
								{ word: 'world', punctuated_word: 'world.', confidence: 0.98, speaker: 0 },
							],
						},
					],
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(resultsMessage));

			expect(onCompleteSpy).toHaveBeenCalledTimes(1);
			const msg: TranscriptionMessage = onCompleteSpy.mock.calls[0][0];
			expect(msg.speaker).toBe(0);
			expect(msg.transcript[0].text).toBe('Hello world.');
		});

		it('should emit interim messages per speaker when is_final=false', async () => {
			const { onInterimSpy } = await connectBackend(true);

			const resultsMessage = {
				type: 'Results',
				is_final: false,
				channel: {
					alternatives: [
						{
							transcript: 'Hello world',
							confidence: 0.9,
							words: [
								{ word: 'Hello', confidence: 0.9, speaker: 0 },
								{ word: 'world', confidence: 0.88, speaker: 1 },
							],
						},
					],
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(resultsMessage));

			expect(onInterimSpy).toHaveBeenCalledTimes(2);
			expect(onInterimSpy.mock.calls[0][0].speaker).toBe(0);
			expect(onInterimSpy.mock.calls[1][0].speaker).toBe(1);
			expect(onInterimSpy.mock.calls[0][0].is_interim).toBe(true);
		});

		it('should average word confidences per segment', async () => {
			const { onCompleteSpy } = await connectBackend(true);

			const resultsMessage = {
				type: 'Results',
				is_final: true,
				channel: {
					alternatives: [
						{
							transcript: 'Hello world',
							confidence: 0.9,
							words: [
								{ word: 'Hello', confidence: 0.8, speaker: 0 },
								{ word: 'world', confidence: 1.0, speaker: 0 },
							],
						},
					],
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(resultsMessage));

			expect(onCompleteSpy).toHaveBeenCalledTimes(1);
			expect(onCompleteSpy.mock.calls[0][0].transcript[0].confidence).toBeCloseTo(0.9);
		});

		it('should fall back to alternative.transcript when diarize=true but words array is absent', async () => {
			const { onCompleteSpy } = await connectBackend(true);

			const resultsMessage = {
				type: 'Results',
				is_final: true,
				channel: {
					alternatives: [
						{
							transcript: 'Hello world',
							confidence: 0.97,
						},
					],
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(resultsMessage));

			expect(onCompleteSpy).toHaveBeenCalledTimes(1);
			const msg: TranscriptionMessage = onCompleteSpy.mock.calls[0][0];
			expect(msg.transcript[0].text).toBe('Hello world');
			expect(msg.speaker).toBeUndefined();
		});

		it('should append language suffix to each speaker segment when diarize=true and includeLanguage=true', async () => {
			(config.deepgram as any).includeLanguage = true;
			const { onCompleteSpy } = await connectBackend(true);

			const resultsMessage = {
				type: 'Results',
				is_final: true,
				channel: {
					alternatives: [
						{
							transcript: 'Hello world yes indeed',
							confidence: 0.97,
							languages: ['en'],
							words: [
								{ word: 'Hello', punctuated_word: 'Hello', confidence: 0.99, speaker: 0 },
								{ word: 'world', punctuated_word: 'world,', confidence: 0.98, speaker: 0 },
								{ word: 'yes', punctuated_word: 'yes', confidence: 0.95, speaker: 1 },
								{ word: 'indeed', punctuated_word: 'indeed.', confidence: 0.96, speaker: 1 },
							],
						},
					],
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(resultsMessage));

			expect(onCompleteSpy).toHaveBeenCalledTimes(2);
			const msg0: TranscriptionMessage = onCompleteSpy.mock.calls[0][0];
			const msg1: TranscriptionMessage = onCompleteSpy.mock.calls[1][0];
			expect(msg0.transcript[0].text).toBe('Hello world, [en]');
			expect(msg0.speaker).toBe(0);
			expect(msg0.language).toBe('en');
			expect(msg1.transcript[0].text).toBe('yes indeed. [en]');
			expect(msg1.speaker).toBe(1);
			expect(msg1.language).toBe('en');

			(config.deepgram as any).includeLanguage = false;
		});

		it('should not append language suffix when diarize=true and includeLanguage=false', async () => {
			const { onCompleteSpy } = await connectBackend(true);

			const resultsMessage = {
				type: 'Results',
				is_final: true,
				channel: {
					alternatives: [
						{
							transcript: 'Hello yes',
							confidence: 0.97,
							languages: ['fr'],
							words: [
								{ word: 'Hello', punctuated_word: 'Hello', confidence: 0.99, speaker: 0 },
								{ word: 'yes', punctuated_word: 'yes.', confidence: 0.95, speaker: 1 },
							],
						},
					],
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(resultsMessage));

			expect(onCompleteSpy).toHaveBeenCalledTimes(2);
			expect(onCompleteSpy.mock.calls[0][0].transcript[0].text).toBe('Hello');
			expect(onCompleteSpy.mock.calls[0][0].language).toBe('fr');
			expect(onCompleteSpy.mock.calls[1][0].transcript[0].text).toBe('yes.');
			expect(onCompleteSpy.mock.calls[1][0].language).toBe('fr');
		});

		it('should not set speaker field when diarize=false even if words are present', async () => {
			const { onCompleteSpy } = await connectBackend(false);

			const resultsMessage = {
				type: 'Results',
				is_final: true,
				channel: {
					alternatives: [
						{
							transcript: 'Hello world',
							confidence: 0.97,
							words: [
								{ word: 'Hello', confidence: 0.99, speaker: 0 },
								{ word: 'world', confidence: 0.98, speaker: 1 },
							],
						},
					],
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(resultsMessage));

			expect(onCompleteSpy).toHaveBeenCalledTimes(1);
			const msg: TranscriptionMessage = onCompleteSpy.mock.calls[0][0];
			expect(msg.transcript[0].text).toBe('Hello world');
			expect(msg.speaker).toBeUndefined();
		});
	});

	describe('connect with raw-passthrough format', () => {
		it('should omit encoding and sample_rate params for containerised ogg input', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			backend.getDesiredAudioFormat({ encoding: 'ogg' });

			const backendConfig: BackendConfig = { model: 'nova-2', language: undefined, prompt: undefined };
			const connectPromise = backend.connect(backendConfig);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(mockWsManager.mockWs.url).not.toContain('encoding=');
			expect(mockWsManager.mockWs.url).not.toContain('sample_rate=');
		});

		it('should include encoding=opus and sample_rate for raw opus input', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			backend.getDesiredAudioFormat({ encoding: 'opus', sampleRate: 48000 });

			const backendConfig: BackendConfig = { model: 'nova-2', language: undefined, prompt: undefined };
			const connectPromise = backend.connect(backendConfig);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(mockWsManager.mockWs.url).toContain('encoding=opus');
			expect(mockWsManager.mockWs.url).toContain('sample_rate=48000');
		});
	});
});
