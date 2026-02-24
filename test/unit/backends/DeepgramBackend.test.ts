/**
 * Tests for DeepgramBackend module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepgramBackend } from '../../../src/backends/DeepgramBackend';
import { mockGlobalWebSocket, MockWebSocket, type MockWebSocketInstance } from '../../helpers/websocket-mock';
import type { BackendConfig } from '../../../src/backends/TranscriptionBackend';
import type { TranscriptionMessage } from '../../../src/transcriberproxy';

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
			encoding: 'linear16',
			model: 'nova-2',
			language: 'en',
			punctuate: true,
			diarize: false,
			includeLanguage: false,
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
			const config: BackendConfig = {
				model: 'nova-2',
				language: 'en',
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(mockWsManager.mockWs.url).toContain('wss://api.deepgram.com/v1/listen');
			expect(mockWsManager.mockWs.url).toContain('encoding=linear16');
			expect(mockWsManager.mockWs.url).toContain('sample_rate=24000');
			expect(mockWsManager.mockWs.url).toContain('channels=1');
			expect(mockWsManager.mockWs.url).toContain('interim_results=true');
			expect(mockWsManager.mockWs.protocols).toEqual(['token', 'test-deepgram-key']);
		});

		it('should include model in URL if provided', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2-general',
				language: null,
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
				language: null,
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
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(mockWsManager.mockWs.url).toContain('tag=test-tag-1');
			expect(mockWsManager.mockWs.url).toContain('tag=test-tag-2');
		});

		it('should start KeepAlive timer on connection', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'nova-2',
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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

		it('should skip empty transcripts', async () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			const onInterimSpy = vi.fn();
			backend.onInterimTranscription = onInterimSpy;

			const config: BackendConfig = {
				model: 'nova-2',
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
				language: null,
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
		it('should return L16 for linear16 encoding', () => {
			const backend = new DeepgramBackend('test-tag', { id: 'participant-1' });
			expect(backend.getDesiredAudioFormat({ encoding: 'L16' })).toEqual({ encoding: 'L16', sampleRate: 24000 });
		});
	});
});
