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
import { OutgoingConnection } from '../../src/OutgoingConnection';
import logger from '../../src/logger';

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
		dispatcher: {
			wsUrl: '',
			headers: {},
		},
	},
}));

// Mock OutgoingConnection
// NOTE: Use vi.fn(impl) (not vi.fn().mockImplementation(impl)) inside vi.mock() factories.
// When vi.fn().mockImplementation() is used in a vi.mock() factory, property assignments
// to `this` in the implementation do not persist on the created instance. Passing the
// implementation directly to vi.fn() avoids this issue.
vi.mock('../../src/OutgoingConnection', () => ({
	OutgoingConnection: vi.fn(function (this: any, tag: string, inputFormat: unknown) {
		this.localTag = tag;
		this.participantId = tag.split('-')[0]; // Extract participant ID from tag like "participant1-ssrc123"
		this.handleMediaEvent = vi.fn();
		this.addTranscriptContext = vi.fn();
		this.updateInputFormat = vi.fn();
		this.getInputFormat = vi.fn(() => inputFormat ?? { encoding: 'opus' });
		this.resetChunkTracking = vi.fn();
		this.close = vi.fn();
		this.onInterimTranscription = undefined;
		this.onCompleteTranscription = undefined;
		this.onClosed = undefined;
		this.onError = undefined;
	}),
}));

// Mock telemetry instruments (required by createConnection)
vi.mock('../../src/telemetry/instruments', () => ({
	getInstruments: vi.fn(() => ({
		participantsActive: { add: vi.fn() },
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
			encoding: 'opus' as any,
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

	describe('handleStartEvent', () => {
		const validStart = (tag: string, mediaFormat: object = { encoding: 'opus' }) => ({
			event: 'start',
			start: { tag, mediaFormat },
		});

		it('should create a new OutgoingConnection for a valid start event', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			vi.mocked(OutgoingConnection).mockClear();

			proxy.handleStartEvent(validStart('tag1'));

			expect(OutgoingConnection).toHaveBeenCalledTimes(1);
			expect(OutgoingConnection).toHaveBeenCalledWith('tag1', { encoding: 'opus' }, options);
		});

		it('should log an error and not create a connection when tag is missing', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			vi.mocked(OutgoingConnection).mockClear();

			proxy.handleStartEvent({ event: 'start', start: { mediaFormat: { encoding: 'opus' } } });

			expect(OutgoingConnection).not.toHaveBeenCalled();
			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
				expect.stringMatching(/no tag/),
			);
		});

		it('should log an error and not create a connection when mediaFormat is missing', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			vi.mocked(OutgoingConnection).mockClear();

			proxy.handleStartEvent({ event: 'start', start: { tag: 'tag1' } });

			expect(OutgoingConnection).not.toHaveBeenCalled();
			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
				expect.stringMatching(/Invalid mediaFormat/),
			);
		});

		it('should log an error for an invalid mediaFormat encoding', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			vi.mocked(OutgoingConnection).mockClear();

			proxy.handleStartEvent(validStart('tag1', { encoding: 'mp3' }));

			expect(OutgoingConnection).not.toHaveBeenCalled();
			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
				expect.stringMatching(/Invalid mediaFormat.*tag1/),
			);
		});

		it('should call updateInputFormat when a connection for that tag already exists', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);

			// First start event — creates the connection
			proxy.handleStartEvent(validStart('tag1', { encoding: 'opus' }));

			// Second start event with the same tag — should update, not recreate
			proxy.handleStartEvent(validStart('tag1', { encoding: 'l16', sampleRate: 16000 }));

			// Constructor called exactly once (for the first event only)
			expect(OutgoingConnection).toHaveBeenCalledTimes(1);

			// updateInputFormat called on the connection instance
			const conn = vi.mocked(OutgoingConnection).mock.instances[0];
			expect(conn.updateInputFormat).toHaveBeenCalledWith({
				encoding: 'l16',
				sampleRate: 16000,
			});
		});

		it('should create separate connections for different tags', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			vi.mocked(OutgoingConnection).mockClear();

			proxy.handleStartEvent(validStart('tag1'));
			proxy.handleStartEvent(validStart('tag2'));

			expect(OutgoingConnection).toHaveBeenCalledTimes(2);
		});

		it('should accept a start event with an L16 mediaFormat', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			vi.mocked(OutgoingConnection).mockClear();

			proxy.handleStartEvent(validStart('tag1', { encoding: 'l16', sampleRate: 16000 }));

			expect(OutgoingConnection).toHaveBeenCalledTimes(1);
			expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
		});

		it('should promote opus to ogg when URL encoding is ogg-opus', () => {
			const proxy = new TranscriberProxy(mockWebSocket, { ...options, encoding: 'ogg-opus' });
			vi.mocked(OutgoingConnection).mockClear();

			proxy.handleStartEvent(validStart('tag1', { encoding: 'opus' }));

			expect(OutgoingConnection).toHaveBeenCalledTimes(1);
			const [, format] = vi.mocked(OutgoingConnection).mock.calls[0];
			expect(format).toMatchObject({ encoding: 'ogg' });
		});

		it('should not promote opus when URL encoding is opus', () => {
			const proxy = new TranscriberProxy(mockWebSocket, { ...options, encoding: 'opus' });
			vi.mocked(OutgoingConnection).mockClear();

			proxy.handleStartEvent(validStart('tag1', { encoding: 'opus' }));

			expect(OutgoingConnection).toHaveBeenCalledTimes(1);
			const [, format] = vi.mocked(OutgoingConnection).mock.calls[0];
			expect(format).toMatchObject({ encoding: 'opus' });
		});
	});

	describe('handleMediaEvent', () => {
		it('should route the event to the correct OutgoingConnection', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			proxy.handleStartEvent({ event: 'start', start: { tag: 'tag1', mediaFormat: { encoding: 'opus' } } });
			const conn = vi.mocked(OutgoingConnection).mock.instances[0];

			const mediaEvent = { event: 'media', media: { tag: 'tag1', payload: 'abc=', chunk: 0, timestamp: 0 } };
			proxy.handleMediaEvent(mediaEvent);

			expect(conn.handleMediaEvent).toHaveBeenCalledWith(mediaEvent);
		});

		it('should create a connection and warn when a media event arrives for an unknown tag', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			vi.mocked(OutgoingConnection).mockClear();

			const mediaEvent = { event: 'media', media: { tag: 'unknown-tag', payload: 'abc=', chunk: 0, timestamp: 0 } };
			proxy.handleMediaEvent(mediaEvent);

			// Should warn, not error
			expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
				expect.stringMatching(/unknown-tag.*no prior start event/),
			);
			expect(vi.mocked(logger.error)).not.toHaveBeenCalled();

			// Should create a connection with default opus format
			expect(OutgoingConnection).toHaveBeenCalledWith(
				'unknown-tag',
				{ encoding: 'opus', sampleRate: 48000, channels: 2 },
				options,
			);

			// Should still route the event to the new connection
			const conn = vi.mocked(OutgoingConnection).mock.instances[0];
			expect(conn.handleMediaEvent).toHaveBeenCalledWith(mediaEvent);
		});

		it('should create a connection with ogg-opus format when that is the session encoding', () => {
			const oggOptions = { ...options, encoding: 'ogg-opus' as any };
			const proxy = new TranscriberProxy(mockWebSocket, oggOptions);
			vi.mocked(OutgoingConnection).mockClear();

			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: 'abc=', chunk: 0, timestamp: 0 } });

			expect(OutgoingConnection).toHaveBeenCalledWith(
				'tag1',
				{ encoding: 'ogg' },
				oggOptions,
			);
		});

		it('should not log an error for a known tag', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			proxy.handleStartEvent({ event: 'start', start: { tag: 'tag1', mediaFormat: { encoding: 'opus' } } });
			const errorCallsBefore = vi.mocked(logger.error).mock.calls.length;

			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: 'abc=', chunk: 0, timestamp: 0 } });

			// No new error calls after handling the media event
			expect(vi.mocked(logger.error).mock.calls.length).toBe(errorCallsBefore);
		});

		it('should drop media events for a tag whose start event was rejected', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			vi.mocked(OutgoingConnection).mockClear();

			// start event with invalid mediaFormat
			proxy.handleStartEvent({ event: 'start', start: { tag: 'tag1', mediaFormat: { encoding: 'mp3' } } });

			// media event for the same tag should be silently dropped
			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: 'abc=', chunk: 0, timestamp: 0 } });

			expect(OutgoingConnection).not.toHaveBeenCalled();
		});

		it('should allow a connection after a corrected start event for a previously rejected tag', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			vi.mocked(OutgoingConnection).mockClear();

			// First start event fails
			proxy.handleStartEvent({ event: 'start', start: { tag: 'tag1', mediaFormat: { encoding: 'mp3' } } });
			// Second start event succeeds — clears the failed flag
			proxy.handleStartEvent({ event: 'start', start: { tag: 'tag1', mediaFormat: { encoding: 'opus' } } });

			const mediaEvent = { event: 'media', media: { tag: 'tag1', payload: 'abc=', chunk: 0, timestamp: 0 } };
			proxy.handleMediaEvent(mediaEvent);

			const conn = vi.mocked(OutgoingConnection).mock.instances[0];
			expect(conn.handleMediaEvent).toHaveBeenCalledWith(mediaEvent);
		});
	});

	describe('diagnostic logging', () => {
		// 'T2dnUw==' is base64 for 'OggS' — the Ogg page capture pattern.
		const OGG_PAYLOAD = 'T2dnUw==';

		it('logs the first client frame sniff exactly once per tag', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			proxy.handleStartEvent({ event: 'start', start: { tag: 'tag1', mediaFormat: { encoding: 'opus' } } });
			vi.mocked(logger.info).mockClear();

			const media1 = { event: 'media', media: { tag: 'tag1', payload: OGG_PAYLOAD, chunk: 0, timestamp: 0 } };
			proxy.handleMediaEvent(media1);
			proxy.handleMediaEvent(media1);
			proxy.handleMediaEvent(media1);

			const sniffCalls = vi.mocked(logger.info).mock.calls.filter(([msg]) => typeof msg === 'string' && msg.startsWith('First client frame sniff:'));
			expect(sniffCalls).toHaveLength(1);
			const msg = sniffCalls[0][0] as string;
			expect(msg).toContain('tag=tag1');
			expect(msg).toContain('urlEncoding=opus');
			expect(msg).toContain(`startFormat='{"encoding":"opus"}'`);
			expect(msg).toContain('4f676753'); // 'OggS' in hex
			expect(msg).toContain(`<b64:${OGG_PAYLOAD.length} chars, first 4 decoded bytes=4f676753>`);
		});

		it('logs the first client frame sniff once per participant tag', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			proxy.handleStartEvent({ event: 'start', start: { tag: 'tag1', mediaFormat: { encoding: 'opus' } } });
			proxy.handleStartEvent({ event: 'start', start: { tag: 'tag2', mediaFormat: { encoding: 'opus' } } });
			vi.mocked(logger.info).mockClear();

			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: OGG_PAYLOAD, chunk: 0, timestamp: 0 } });
			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag2', payload: OGG_PAYLOAD, chunk: 0, timestamp: 0 } });
			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: OGG_PAYLOAD, chunk: 1, timestamp: 0 } });
			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag2', payload: OGG_PAYLOAD, chunk: 1, timestamp: 0 } });

			const sniffCalls = vi.mocked(logger.info).mock.calls.filter(([msg]) => typeof msg === 'string' && msg.startsWith('First client frame sniff:'));
			expect(sniffCalls).toHaveLength(2);
			expect(sniffCalls[0][0]).toContain('tag=tag1');
			expect(sniffCalls[1][0]).toContain('tag=tag2');
		});

		it('does not sniff or count empty-payload frames, and retries the sniff on the next real frame', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			proxy.handleStartEvent({ event: 'start', start: { tag: 'tag1', mediaFormat: { encoding: 'opus' } } });
			vi.mocked(logger.info).mockClear();

			// Missing payload → should not log, should not flip the flag
			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', chunk: 0, timestamp: 0 } });
			// Empty-string payload → same
			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: '', chunk: 1, timestamp: 0 } });

			let sniffCalls = vi.mocked(logger.info).mock.calls.filter(([msg]) => typeof msg === 'string' && msg.startsWith('First client frame sniff:'));
			expect(sniffCalls).toHaveLength(0);

			// Real audio frame → sniff now fires (not short-circuited by prior empty frames)
			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: OGG_PAYLOAD, chunk: 2, timestamp: 0 } });

			sniffCalls = vi.mocked(logger.info).mock.calls.filter(([msg]) => typeof msg === 'string' && msg.startsWith('First client frame sniff:'));
			expect(sniffCalls).toHaveLength(1);

			// Session-end summary reflects that only the real frame was counted as audio
			vi.mocked(logger.info).mockClear();
			proxy.close();
			const endCall = vi.mocked(logger.info).mock.calls.find(([msg]) => typeof msg === 'string' && msg.startsWith('Session ended:'));
			expect(endCall?.[0]).toContain('audioPackets=1');
		});

		it('fires the first-frame sniff again after a WebSocket reattach', () => {
			const proxy = new TranscriberProxy(mockWebSocket, options);
			proxy.handleStartEvent({ event: 'start', start: { tag: 'tag1', mediaFormat: { encoding: 'opus' } } });

			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: OGG_PAYLOAD, chunk: 0, timestamp: 0 } });
			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: OGG_PAYLOAD, chunk: 1, timestamp: 0 } });

			vi.mocked(logger.info).mockClear();
			proxy.reattachWebSocket({ addEventListener: vi.fn(), send: vi.fn(), close: vi.fn() } as any);

			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: OGG_PAYLOAD, chunk: 0, timestamp: 0 } });
			const sniffCalls = vi.mocked(logger.info).mock.calls.filter(([msg]) => typeof msg === 'string' && msg.startsWith('First client frame sniff:'));
			expect(sniffCalls).toHaveLength(1);
		});

		it('emits a session-end summary with audioPackets, interims, finals, and provider', () => {
			const proxy = new TranscriberProxy(mockWebSocket, { ...options, provider: 'deepgram' });
			proxy.handleStartEvent({ event: 'start', start: { tag: 'tag1', mediaFormat: { encoding: 'opus' } } });
			const conn = vi.mocked(OutgoingConnection).mock.instances[0] as any;

			// 3 audio packets
			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: OGG_PAYLOAD, chunk: 0, timestamp: 0 } });
			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: OGG_PAYLOAD, chunk: 1, timestamp: 0 } });
			proxy.handleMediaEvent({ event: 'media', media: { tag: 'tag1', payload: OGG_PAYLOAD, chunk: 2, timestamp: 0 } });

			// 2 interims + 1 final via the connection callbacks
			conn.onInterimTranscription({ transcript: [], is_interim: true, message_id: 'a', type: 'transcription-result', event: 'transcription-result', participant: { id: 'tag1' }, timestamp: 0 });
			conn.onInterimTranscription({ transcript: [], is_interim: true, message_id: 'b', type: 'transcription-result', event: 'transcription-result', participant: { id: 'tag1' }, timestamp: 0 });
			conn.onCompleteTranscription({ transcript: [{ text: 'hi' }], is_interim: false, message_id: 'c', type: 'transcription-result', event: 'transcription-result', participant: { id: 'tag1' }, timestamp: 0 });

			vi.mocked(logger.info).mockClear();
			proxy.close();

			const endCall = vi.mocked(logger.info).mock.calls.find(([msg]) => typeof msg === 'string' && msg.startsWith('Session ended:'));
			expect(endCall).toBeDefined();
			const endMsg = endCall![0] as string;
			expect(endMsg).toContain('provider=deepgram');
			expect(endMsg).toContain('audioPackets=3');
			expect(endMsg).toContain('interims=2');
			expect(endMsg).toContain('finals=1');
			expect(endMsg).toMatch(/durationSec=\d+\.\d/);
		});
	});
});
