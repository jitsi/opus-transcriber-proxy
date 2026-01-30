/**
 * Tests for OpenAIBackend module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIBackend } from '../../../src/backends/OpenAIBackend';
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
		openai: {
			apiKey: 'test-api-key',
			model: 'gpt-4o-transcribe',
		},
	},
}));

// Mock utils
vi.mock('../../../src/utils', () => ({
	getTurnDetectionConfig: vi.fn(() => ({
		type: 'server_vad',
		threshold: 0.5,
		prefix_padding_ms: 300,
		silence_duration_ms: 300,
	})),
}));

describe('OpenAIBackend', () => {
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
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });

			expect(backend).toBeDefined();
			expect(backend.getStatus()).toBe('pending');
		});
	});

	describe('connect', () => {
		it('should connect to OpenAI WebSocket with correct URL and protocol', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);

			// Simulate WebSocket opening
			mockWsManager.mockWs.simulateOpen();

			await connectPromise;

			expect(mockWsManager.mockWs.url).toBe('wss://api.openai.com/v1/realtime?intent=transcription');
			expect(mockWsManager.mockWs.protocols).toEqual(['realtime', 'openai-insecure-api-key.test-api-key']);
		});

		it('should send session.update on connection', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			expect(sentMessages.length).toBe(1);

			const sessionUpdate = JSON.parse(sentMessages[0]);
			expect(sessionUpdate.type).toBe('session.update');
			expect(sessionUpdate.session.type).toBe('transcription');
			expect(sessionUpdate.session.audio.input.format).toEqual({
				type: 'audio/pcm',
				rate: 24000,
			});
		});

		it('should include language in session config when provided', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: 'en-US',
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			const sessionUpdate = JSON.parse(sentMessages[0]);
			expect(sessionUpdate.session.audio.input.transcription.language).toBe('en-US');
		});

		it('should include prompt in session config when provided', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: 'Custom transcription prompt',
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			const sessionUpdate = JSON.parse(sentMessages[0]);
			expect(sessionUpdate.session.audio.input.transcription.prompt).toBe('Custom transcription prompt');
		});

		it('should set status to connected on successful connection', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
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
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateError(new Error('Connection failed'));

			await expect(connectPromise).rejects.toThrow('Connection failed');
			// Status becomes 'closed' after error handler calls close()
			expect(backend.getStatus()).toBe('closed');
		});

		it('should call onError callback on WebSocket error', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const onErrorSpy = vi.fn();
			backend.onError = onErrorSpy;

			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateError(new Error('Connection failed'));

			await expect(connectPromise).rejects.toThrow();
			expect(onErrorSpy).toHaveBeenCalledWith('websocket_error', 'WebSocket connection error');
		});

		it('should call onClosed callback on WebSocket close', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const onClosedSpy = vi.fn();
			backend.onClosed = onClosedSpy;

			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			mockWsManager.mockWs.simulateClose(1000, 'Normal closure', true);

			expect(onClosedSpy).toHaveBeenCalled();
			expect(backend.getStatus()).toBe('closed'); // Status becomes 'closed' after close()
		});
	});

	describe('sendAudio', () => {
		it('should send audio in input_audio_buffer.append format', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			// Clear session update message
			mockWsManager.mockWs.clearSentMessages();

			const audioBase64 = 'T3B1c0F1ZGlvRGF0YQ==';
			await backend.sendAudio(audioBase64);

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			expect(sentMessages.length).toBe(1);

			const audioMessage = JSON.parse(sentMessages[0]);
			expect(audioMessage.type).toBe('input_audio_buffer.append');
			expect(audioMessage.audio).toBe(audioBase64);
		});

		it('should throw error when not connected', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });

			await expect(backend.sendAudio('T3B1c0F1ZGlvRGF0YQ==')).rejects.toThrow(
				'Cannot send audio: connection not ready (status: pending)',
			);
		});
	});

	describe('forceCommit', () => {
		it('should send input_audio_buffer.commit message', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
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

			const commitMessage = JSON.parse(sentMessages[0]);
			expect(commitMessage.type).toBe('input_audio_buffer.commit');
		});

		it('should not send commit when not connected', () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });

			backend.forceCommit();

			// Should not throw or send any messages (no WebSocket created yet)
		});
	});

	describe('updatePrompt', () => {
		it('should update prompt and resend session.update', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: 'Initial prompt',
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			mockWsManager.mockWs.clearSentMessages();

			backend.updatePrompt('Updated prompt');

			const sentMessages = mockWsManager.mockWs.getSentMessages();
			expect(sentMessages.length).toBe(1);

			const sessionUpdate = JSON.parse(sentMessages[0]);
			expect(sessionUpdate.type).toBe('session.update');
			expect(sessionUpdate.session.audio.input.transcription.prompt).toBe('Updated prompt');
		});

		it('should not update prompt when not connected', () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });

			backend.updatePrompt('New prompt');

			// Should not throw or send any messages (no WebSocket created yet)
		});
	});

	describe('handleMessage - transcription.delta', () => {
		it('should call onInterimTranscription for delta messages', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const onInterimSpy = vi.fn();
			backend.onInterimTranscription = onInterimSpy;

			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const deltaMessage = {
				type: 'conversation.item.input_audio_transcription.delta',
				delta: 'Hello ',
				item_id: 'item_123',
				logprobs: [{ logprob: -0.5 }],
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(deltaMessage));

			expect(onInterimSpy).toHaveBeenCalledTimes(1);
			const transcription: TranscriptionMessage = onInterimSpy.mock.calls[0][0];
			expect(transcription.transcript[0].text).toBe('Hello ');
			expect(transcription.is_interim).toBe(true);
			expect(transcription.message_id).toBe('item_123');
			expect(transcription.participant).toEqual({ id: 'participant-1' });
		});

		it('should include confidence from logprobs', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const onInterimSpy = vi.fn();
			backend.onInterimTranscription = onInterimSpy;

			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const deltaMessage = {
				type: 'conversation.item.input_audio_transcription.delta',
				delta: 'world',
				item_id: 'item_456',
				logprobs: [{ logprob: -0.1 }],
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(deltaMessage));

			const transcription: TranscriptionMessage = onInterimSpy.mock.calls[0][0];
			expect(transcription.transcript[0].confidence).toBeCloseTo(Math.exp(-0.1), 5);
		});
	});

	describe('handleMessage - transcription.completed', () => {
		it('should call onCompleteTranscription for completed messages', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const onCompleteSpy = vi.fn();
			backend.onCompleteTranscription = onCompleteSpy;

			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const completedMessage = {
				type: 'conversation.item.input_audio_transcription.completed',
				transcript: 'Hello world',
				item_id: 'item_789',
				logprobs: [{ logprob: -0.2 }],
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(completedMessage));

			expect(onCompleteSpy).toHaveBeenCalledTimes(1);
			const transcription: TranscriptionMessage = onCompleteSpy.mock.calls[0][0];
			expect(transcription.transcript[0].text).toBe('Hello world');
			expect(transcription.is_interim).toBe(false);
			expect(transcription.message_id).toBe('item_789');
		});

		it('should use timestamp from previous delta if available', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const onInterimSpy = vi.fn();
			const onCompleteSpy = vi.fn();
			backend.onInterimTranscription = onInterimSpy;
			backend.onCompleteTranscription = onCompleteSpy;

			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			// Send delta first
			const deltaMessage = {
				type: 'conversation.item.input_audio_transcription.delta',
				delta: 'Hello',
				item_id: 'item_123',
			};
			mockWsManager.mockWs.simulateMessage(JSON.stringify(deltaMessage));

			const deltaTimestamp = onInterimSpy.mock.calls[0][0].timestamp;

			// Send completed
			const completedMessage = {
				type: 'conversation.item.input_audio_transcription.completed',
				transcript: 'Hello',
				item_id: 'item_123',
			};
			mockWsManager.mockWs.simulateMessage(JSON.stringify(completedMessage));

			const completeTimestamp = onCompleteSpy.mock.calls[0][0].timestamp;
			expect(completeTimestamp).toBe(deltaTimestamp);
		});
	});

	describe('handleMessage - error cases', () => {
		it('should handle transcription.failed messages', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const failedMessage = {
				type: 'conversation.item.input_audio_transcription.failed',
				item_id: 'item_fail',
			};

			// Should not throw, just log
			mockWsManager.mockWs.simulateMessage(JSON.stringify(failedMessage));
		});

		it('should call onError for error messages', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const onErrorSpy = vi.fn();
			backend.onError = onErrorSpy;

			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const errorMessage = {
				type: 'error',
				error: {
					type: 'invalid_request_error',
					message: 'Invalid request',
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(errorMessage));

			expect(onErrorSpy).toHaveBeenCalledWith('api_error', 'Invalid request');
			expect(backend.getStatus()).toBe('closed');
		});

		it('should ignore empty buffer commit errors', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const onErrorSpy = vi.fn();
			backend.onError = onErrorSpy;

			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const errorMessage = {
				type: 'error',
				error: {
					type: 'invalid_request_error',
					code: 'input_audio_buffer_commit_empty',
					message: 'Cannot commit empty audio buffer',
				},
			};

			mockWsManager.mockWs.simulateMessage(JSON.stringify(errorMessage));

			expect(onErrorSpy).not.toHaveBeenCalled();
			expect(backend.getStatus()).toBe('connected'); // Still connected
		});
	});

	describe('handleMessage - informational messages', () => {
		it('should handle session.created messages', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const sessionCreatedMessage = {
				type: 'session.created',
				session: { id: 'session_123' },
			};

			// Should not throw
			mockWsManager.mockWs.simulateMessage(JSON.stringify(sessionCreatedMessage));
		});

		it('should handle session.updated messages', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const sessionUpdatedMessage = {
				type: 'session.updated',
				session: { id: 'session_123' },
			};

			// Should not throw
			mockWsManager.mockWs.simulateMessage(JSON.stringify(sessionUpdatedMessage));
		});

		it('should silently ignore expected message types', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			const messageTypes = [
				'input_audio_buffer.committed',
				'input_audio_buffer.speech_started',
				'input_audio_buffer.speech_stopped',
				'conversation.item.added',
				'conversation.item.done',
			];

			for (const type of messageTypes) {
				mockWsManager.mockWs.simulateMessage(JSON.stringify({ type }));
			}

			// Should not throw or log warnings
		});
	});

	describe('close', () => {
		it('should close WebSocket connection', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			backend.close();

			// Wait for close to complete (setImmediate in mock)
			await new Promise((resolve) => setImmediate(resolve));

			expect(mockWsManager.mockWs.readyState).toBe(MockWebSocket.CLOSED);
			expect(backend.getStatus()).toBe('closed');
		});

		it('should be safe to call multiple times', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
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
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			expect(backend.getStatus()).toBe('pending');
		});

		it('should return connected after successful connection', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateOpen();
			await connectPromise;

			expect(backend.getStatus()).toBe('connected');
		});

		it('should return failed after error', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
				language: null,
				prompt: undefined,
			};

			const connectPromise = backend.connect(config);
			mockWsManager.mockWs.simulateError(new Error('Connection failed'));

			await expect(connectPromise).rejects.toThrow();
			// Status becomes 'closed' after error handler calls close()
			expect(backend.getStatus()).toBe('closed');
		});

		it('should return closed after close', async () => {
			const backend = new OpenAIBackend('test-tag', { id: 'participant-1' });
			const config: BackendConfig = {
				model: 'gpt-4o-transcribe',
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
});
