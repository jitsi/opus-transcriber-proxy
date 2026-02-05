/**
 * Tests for GeminiBackend module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiBackend } from '../../../src/backends/GeminiBackend';
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
		gemini: {
			apiKey: 'test-gemini-key',
			model: 'gemini-2.0-flash-exp',
		},
	},
}));

describe('GeminiBackend', () => {
	let mockWsManager: { mockWs: MockWebSocketInstance; unmock: () => void };

	beforeEach(() => {
		vi.clearAllMocks();
		mockWsManager = mockGlobalWebSocket();
	});

	afterEach(() => {
		mockWsManager.unmock();
	});

	describe('Constructor', () => {
		it('should initialize with tag and participantInfo', () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });

			expect(backend).toBeDefined();
			expect(backend.getStatus()).toBe('pending');
		});
	});

	describe('connect', () => {
		it('should connect to Gemini WebSocket with API key in URL', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();

			// Send setupComplete message
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));

			await connectPromise;

			expect(mockWsManager.mockWs.url).toContain('wss://generativelanguage.googleapis.com/ws/');
			expect(mockWsManager.mockWs.url).toContain('key=test-gemini-key');
		});

		it('should send setup message on open', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: 'Custom transcription prompt',
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			expect(sentMessages.length).toBe(1);

			const setupMessage = JSON.parse(sentMessages[0]);
			expect(setupMessage.setup).toBeDefined();
			expect(setupMessage.setup.model).toBe('models/gemini-2.0-flash-exp');
			expect(setupMessage.setup.system_instruction.parts[0].text).toContain('Custom transcription prompt');
			expect(setupMessage.setup.generation_config.response_modalities).toEqual(['TEXT']);

			// Send setupComplete to resolve connect
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;
		});

		it('should include language in system instruction', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: 'es',
				prompt: 'Transcribe this',
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			const setupMessage = JSON.parse(sentMessages[0]);
			expect(setupMessage.setup.system_instruction.parts[0].text).toContain('The audio is in es');

			// Send setupComplete to resolve connect
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;
		});

		it('should wait for setupComplete before resolving', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();

			// Status should still be pending
			expect(backend.getStatus()).toBe('pending');

			// Send setupComplete
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));

			await connectPromise;

			// Now status should be connected
			expect(backend.getStatus()).toBe('connected');
		});

		it('should set status to connected after setupComplete', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			expect(backend.getStatus()).toBe('pending');

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();

			expect(backend.getStatus()).toBe('pending'); // Still pending after open

			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));

			await connectPromise;

			expect(backend.getStatus()).toBe('connected');
		});

		it('should reject on WebSocket error', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateError(new Error('Connection failed'));

			await expect(connectPromise).rejects.toThrow('Connection failed');
			expect(backend.getStatus()).toBe('failed');
		});

		it('should call onError callback on WebSocket error', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const onErrorSpy = vi.fn();
			backend.onError = onErrorSpy;

			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateError(new Error('Connection failed'));

			await expect(connectPromise).rejects.toThrow();
			expect(onErrorSpy).toHaveBeenCalledWith('websocket_error', 'WebSocket connection error');
		});

		it('should call onClosed callback on WebSocket close', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const onClosedSpy = vi.fn();
			backend.onClosed = onClosedSpy;

			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;

			mockWsManager.mockWs.simulateClose(1000, 'Normal closure', true);

			expect(onClosedSpy).toHaveBeenCalled();
			expect(backend.getStatus()).toBe('closed');
		});

		it('should reject with API error during setup', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();

			// Simulate API error before setupComplete
			mockWsManager.mockWs.simulateMessage(
				JSON.stringify({
					error: {
						message: 'Invalid API key',
					},
				}),
			);

			await expect(connectPromise).rejects.toThrow('Invalid API key');
		});
	});

	describe('sendAudio', () => {
		it('should send audio in realtime_input format', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;

			mockWsManager.mockWs.clearSentMessages();

			const audioBase64 = 'T3B1c0F1ZGlvRGF0YQ==';
			await backend.sendAudio(audioBase64);

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			expect(sentMessages.length).toBe(1);

			const audioMessage = JSON.parse(sentMessages[0]);
			expect(audioMessage.realtime_input).toBeDefined();
			expect(audioMessage.realtime_input.media_chunks).toHaveLength(1);
			expect(audioMessage.realtime_input.media_chunks[0].mime_type).toBe('audio/pcm;rate=16000');
			expect(audioMessage.realtime_input.media_chunks[0].data).toBe(audioBase64);
		});

		it('should throw error when not connected', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });

			await expect(backend.sendAudio('T3B1c0F1ZGlvRGF0YQ==')).rejects.toThrow(
				'Cannot send audio: connection not ready',
			);
		});

		it('should throw error when setupComplete not received', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			// Don't send setupComplete

			// Try to send audio before setupComplete
			await expect(backend.sendAudio('T3B1c0F1ZGlvRGF0YQ==')).rejects.toThrow(
				'Cannot send audio: connection not ready',
			);
		});
	});

	describe('forceCommit', () => {
		it('should be a no-op (no message sent)', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;

			mockWsManager.mockWs.clearSentMessages();

			backend.forceCommit();

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			expect(sentMessages.length).toBe(0);
		});
	});

	describe('updatePrompt', () => {
		it('should log warning (not supported)', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;

			mockWsManager.mockWs.clearSentMessages();

			backend.updatePrompt('New prompt');

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			expect(sentMessages.length).toBe(0);
		});
	});

	describe('handleMessage - serverContent', () => {
		it('should call onCompleteTranscription for text responses', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const onCompleteSpy = vi.fn();
			backend.onCompleteTranscription = onCompleteSpy;

			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;

			const serverContentMessage = {
				serverContent: {
					modelTurn: {
						parts: [
							{
								text: 'Hello world',
							},
						],
					},
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(serverContentMessage));

			expect(onCompleteSpy).toHaveBeenCalledTimes(1);
			const transcription: TranscriptionMessage = onCompleteSpy.mock.calls[0][0];
			expect(transcription.transcript[0].text).toBe('Hello world');
			expect(transcription.is_interim).toBe(false);
			expect(transcription.participant).toEqual({ id: 'participant-1' });
		});

		it('should handle multiple text parts', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const onCompleteSpy = vi.fn();
			backend.onCompleteTranscription = onCompleteSpy;

			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;

			const serverContentMessage = {
				serverContent: {
					modelTurn: {
						parts: [
							{
								text: 'First part',
							},
							{
								text: 'Second part',
							},
						],
					},
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(serverContentMessage));

			expect(onCompleteSpy).toHaveBeenCalledTimes(2);
			expect(onCompleteSpy.mock.calls[0][0].transcript[0].text).toBe('First part');
			expect(onCompleteSpy.mock.calls[1][0].transcript[0].text).toBe('Second part');
		});

		it('should skip empty text parts', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const onCompleteSpy = vi.fn();
			backend.onCompleteTranscription = onCompleteSpy;

			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;

			const serverContentMessage = {
				serverContent: {
					modelTurn: {
						parts: [
							{
								text: '   ',
							},
						],
					},
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(serverContentMessage));

			expect(onCompleteSpy).not.toHaveBeenCalled();
		});
	});

	describe('handleMessage - error', () => {
		it('should call onError for error messages', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const onErrorSpy = vi.fn();
			backend.onError = onErrorSpy;

			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;

			const errorMessage = {
				error: {
					message: 'Rate limit exceeded',
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(errorMessage));

			expect(onErrorSpy).toHaveBeenCalledWith('api_error', 'Rate limit exceeded');
		});
	});

	describe('close', () => {
		it('should close WebSocket connection and reset setupComplete', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;

			backend.close();

			// Run pending timers
			await new Promise((resolve) => setImmediate(resolve));

			expect(mockWsManager.mockWs.readyState).toBe(MockWebSocket.CLOSED);
			expect(backend.getStatus()).toBe('closed');

			// Verify sendAudio now fails due to setupComplete being reset
			await expect(backend.sendAudio('test')).rejects.toThrow('Cannot send audio: connection not ready');
		});

		it('should be safe to call multiple times', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;

			backend.close();
			backend.close();
			backend.close();

			expect(backend.getStatus()).toBe('closed');
		});
	});

	describe('getStatus', () => {
		it('should return pending before connection', () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			expect(backend.getStatus()).toBe('pending');
		});

		it('should return pending after open but before setupComplete', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();

			expect(backend.getStatus()).toBe('pending');
		});

		it('should return connected after setupComplete', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;

			expect(backend.getStatus()).toBe('connected');
		});

		it('should return closed after error', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateError(new Error('Connection failed'));

			await expect(connectPromise).rejects.toThrow();
			expect(backend.getStatus()).toBe('failed');
		});

		it('should return closed after close', async () => {
			const backend = new GeminiBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gemini-2.0-flash-exp',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			mockWsManager.mockWs.simulateMessage(JSON.stringify({ setupComplete: {} }));
			await connectPromise;

			backend.close();

			expect(backend.getStatus()).toBe('closed');
		});
	});
});
