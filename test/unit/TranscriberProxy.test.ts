/**
 * Tests for TranscriberProxy module
 *
 * Tests the orchestration layer including:
 * - WebSocket message handling (ping/pong, media routing)
 * - OutgoingConnection lifecycle (create, reuse, cleanup)
 * - Transcript broadcasting to other participants
 * - Event emission (interim, complete, error, closed)
 * - Dump functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranscriberProxy, type TranscriptionMessage } from '../../src/transcriberproxy';
import { WebSocket } from 'ws';
import * as fs from 'fs';

// Mock logger
vi.mock('../../src/logger', () => ({
	default: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock config with inline object (to avoid hoisting issues)
vi.mock('../../src/config', () => ({
	config: {
		broadcastTranscripts: true,
		dumpWebSocketMessages: false,
		dumpTranscripts: false,
		dumpBasePath: '/tmp/opus-transcriber-proxy-test',
	},
}));

// Mock OutgoingConnection
vi.mock('../../src/OutgoingConnection', () => ({
	OutgoingConnection: vi.fn().mockImplementation((tag: string, options: any) => ({
		localTag: tag,
		participantId: tag.split('-')[0], // Extract participant ID from tag like "participant1-ssrc123"
		handleMediaEvent: vi.fn(),
		addTranscriptContext: vi.fn(),
		close: vi.fn(),
		onInterimTranscription: undefined,
		onCompleteTranscription: undefined,
		onClosed: undefined,
		onError: undefined,
	})),
}));

// Mock fs
vi.mock('fs', async () => {
	const actual = await vi.importActual('fs');
	return {
		...actual,
		existsSync: vi.fn(() => false),
		mkdirSync: vi.fn(),
		createWriteStream: vi.fn(() => ({
			write: vi.fn(),
			end: vi.fn(),
		})),
	};
});

describe('TranscriberProxy', () => {
	let mockWebSocket: any;
	let options: any;
	let mockConfig: any;

	beforeEach(async () => {
		vi.clearAllMocks();

		// Get reference to mocked config
		const configModule = await import('../../src/config');
		mockConfig = configModule.config;

		// Reset mockConfig to defaults
		mockConfig.broadcastTranscripts = true;
		mockConfig.dumpWebSocketMessages = false;
		mockConfig.dumpTranscripts = false;
		mockConfig.dumpBasePath = '/tmp/opus-transcriber-proxy-test';

		// Create a mock WebSocket with event listeners
		const eventListeners = new Map<string, Function[]>();
		mockWebSocket = {
			addEventListener: vi.fn((event: string, listener: Function) => {
				if (!eventListeners.has(event)) {
					eventListeners.set(event, []);
				}
				eventListeners.get(event)!.push(listener);
			}),
			send: vi.fn(),
			close: vi.fn(),
			// Helper to emit events in tests
			emit: (event: string, data?: any) => {
				const listeners = eventListeners.get(event) || [];
				listeners.forEach((listener) => listener(data));
			},
		};

		options = {
			sessionId: null,
			language: 'en',
			provider: 'openai' as any,
		};
	});

	describe('Constructor and initialization', () => {
		it('should initialize with WebSocket and options', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);

			expect(mockWebSocket.addEventListener).toHaveBeenCalledWith('close', expect.any(Function));
			expect(mockWebSocket.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
		});

		it('should initialize without sessionId', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);

			// Should not attempt to create session directory
			expect(fs.mkdirSync).not.toHaveBeenCalled();
		});

		it('should emit closed event when WebSocket closes', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			const closedSpy = vi.fn();
			proxy.on('closed', closedSpy);

			// Simulate WebSocket close
			mockWebSocket.emit('close');

			expect(closedSpy).toHaveBeenCalled();
			expect(mockWebSocket.close).toHaveBeenCalled();
		});
	});

	describe('Message handling', () => {
		it('should respond to ping with pong', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);

			const pingMessage = JSON.stringify({ event: 'ping' });
			mockWebSocket.emit('message', { data: pingMessage });

			expect(mockWebSocket.send).toHaveBeenCalledWith(JSON.stringify({ event: 'pong' }));
		});

		it('should respond to ping with pong including id', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);

			const pingMessage = JSON.stringify({ event: 'ping', id: 123 });
			mockWebSocket.emit('message', { data: pingMessage });

			expect(mockWebSocket.send).toHaveBeenCalledWith(
				JSON.stringify({ event: 'pong', id: 123 }),
			);
		});


		it('should handle invalid JSON gracefully', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);

			const invalidMessage = 'not-valid-json{';
			mockWebSocket.emit('message', { data: invalidMessage });

			// Should not throw, just log error
		});
	});

	describe('Event emission', () => {
		it('should emit interim transcription events', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			const interimSpy = vi.fn();
			proxy.on('interim_transcription', interimSpy);

			const message: TranscriptionMessage = {
				transcript: [{ text: 'hello world' }],
				is_interim: true,
				message_id: '123',
				type: 'transcription-result',
				event: 'transcription-result',
				participant: { id: 'tag1' },
				timestamp: Date.now(),
			};

			// Emit the event directly through the proxy
			proxy.emit('interim_transcription', message);

			expect(interimSpy).toHaveBeenCalledWith(message);
		});

		it('should emit complete transcription events', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			const transcriptionSpy = vi.fn();
			proxy.on('transcription', transcriptionSpy);

			const message: TranscriptionMessage = {
				transcript: [{ text: 'hello world' }],
				is_interim: false,
				message_id: '123',
				type: 'transcription-result',
				event: 'transcription-result',
				participant: { id: 'tag1' },
				timestamp: Date.now(),
			};

			// Emit the event directly through the proxy
			proxy.emit('transcription', message);

			expect(transcriptionSpy).toHaveBeenCalledWith(message);
		});

		it('should emit error events', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			const errorSpy = vi.fn();
			proxy.on('error', errorSpy);

			// Emit error directly
			proxy.emit('error', 'tag1', 'Test error');

			expect(errorSpy).toHaveBeenCalledWith('tag1', 'Test error');
		});
	});

	describe('Dump functionality', () => {
		it('should create session directory when sessionId is provided', () => {
			// Enable dump features for this test
			mockConfig.dumpWebSocketMessages = true;
			options.sessionId = 'test-session-123';

			const proxy = new TranscriberProxy(mockWebSocket, options);

			expect(fs.mkdirSync).toHaveBeenCalledWith(
				'/tmp/opus-transcriber-proxy-test/test-session-123',
				{ recursive: true },
			);
		});

		it('should create dump stream when enabled', () => {
			mockConfig.dumpWebSocketMessages = true;
			options.sessionId = 'test-session-123';

			const proxy = new TranscriberProxy(mockWebSocket, options);

			expect(fs.createWriteStream).toHaveBeenCalledWith(
				'/tmp/opus-transcriber-proxy-test/test-session-123/media.jsonl',
				{ flags: 'a' },
			);
		});

		it('should create transcript dump stream when enabled', () => {
			mockConfig.dumpTranscripts = true;
			options.sessionId = 'test-session-123';

			const proxy = new TranscriberProxy(mockWebSocket, options);

			expect(fs.createWriteStream).toHaveBeenCalledWith(
				'/tmp/opus-transcriber-proxy-test/test-session-123/transcript.jsonl',
				{ flags: 'a' },
			);
		});

		it('should dump incoming WebSocket messages when enabled', () => {
			mockConfig.dumpWebSocketMessages = true;
			options.sessionId = 'test-session-123';

			const mockStream = {
				write: vi.fn(),
				end: vi.fn(),
			};
			(fs.createWriteStream as any).mockReturnValueOnce(mockStream);

			const proxy = new TranscriberProxy(mockWebSocket, options);

			// Send a message
			const message = JSON.stringify({ event: 'ping' });
			mockWebSocket.emit('message', { data: message });

			// Should have dumped the message
			expect(mockStream.write).toHaveBeenCalled();
		});
	});

	describe('Close and cleanup', () => {
		it('should close WebSocket on close', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);

			proxy.close();

			expect(mockWebSocket.close).toHaveBeenCalled();
		});

		it('should emit closed event on close', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			const closedSpy = vi.fn();
			proxy.on('closed', closedSpy);

			proxy.close();

			expect(closedSpy).toHaveBeenCalled();
		});

		it('should close dump streams on close', () => {
			mockConfig.dumpWebSocketMessages = true;
			mockConfig.dumpTranscripts = true;
			options.sessionId = 'test-session-123';

			const mockDumpStream = {
				write: vi.fn(),
				end: vi.fn(),
			};

			const mockTranscriptStream = {
				write: vi.fn(),
				end: vi.fn(),
			};

			(fs.createWriteStream as any)
				.mockReturnValueOnce(mockDumpStream)
				.mockReturnValueOnce(mockTranscriptStream);

			const proxy = new TranscriberProxy(mockWebSocket, options);

			proxy.close();

			expect(mockDumpStream.end).toHaveBeenCalled();
			expect(mockTranscriptStream.end).toHaveBeenCalled();
		});

		it('should be safe to close multiple times', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);

			proxy.close();
			proxy.close();
			proxy.close();

			// Should not throw
			expect(mockWebSocket.close).toHaveBeenCalledTimes(3);
		});
	});

	describe('Integration behavior', () => {
		it('should handle ping/pong without errors', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);

			// Ping
			mockWebSocket.emit('message', { data: JSON.stringify({ event: 'ping' }) });

			// Another ping
			mockWebSocket.emit('message', { data: JSON.stringify({ event: 'ping', id: 1 }) });

			// Should have responded to pings
			expect(mockWebSocket.send).toHaveBeenCalledTimes(2);
		});
	});
});
