/**
 * Tests for TranslatorProxy.
 *
 * Covers the control plane added so the bridge can drive translation over the
 * dedicated translation WebSocket:
 * - ping/pong
 * - start-translation / stop-translation language management
 * - one TranslatorConnection per (speaker tag, target language)
 * - media is only translated for currently-active languages
 * - languages seeded from the URL via initialLanguages
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

// Mock TranslatorConnection so no real OpenAI websocket is opened. The mock
// records its tag + target language and exposes handleMediaEvent/close spies.
vi.mock('../../src/TranslatorConnection', () => ({
	TranslatorConnection: vi.fn(function (this: any, tag: string, options: { targetLanguage: string }) {
		this.localTag = tag;
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

function mediaMessage(tag: string) {
	return JSON.stringify({
		event: 'media',
		media: { tag, chunk: 1, timestamp: 1000, payload: 'AAAA' },
	});
}

describe('TranslatorProxy', () => {
	let mockWebSocket: any;

	beforeEach(() => {
		vi.clearAllMocks();
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
			emit: (event: string, data?: any) => {
				(eventListeners.get(event) || []).forEach((listener) => listener(data));
			},
		};
	});

	/** Constructor args ([tag, {targetLanguage}]) for every created connection. */
	const createdLanguages = () => MockedConnection.mock.calls.map((c) => (c[1] as any).targetLanguage);

	it('responds to ping with pong (preserving id)', () => {
		new TranslatorProxy(mockWebSocket, {});
		mockWebSocket.emit('message', { data: JSON.stringify({ event: 'ping', id: 7 }) });
		expect(mockWebSocket.send).toHaveBeenCalledWith(JSON.stringify({ event: 'pong', id: 7 }));
	});

	it('does not translate media until a language is active', () => {
		new TranslatorProxy(mockWebSocket, {});
		mockWebSocket.emit('message', { data: mediaMessage('spk-1') });
		expect(MockedConnection).not.toHaveBeenCalled();
	});

	it('start-translation activates a language; media then creates a connection for (tag, language)', () => {
		new TranslatorProxy(mockWebSocket, {});
		mockWebSocket.emit('message', { data: JSON.stringify({ event: 'start-translation', translation: { language: 'en' } }) });
		mockWebSocket.emit('message', { data: mediaMessage('spk-1') });

		expect(MockedConnection).toHaveBeenCalledTimes(1);
		expect(MockedConnection).toHaveBeenCalledWith('spk-1', { targetLanguage: 'en' });
		expect(MockedConnection.mock.instances[0].handleMediaEvent).toHaveBeenCalledTimes(1);
	});

	it('reuses the same connection for repeated media of the same (tag, language)', () => {
		new TranslatorProxy(mockWebSocket, {});
		mockWebSocket.emit('message', { data: JSON.stringify({ event: 'start-translation', translation: { language: 'en' } }) });
		mockWebSocket.emit('message', { data: mediaMessage('spk-1') });
		mockWebSocket.emit('message', { data: mediaMessage('spk-1') });

		expect(MockedConnection).toHaveBeenCalledTimes(1);
		expect(MockedConnection.mock.instances[0].handleMediaEvent).toHaveBeenCalledTimes(2);
	});

	it('translates into multiple active languages over the same socket', () => {
		new TranslatorProxy(mockWebSocket, {});
		mockWebSocket.emit('message', { data: JSON.stringify({ event: 'start-translation', translation: { language: 'en' } }) });
		mockWebSocket.emit('message', { data: JSON.stringify({ event: 'start-translation', translation: { language: 'de' } }) });
		mockWebSocket.emit('message', { data: mediaMessage('spk-1') });

		expect(MockedConnection).toHaveBeenCalledTimes(2);
		expect(createdLanguages().sort()).toEqual(['de', 'en']);
		// Each per-language connection received the media exactly once.
		MockedConnection.mock.instances.forEach((inst) => {
			expect(inst.handleMediaEvent).toHaveBeenCalledTimes(1);
		});
	});

	it('stop-translation closes the language connections and halts further translation', () => {
		new TranslatorProxy(mockWebSocket, {});
		mockWebSocket.emit('message', { data: JSON.stringify({ event: 'start-translation', translation: { language: 'en' } }) });
		mockWebSocket.emit('message', { data: mediaMessage('spk-1') });
		const created = MockedConnection.mock.instances[0];

		mockWebSocket.emit('message', { data: JSON.stringify({ event: 'stop-translation', translation: { language: 'en' } }) });
		expect(created.close).toHaveBeenCalledTimes(1);

		// No language active now: further media creates no new connection.
		mockWebSocket.emit('message', { data: mediaMessage('spk-1') });
		expect(MockedConnection).toHaveBeenCalledTimes(1);
	});

	it('seeds active languages from initialLanguages (URL)', () => {
		new TranslatorProxy(mockWebSocket, { initialLanguages: ['en'] });
		mockWebSocket.emit('message', { data: mediaMessage('spk-1') });

		expect(MockedConnection).toHaveBeenCalledTimes(1);
		expect(MockedConnection).toHaveBeenCalledWith('spk-1', { targetLanguage: 'en' });
	});

	it('ignores start-translation with an unsupported/invalid language', () => {
		new TranslatorProxy(mockWebSocket, {});
		mockWebSocket.emit('message', { data: JSON.stringify({ event: 'start-translation', translation: { language: 'klingon' } }) });
		mockWebSocket.emit('message', { data: mediaMessage('spk-1') });
		expect(MockedConnection).not.toHaveBeenCalled();
	});

	it('closes all connections when the websocket closes', () => {
		const proxy = new TranslatorProxy(mockWebSocket, {});
		const closedSpy = vi.fn();
		proxy.on('closed', closedSpy);

		mockWebSocket.emit('message', { data: JSON.stringify({ event: 'start-translation', translation: { language: 'en' } }) });
		mockWebSocket.emit('message', { data: mediaMessage('spk-1') });
		const created = MockedConnection.mock.instances[0];

		mockWebSocket.emit('close');
		expect(created.close).toHaveBeenCalledTimes(1);
		expect(closedSpy).toHaveBeenCalled();
	});
});
