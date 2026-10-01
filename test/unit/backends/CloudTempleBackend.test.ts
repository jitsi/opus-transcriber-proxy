/**
 * Tests for CloudTempleBackend module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudTempleBackend } from '../../../src/backends/CloudTempleBackend';
import type { BackendConfig } from '../../../src/backends/TranscriptionBackend';
import type { TranscriptionMessage } from '../../../src/transcriberproxy';

// Track every WsWebSocket instance created by the mock (one per connection — this
// backend opens a fresh one per utterance). Module-scoped so the hoisted vi.mock
// factory can reference it, and so tests can index into connection history.
const wsInstances: any[] = [];

vi.mock('ws', () => {
	const { EventEmitter } = require('node:events');

	class MockWs extends EventEmitter {
		public readyState = 0;
		public url: string;
		public options: any;
		private _sentMessages: any[] = [];
		private _listeners: Map<string, Set<Function>> = new Map();
		static OPEN = 1;
		static CLOSED = 3;

		constructor(url: string, options?: any) {
			super();
			this.url = url;
			this.options = options;
			wsInstances.push(this);
		}

		addEventListener(event: string, handler: Function): void {
			if (!this._listeners.has(event)) this._listeners.set(event, new Set());
			this._listeners.get(event)!.add(handler);
		}

		send(data: any): void {
			this._sentMessages.push(data);
		}
		close(): void {
			this.readyState = 3;
		}
		getSentMessages(): any[] {
			return [...this._sentMessages];
		}
		clearSentMessages(): void {
			this._sentMessages = [];
		}

		_trigger(event: string, data: any): void {
			this._listeners.get(event)?.forEach((fn) => fn(data));
		}

		simulateOpen(): void {
			this.readyState = 1;
			this._trigger('open', {});
		}
		simulateMessage(data: any): void {
			this._trigger('message', { data });
		}
		simulateError(msg: string): void {
			this._trigger('error', { message: msg });
		}
		simulateClose(code = 1000, reason = '', wasClean = true): void {
			this.readyState = 3;
			this._trigger('close', { code, reason, wasClean });
		}
		simulateUnexpectedResponse(status: number, body = ''): void {
			const req = { destroy: () => {} };
			const res = new EventEmitter() as any;
			res.statusCode = status;
			res.statusMessage = 'Error';
			this.emit('unexpected-response', req, res);
			setImmediate(() => {
				if (body) res.emit('data', body);
				res.emit('end');
			});
		}
	}

	return { default: MockWs };
});

function wsAt(index: number): any {
	const ws = wsInstances[index];
	if (!ws) throw new Error(`No ws instance at index ${index} (have ${wsInstances.length})`);
	return ws;
}

vi.mock('../../../src/logger', () => ({
	default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/metrics', () => ({
	writeMetric: vi.fn(),
}));

vi.mock('../../../src/config', () => ({
	config: {
		cloudtemple: {
			apiKey: 'test-ct-key',
			wsUrl: 'wss://api.ai.cloud-temple.com/v1/realtime',
			model: 'mistralai/Voxtral-Mini-4B-Realtime-2602',
		},
	},
}));

const basicConfig: BackendConfig = { model: undefined, language: undefined, prompt: undefined };

describe('CloudTempleBackend', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		wsInstances.length = 0;
	});

	afterEach(() => {
		// no-op — module mock state is reset via wsInstances.length = 0 above
	});

	describe('Constructor', () => {
		it('should initialize with tag and participantInfo, status pending', () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			expect(backend).toBeDefined();
			expect(backend.getStatus()).toBe('pending');
		});
	});

	describe('connect', () => {
		it('should open a WebSocket with Authorization header, no WS subprotocol', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const connectPromise = backend.connect(basicConfig);

			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await connectPromise;

			expect(wsAt(0).url).toBe('wss://api.ai.cloud-temple.com/v1/realtime');
			expect(wsAt(0).options).toEqual({ headers: { Authorization: 'Bearer test-ct-key' } });
		});

		it('should send a flat session.update (no nested session object) then an empty commit', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const connectPromise = backend.connect(basicConfig);

			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await connectPromise;

			const sent = wsAt(0).getSentMessages().map((m: string) => JSON.parse(m));
			expect(sent[0]).toEqual({ type: 'session.update', model: 'mistralai/Voxtral-Mini-4B-Realtime-2602' });
			expect(sent[1]).toEqual({ type: 'input_audio_buffer.commit' });
		});

		it('should use backendConfig.model over the configured default when provided', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const connectPromise = backend.connect({ ...basicConfig, model: 'custom-model' });

			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await connectPromise;

			const sent = JSON.parse(wsAt(0).getSentMessages()[0]);
			expect(sent.model).toBe('custom-model');
		});

		it('should resolve only on session.created, not on bare open', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const connectPromise = backend.connect(basicConfig);

			wsAt(0).simulateOpen();
			expect(backend.getStatus()).toBe('pending');

			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await connectPromise;
			expect(backend.getStatus()).toBe('connected');
		});

		it('should reject and fail on a handshake rejection (e.g. 401)', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const connectPromise = backend.connect(basicConfig);

			wsAt(0).simulateUnexpectedResponse(401, '{"error":"Token manquant"}');

			await expect(connectPromise).rejects.toThrow();
			expect(backend.getStatus()).toBe('failed');
		});
	});

	describe('sendAudio', () => {
		it('should send input_audio_buffer.append once connected', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const connectPromise = backend.connect(basicConfig);
			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await connectPromise;
			wsAt(0).clearSentMessages();

			await backend.sendAudio('T3B1cw==');

			const sent = JSON.parse(wsAt(0).getSentMessages()[0]);
			expect(sent).toEqual({ type: 'input_audio_buffer.append', audio: 'T3B1cw==' });
		});

		it('should lazily open a connection if none is active yet', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });

			const sendPromise = backend.sendAudio('T3B1cw==');
			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await sendPromise;

			expect(backend.getStatus()).toBe('connected');
			const sent = wsAt(0).getSentMessages().map((m: string) => JSON.parse(m));
			// session.update, empty commit, then the actual audio append
			expect(sent[2]).toEqual({ type: 'input_audio_buffer.append', audio: 'T3B1cw==' });
		});
	});

	describe('forceCommit', () => {
		it('should send a final:true commit when connected', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const connectPromise = backend.connect(basicConfig);
			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await connectPromise;
			wsAt(0).clearSentMessages();

			backend.forceCommit();

			const sent = JSON.parse(wsAt(0).getSentMessages()[0]);
			expect(sent).toEqual({ type: 'input_audio_buffer.commit', final: true });
		});

		it('should no-op when not connected', () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			expect(() => backend.forceCommit()).not.toThrow();
			expect(wsInstances.length).toBe(0);
		});
	});

	describe('transcription.delta / transcription.done', () => {
		it('should emit interim messages per delta and reassemble the full text on done', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const onInterim = vi.fn();
			const onComplete = vi.fn();
			backend.onInterimTranscription = onInterim;
			backend.onCompleteTranscription = onComplete;

			const connectPromise = backend.connect(basicConfig);
			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await connectPromise;

			wsAt(0).simulateMessage(JSON.stringify({ type: 'transcription.delta', delta: 'Bonjour' }));
			wsAt(0).simulateMessage(JSON.stringify({ type: 'transcription.delta', delta: '' })); // heartbeat, ignored
			wsAt(0).simulateMessage(JSON.stringify({ type: 'transcription.delta', delta: ' monde' }));

			expect(onInterim).toHaveBeenCalledTimes(2);
			expect((onInterim.mock.calls[0][0] as TranscriptionMessage).transcript[0].text).toBe('Bonjour');
			expect((onInterim.mock.calls[0][0] as TranscriptionMessage).is_interim).toBe(true);

			wsAt(0).simulateMessage(JSON.stringify({ type: 'transcription.done', usage: { total_tokens: 10 } }));

			expect(onComplete).toHaveBeenCalledTimes(1);
			const final: TranscriptionMessage = onComplete.mock.calls[0][0];
			expect(final.transcript[0].text).toBe('Bonjour monde');
			expect(final.is_interim).toBe(false);
		});

		it('should retire the connection after done — status back to pending, socket closed', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const connectPromise = backend.connect(basicConfig);
			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await connectPromise;

			wsAt(0).simulateMessage(JSON.stringify({ type: 'transcription.done', usage: {} }));

			expect(backend.getStatus()).toBe('pending');
			expect(wsAt(0).readyState).toBe(3); // CLOSED
		});

		it('should open a SECOND connection for the next utterance after a done', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const onComplete = vi.fn();
			backend.onCompleteTranscription = onComplete;

			// Turn 1
			const connectPromise = backend.connect(basicConfig);
			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await connectPromise;
			wsAt(0).simulateMessage(JSON.stringify({ type: 'transcription.delta', delta: 'Premiere phrase' }));
			backend.forceCommit();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'transcription.done', usage: {} }));
			expect(onComplete).toHaveBeenCalledTimes(1);
			expect(wsInstances.length).toBe(1);

			// Turn 2 — triggered lazily by the next sendAudio()
			const sendPromise = backend.sendAudio('c2Vjb25k');
			expect(wsInstances.length).toBe(2);
			wsAt(1).simulateOpen();
			wsAt(1).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-2' }));
			await sendPromise;

			wsAt(1).simulateMessage(JSON.stringify({ type: 'transcription.delta', delta: 'Deuxieme phrase' }));
			wsAt(1).simulateMessage(JSON.stringify({ type: 'transcription.done', usage: {} }));

			expect(onComplete).toHaveBeenCalledTimes(2);
			expect(onComplete.mock.calls[1][0].transcript[0].text).toBe('Deuxieme phrase');
			// The two turns got distinct message_ids
			expect(onComplete.mock.calls[0][0].message_id).not.toBe(onComplete.mock.calls[1][0].message_id);
		});

		it('should not emit onCompleteTranscription for an empty-transcript done (no speech)', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const onComplete = vi.fn();
			backend.onCompleteTranscription = onComplete;

			const connectPromise = backend.connect(basicConfig);
			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await connectPromise;

			wsAt(0).simulateMessage(JSON.stringify({ type: 'transcription.done', usage: {} }));

			expect(onComplete).not.toHaveBeenCalled();
		});
	});

	describe('error handling', () => {
		it('should call onError and reject for an error message before session.created', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const onError = vi.fn();
			backend.onError = onError;

			const connectPromise = backend.connect(basicConfig);
			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'error', error: 'Missing required field: model' }));

			await expect(connectPromise).rejects.toThrow('Missing required field: model');
			expect(onError).toHaveBeenCalledWith('api_error', 'Missing required field: model');
		});

		it('should not mark the backend failed on a late error from an already-retired socket', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const connectPromise = backend.connect(basicConfig);
			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await connectPromise;

			wsAt(0).simulateMessage(JSON.stringify({ type: 'transcription.done', usage: {} }));
			expect(backend.getStatus()).toBe('pending'); // retired cleanly

			// Teardown noise from the now-retired socket shouldn't flip backend status
			wsAt(0).simulateError('ECONNRESET during close');
			expect(backend.getStatus()).toBe('pending');
		});
	});

	describe('getDesiredAudioFormat', () => {
		it('should request 16kHz mono PCM, matching CloudTemple\'s reference client', () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			expect(backend.getDesiredAudioFormat({ encoding: 'opus' })).toEqual({ encoding: 'l16', sampleRate: 16000 });
		});
	});

	describe('close', () => {
		it('should close the active socket and set status to closed', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			const connectPromise = backend.connect(basicConfig);
			wsAt(0).simulateOpen();
			wsAt(0).simulateMessage(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
			await connectPromise;

			backend.close();

			expect(backend.getStatus()).toBe('closed');
			expect(wsAt(0).readyState).toBe(3);
		});

		it('should be safe to call multiple times', async () => {
			const backend = new CloudTempleBackend('test-tag', { id: 'participant-1' });
			backend.close();
			backend.close();
			expect(backend.getStatus()).toBe('closed');
		});
	});
});
