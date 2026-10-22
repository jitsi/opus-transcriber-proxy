/**
 * Tests for MistralBackend module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MistralBackend } from '../../../src/backends/MistralBackend';
import type { BackendConfig } from '../../../src/backends/TranscriptionBackend';
import { writeMetric } from '../../../src/metrics';

// The last WsWebSocket instance created by the ws mock. Module scope so the
// (hoisted) vi.mock factory can reference it.
let lastWsInstance: any = null;

vi.mock('ws', () => {
	class MockWs {
		public readyState = 0; // CONNECTING
		public url: string;
		public options: any;
		private _sentMessages: any[] = [];
		private _listeners: Map<string, Set<Function>> = new Map();

		constructor(url: string, options?: any) {
			this.url = url;
			this.options = options;
			lastWsInstance = this;
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
			return this._sentMessages.map((m) => JSON.parse(m));
		}

		_trigger(event: string, data: any): void {
			this._listeners.get(event)?.forEach((fn) => fn(data));
		}

		simulateOpen(): void {
			this.readyState = 1;
			this._trigger('open', {});
		}
		simulateMessage(data: any): void {
			this._trigger('message', { data: JSON.stringify(data) });
		}
		simulateError(msg: string): void {
			this._trigger('error', { message: msg });
		}
		simulateClose(code = 1000, reason = '', wasClean = true): void {
			this.readyState = 3;
			this._trigger('close', { code, reason, wasClean });
		}
	}

	return { default: MockWs };
});

vi.mock('../../../src/logger', () => ({
	default: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../src/metrics', () => ({
	writeMetric: vi.fn(),
}));

vi.mock('../../../src/config', () => ({
	config: {
		mistral: {
			apiKey: 'test-mistral-key',
			model: 'voxtral-mini-transcribe-realtime-3',
		},
	},
}));

const participantInfo = { id: 'participant-1' };
const backendConfig: BackendConfig = { language: undefined, prompt: undefined, model: 'voxtral-test-model' };

async function connectBackend(cfg: BackendConfig = backendConfig): Promise<{ backend: MistralBackend; ws: any }> {
	const backend = new MistralBackend('tag-1', participantInfo);
	const connectPromise = backend.connect(cfg);
	const ws = lastWsInstance;
	ws.simulateOpen();
	await connectPromise;
	return { backend, ws };
}

function delta(ws: any, text: string): void {
	ws.simulateMessage({ type: 'transcription.text.delta', text });
}

describe('MistralBackend', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastWsInstance = null;
	});

	describe('connect', () => {
		it('opens the realtime URL with the model and an Authorization header', async () => {
			const { backend, ws } = await connectBackend();

			expect(ws.url).toBe('wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-test-model');
			expect(ws.options.headers).toEqual({ Authorization: 'Bearer test-mistral-key' });
			expect(backend.getStatus()).toBe('connected');
		});

		it('falls back to the configured model', async () => {
			const { ws } = await connectBackend({ language: undefined });

			expect(ws.url).toContain('model=voxtral-mini-transcribe-realtime-3');
		});

		it('sends session.update with 16 kHz PCM on open', async () => {
			const { ws } = await connectBackend();

			expect(ws.getSentMessages()[0]).toEqual({
				type: 'session.update',
				session: { audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 } },
			});
		});

		it('sets the session language when one is configured', async () => {
			const { ws } = await connectBackend({ ...backendConfig, language: 'de' });

			expect(ws.getSentMessages()[0].session.language).toBe('de');
		});

		it('rejects and reports an error when the socket fails before opening', async () => {
			const backend = new MistralBackend('tag-1', participantInfo);
			const onError = vi.fn();
			backend.onError = onError;
			const connectPromise = backend.connect(backendConfig);

			lastWsInstance.simulateError('boom');

			await expect(connectPromise).rejects.toThrow('WebSocket error: boom');
			expect(onError).toHaveBeenCalledWith('websocket_error', 'WebSocket connection error');
			expect(backend.getStatus()).toBe('closed');
		});
	});

	describe('audio', () => {
		it('requests 16 kHz PCM', () => {
			const backend = new MistralBackend('tag-1', participantInfo);

			expect(backend.getDesiredAudioFormat({ encoding: 'opus', sampleRate: 48000 })).toEqual({ encoding: 'l16', sampleRate: 16000 });
		});

		it('sends audio as input_audio.append', async () => {
			const { backend, ws } = await connectBackend();

			await backend.sendAudio('AAAA');

			expect(ws.getSentMessages()[1]).toEqual({ type: 'input_audio.append', audio: 'AAAA' });
		});

		it('refuses audio before the connection is open', async () => {
			const backend = new MistralBackend('tag-1', participantInfo);

			await expect(backend.sendAudio('AAAA')).rejects.toThrow('connection not ready');
		});

		it('sends input_audio.flush on forceCommit', async () => {
			const { backend, ws } = await connectBackend();

			backend.forceCommit();

			expect(ws.getSentMessages()[1]).toEqual({ type: 'input_audio.flush' });
		});
	});

	describe('transcription', () => {
		it('emits the text collected so far as an interim', async () => {
			const { backend, ws } = await connectBackend();
			const onInterim = vi.fn();
			backend.onInterimTranscription = onInterim;

			delta(ws, 'The');
			delta(ws, ' Bir');
			delta(ws, 'ch');

			expect(onInterim).toHaveBeenCalledTimes(3);
			expect(onInterim.mock.calls[2][0].transcript[0].text).toBe('The Birch');
			expect(onInterim.mock.calls[2][0].is_interim).toBe(true);
		});
	});

	describe('errors and close', () => {
		it('reports the idle timeout as recoverable', async () => {
			const { backend, ws } = await connectBackend();
			const onError = vi.fn();
			backend.onError = onError;

			ws.simulateMessage({
				type: 'error',
				error: { message: 'Timeout waiting for response from streaming transcription.', code: 3804 },
			});

			expect(onError).toHaveBeenCalledWith('api_error', 'Timeout waiting for response from streaming transcription.', true);
			expect(writeMetric).toHaveBeenCalledWith(undefined, expect.objectContaining({ errorType: 'stream_timeout' }));
			expect(backend.getStatus()).toBe('closed');
		});

		it('reports other errors as fatal', async () => {
			const { backend, ws } = await connectBackend();
			const onError = vi.fn();
			backend.onError = onError;

			ws.simulateMessage({ type: 'error', error: { message: 'Invalid model', code: 1000 } });

			expect(onError).toHaveBeenCalledWith('api_error', 'Invalid model', false);
			expect(backend.getStatus()).toBe('closed');
		});

		it('notifies onClosed when the server closes the socket', async () => {
			const { backend, ws } = await connectBackend();
			const onClosed = vi.fn();
			backend.onClosed = onClosed;

			ws.simulateClose(1013, 'Upstream session closed', true);

			expect(onClosed).toHaveBeenCalledTimes(1);
			expect(backend.getStatus()).toBe('closed');
		});
	});
});
