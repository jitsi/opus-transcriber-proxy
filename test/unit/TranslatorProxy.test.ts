/**
 * Tests for TranslatorProxy (sources model, PR jitsi/jitsi-videobridge#2419).
 *
 * Covers:
 * - ping/pong
 * - `sources` opens one connection per (input source, language) request
 * - `sources` reconciliation: re-sending with fewer requests closes removed sessions
 * - request parsing splits the language off the LAST "."
 * - media keyed by the input (export) source name fans to every language for that source
 * - returned audio is tagged with the request name verbatim
 * - dev/replay path: start-translation + media lazily creates a connection tagged {src}.{lang}
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranslatorProxy } from '../../src/translatorproxy';
import { TranslatorConnection } from '../../src/TranslatorConnection';

vi.mock('../../src/logger', () => ({
	default: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock TranslatorConnection so no real OpenAI websocket / WASM codec is created. The mock
// records its (input source name, target language) and exposes handleMediaEvent/close spies.
vi.mock('../../src/TranslatorConnection', () => ({
	TranslatorConnection: vi.fn(function (this: any, inputSourceName: string, options: { targetLanguage: string }) {
		this.inputSourceName = inputSourceName;
		this.targetLanguage = options.targetLanguage;
		this.handleMediaEvent = vi.fn();
		this.close = vi.fn();
		this.onClosed = undefined;
		this.onError = undefined;
		this.onTranscription = undefined;
		this.onAudioFrame = undefined;
	}),
	normalizeTargetLanguage: vi.fn((lang: string) => {
		const norm = String(lang).toLowerCase();
		const supported = ['en', 'es', 'de', 'fr', 'ja', 'pt'];
		if (!supported.includes(norm)) {
			throw new Error(`Unsupported language: ${lang}`);
		}
		return norm;
	}),
}));

const MockedConnection = vi.mocked(TranslatorConnection);

// Minimal runtime stub. TranslatorConnection is mocked, so the proxy only touches logger and
// buildServerInfo (returning undefined skips the server-info send). Cast to satisfy the type.
const mockRuntime: any = {
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	buildServerInfo: () => undefined,
};

function mediaMessage(tag: string) {
	return JSON.stringify({
		event: 'media',
		media: { tag, chunk: 1, timestamp: 1000, payload: 'AAAA' },
	});
}

function sourcesMessage(exports: string[], requests: string[]) {
	return JSON.stringify({ event: 'sources', exports, requests });
}

/** Constructor args for every created connection: [inputSourceName, targetLanguage]. */
function createdPairs(): Array<[string, string]> {
	return MockedConnection.mock.calls.map((c) => [c[0] as string, (c[1] as any).targetLanguage]);
}

describe('TranslatorProxy (sources model)', () => {
	let mockWebSocket: any;

	beforeEach(() => {
		vi.clearAllMocks();
		const eventListeners = new Map<string, Function[]>();
		mockWebSocket = {
			OPEN: 1,
			readyState: 1,
			addEventListener: vi.fn((event: string, listener: Function) => {
				if (!eventListeners.has(event)) {
					eventListeners.set(event, []);
				}
				eventListeners.get(event)!.push(listener);
			}),
			send: vi.fn(),
			close: vi.fn(),
			emit: (event: string, data?: any) => {
				(eventListeners.get(event) || []).forEach((listener) => listener(data));
			},
		};
	});

	it('responds to ping with pong (preserving id)', () => {
		new TranslatorProxy(mockWebSocket, {}, mockRuntime);
		mockWebSocket.emit('message', { data: JSON.stringify({ event: 'ping', id: 7 }) });
		expect(mockWebSocket.send).toHaveBeenCalledWith(JSON.stringify({ event: 'pong', id: 7 }));
	});

	it('opens one connection per request, keyed by input source name + language', () => {
		new TranslatorProxy(mockWebSocket, {}, mockRuntime);
		mockWebSocket.emit('message', {
			data: sourcesMessage(['523834112-a0'], ['523834112-a0.en', '523834112-a0.de']),
		});

		expect(MockedConnection).toHaveBeenCalledTimes(2);
		expect(createdPairs().sort()).toEqual([
			['523834112-a0', 'de'],
			['523834112-a0', 'en'],
		]);
	});

	it('parses the language from the LAST dot, preserving the input source name', () => {
		new TranslatorProxy(mockWebSocket, {}, mockRuntime);
		mockWebSocket.emit('message', { data: sourcesMessage([], ['523834112-a0.en']) });

		expect(MockedConnection).toHaveBeenCalledWith('523834112-a0', { targetLanguage: 'en' }, mockRuntime);
	});

	it('fans media (keyed by input source name) to every language for that source', () => {
		new TranslatorProxy(mockWebSocket, {}, mockRuntime);
		mockWebSocket.emit('message', {
			data: sourcesMessage(['523834112-a0'], ['523834112-a0.en', '523834112-a0.de']),
		});
		mockWebSocket.emit('message', { data: mediaMessage('523834112-a0') });

		MockedConnection.mock.instances.forEach((inst) => {
			expect((inst as any).handleMediaEvent).toHaveBeenCalledTimes(1);
		});
	});

	it('ignores media for a source with no requested translations', () => {
		new TranslatorProxy(mockWebSocket, {}, mockRuntime);
		mockWebSocket.emit('message', { data: sourcesMessage(['523834112-a0'], ['523834112-a0.en']) });
		mockWebSocket.emit('message', { data: mediaMessage('other-a0') });

		// Only the one requested connection exists, and it didn't receive the unrelated media.
		expect(MockedConnection).toHaveBeenCalledTimes(1);
		expect((MockedConnection.mock.instances[0] as any).handleMediaEvent).not.toHaveBeenCalled();
	});

	it('reconciles: re-sending sources with fewer requests closes removed sessions', () => {
		new TranslatorProxy(mockWebSocket, {}, mockRuntime);
		mockWebSocket.emit('message', {
			data: sourcesMessage(['523834112-a0'], ['523834112-a0.en', '523834112-a0.de']),
		});
		const [enConn, deConn] = MockedConnection.mock.instances;

		// Drop the German request.
		mockWebSocket.emit('message', { data: sourcesMessage(['523834112-a0'], ['523834112-a0.en']) });

		const closedSet = new Set(
			MockedConnection.mock.instances.filter((i) => (i as any).close.mock.calls.length > 0).map((i) => (i as any).targetLanguage),
		);
		expect(closedSet).toEqual(new Set(['de']));
		// No new connections were created for the still-requested English session.
		expect(MockedConnection).toHaveBeenCalledTimes(2);
		void enConn;
		void deConn;
	});

	it('reconciles: an empty requests list closes everything', () => {
		new TranslatorProxy(mockWebSocket, {}, mockRuntime);
		mockWebSocket.emit('message', { data: sourcesMessage(['523834112-a0'], ['523834112-a0.en']) });
		const conn = MockedConnection.mock.instances[0] as any;

		mockWebSocket.emit('message', { data: sourcesMessage([], []) });
		expect(conn.close).toHaveBeenCalledTimes(1);
	});

	it('tags returned audio with the request name verbatim', () => {
		const proxy = new TranslatorProxy(mockWebSocket, {}, mockRuntime);
		mockWebSocket.emit('message', { data: sourcesMessage(['523834112-a0'], ['523834112-a0.en']) });
		const conn = MockedConnection.mock.instances[0] as any;

		const frames: any[] = [];
		proxy.on('audioFrame', (data) => frames.push(data));
		// The connection supplies tag/chunk/timestamp/payload; the proxy assigns the wire-envelope
		// sequence number itself (per-proxy, starting at 0), so any value the connection passes is ignored.
		conn.onAudioFrame('ignored-input-tag', 5, 960, 'OPUSB64');

		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ tag: '523834112-a0.en', language: 'en', chunk: 5, timestamp: 960, payload: 'OPUSB64', sequenceNumber: 0 });
	});

	it('attributes transcription to the input source name', () => {
		const proxy = new TranslatorProxy(mockWebSocket, {}, mockRuntime);
		mockWebSocket.emit('message', { data: sourcesMessage(['523834112-a0'], ['523834112-a0.en']) });
		const conn = MockedConnection.mock.instances[0] as any;

		const transcripts: any[] = [];
		proxy.on('transcription', (data) => transcripts.push(data));
		conn.onTranscription('hola', 'en');

		expect(transcripts[0]).toMatchObject({ transcript: 'hola', targetLanguage: 'en', tag: '523834112-a0' });
	});

	it('dev path: start-translation + media lazily creates a connection tagged {src}.{lang}', () => {
		const proxy = new TranslatorProxy(mockWebSocket, {}, mockRuntime);
		mockWebSocket.emit('message', { data: JSON.stringify({ event: 'start-translation', translation: { language: 'en' } }) });
		mockWebSocket.emit('message', { data: mediaMessage('spk-1') });

		expect(MockedConnection).toHaveBeenCalledWith('spk-1', { targetLanguage: 'en' }, mockRuntime);

		const conn = MockedConnection.mock.instances[0] as any;
		const frames: any[] = [];
		proxy.on('audioFrame', (data) => frames.push(data));
		conn.onAudioFrame('spk-1', 1, 0, 'P', 1);
		expect(frames[0]).toMatchObject({ tag: 'spk-1.en', language: 'en' });
	});

	it('dev path: languages seeded from initialLanguages translate every source', () => {
		new TranslatorProxy(mockWebSocket, { initialLanguages: ['en'] }, mockRuntime);
		mockWebSocket.emit('message', { data: mediaMessage('spk-1') });

		expect(MockedConnection).toHaveBeenCalledTimes(1);
		expect(MockedConnection).toHaveBeenCalledWith('spk-1', { targetLanguage: 'en' }, mockRuntime);
	});

	it('wires an onUsageReport callback onto the connection when a translationToken is set', () => {
		new TranslatorProxy(mockWebSocket, { translationToken: 'tt_secret' }, mockRuntime);
		mockWebSocket.emit('message', { data: sourcesMessage([], ['523834112-a0.en']) });

		expect(MockedConnection).toHaveBeenCalledWith(
			'523834112-a0',
			expect.objectContaining({ targetLanguage: 'en', onUsageReport: expect.any(Function) }),
			mockRuntime,
		);
	});
});
