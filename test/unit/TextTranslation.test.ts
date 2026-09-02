/**
 * Tests for text translation on the /transcribe path:
 * - the `sources` control event that carries the requested target languages
 * - the per-language fan-out of translated finals
 * - the wire shape jitsi-meet expects for a `translation-result`
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriberProxy, type TranscriptionMessage } from '../../src/transcriberproxy';
import { isValidTargetLanguage, needsTranslation } from '../../src/textTranslate/TextTranslator';
import { StubTextTranslator } from '../../src/textTranslate/StubTextTranslator';
import { buildTextTranslationMessage, transcriptionText } from '../../src/textTranslate/messages';

vi.mock('../../src/logger', () => ({
	default: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		isLevelEnabled: vi.fn(() => false),
	},
}));

vi.mock('../../src/config', () => ({
	config: {
		broadcastTranscripts: false,
		dumpWebSocketMessages: false,
		dumpTranscripts: false,
		dumpBasePath: '/tmp/opus-transcriber-proxy-test',
		dispatcher: { wsUrl: '', headers: {} },
		textTranslation: { enabled: true, provider: 'stub' },
	},
}));

vi.mock('../../src/OutgoingConnection', () => ({
	OutgoingConnection: vi.fn(function (this: any, tag: string) {
		this.localTag = tag;
		this.participantId = tag.split('-')[0];
		this.handleMediaEvent = vi.fn();
		this.addTranscriptContext = vi.fn();
		this.updateInputFormat = vi.fn();
		this.getInputFormat = vi.fn(() => ({ encoding: 'opus' }));
		this.resetChunkTracking = vi.fn();
		this.close = vi.fn();
		this.onInterimTranscription = undefined;
		this.onCompleteTranscription = undefined;
		this.onClosed = undefined;
		this.onError = undefined;
	}),
}));

vi.mock('../../src/telemetry/instruments', () => ({
	getInstruments: vi.fn(() => ({ participantsActive: { add: vi.fn() } })),
}));

/** A final transcription as the backends produce it. */
function finalTranscription(overrides: Partial<TranscriptionMessage> = {}): TranscriptionMessage {
	return {
		transcript: [{ text: 'hello there', confidence: 0.9 }],
		is_interim: false,
		language: 'en',
		message_id: 'msg-1',
		type: 'transcription-result',
		event: 'transcription-result',
		participant: { id: 'abc123', tag: 'abc123-a0' },
		timestamp: 1_700_000_000_000,
		...overrides,
	};
}

describe('text translation', () => {
	let mockWebSocket: any;
	let options: any;
	let mockConfig: any;

	beforeEach(async () => {
		vi.clearAllMocks();

		mockConfig = (await import('../../src/config')).config;
		mockConfig.textTranslation.enabled = true;
		mockConfig.textTranslation.provider = 'stub';

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

		options = { sessionId: 'session-1', provider: 'openai', encoding: 'opus' };
	});

	/** Create a proxy, request `languages`, and return it plus a spy on its 'translation' events. */
	function proxyRequesting(languages: string[]) {
		const proxy = new TranscriberProxy(mockWebSocket, options);
		const translations = vi.fn();
		proxy.on('translation', translations);
		mockWebSocket.emit('message', { data: JSON.stringify({ event: 'sources', exports: [], requests: languages }) });
		return { proxy, translations };
	}

	/** Drive a final transcription through the proxy's per-connection callback. */
	async function deliverFinal(proxy: TranscriberProxy, message: TranscriptionMessage) {
		proxy.handleStartEvent({
			event: 'start',
			start: { tag: message.participant.tag ?? message.participant.id, mediaFormat: { encoding: 'opus', sampleRate: 48000, channels: 2 } },
		});
		const connection = (proxy as any).outgoingConnections.get(message.participant.tag ?? message.participant.id);
		connection.onCompleteTranscription(message);
		// Translation is async and deliberately not awaited by the caller; let its promises settle.
		await new Promise((resolve) => setImmediate(resolve));
	}

	describe('sources event', () => {
		it('takes the requested target languages from `requests`', () => {
			const { proxy } = proxyRequesting(['fr', 'de']);
			expect((proxy as any).targetLanguages).toEqual(['fr', 'de']);
		});

		it('replaces the previous set (the event is the authoritative full set)', () => {
			const { proxy } = proxyRequesting(['fr', 'de']);
			mockWebSocket.emit('message', { data: JSON.stringify({ event: 'sources', exports: [], requests: ['es'] }) });
			expect((proxy as any).targetLanguages).toEqual(['es']);
		});

		it('stops translating on an empty `requests`', async () => {
			const { proxy, translations } = proxyRequesting(['fr']);
			mockWebSocket.emit('message', { data: JSON.stringify({ event: 'sources', exports: [], requests: [] }) });
			expect((proxy as any).targetLanguages).toEqual([]);

			await deliverFinal(proxy, finalTranscription());
			expect(translations).not.toHaveBeenCalled();
		});

		it('accepts region and 3-letter codes, and drops invalid ones', () => {
			const { proxy } = proxyRequesting(['zh-CN', 'ceb', 'not a language', '', 'de']);
			expect((proxy as any).targetLanguages).toEqual(['zh-CN', 'ceb', 'de']);
		});

		it('de-duplicates repeated languages', () => {
			const { proxy } = proxyRequesting(['fr', 'fr', 'de']);
			expect((proxy as any).targetLanguages).toEqual(['fr', 'de']);
		});

		it('ignores requested languages when text translation is disabled', async () => {
			mockConfig.textTranslation.enabled = false;
			const { proxy, translations } = proxyRequesting(['fr']);
			expect((proxy as any).targetLanguages).toEqual([]);

			await deliverFinal(proxy, finalTranscription());
			expect(translations).not.toHaveBeenCalled();
		});

		it('does not create a translator when no language is requested', () => {
			const { proxy } = proxyRequesting([]);
			expect((proxy as any).textTranslator).toBeUndefined();
		});
	});

	describe('fan-out', () => {
		it('emits one translation per requested language', async () => {
			const { proxy, translations } = proxyRequesting(['fr', 'de']);

			await deliverFinal(proxy, finalTranscription());

			expect(translations).toHaveBeenCalledTimes(2);
			expect(translations.mock.calls.map((c) => c[0].language)).toEqual(['fr', 'de']);
			expect(translations.mock.calls.map((c) => c[0].text)).toEqual([
				'[FR] hello there',
				'[DE] hello there',
			]);
		});

		it('reuses the transcription message_id so the client can pair the two', async () => {
			const { proxy, translations } = proxyRequesting(['fr']);

			await deliverFinal(proxy, finalTranscription({ message_id: 'transcript-42' }));

			expect(translations.mock.calls[0][0].message_id).toBe('transcript-42');
		});

		it('produces the wire shape jitsi-meet expects for a translation-result', async () => {
			const { proxy, translations } = proxyRequesting(['fr']);

			await deliverFinal(proxy, finalTranscription());

			expect(translations.mock.calls[0][0]).toEqual({
				event: 'transcription-result',
				type: 'translation-result',
				message_id: 'msg-1',
				language: 'fr',
				// A plain string, not a transcript[] array — that is what the client reads for this type.
				text: '[FR] hello there',
				participant: { id: 'abc123', tag: 'abc123-a0' },
				timestamp: 1_700_000_000_000,
			});
		});

		it('carries the speaker through when the backend diarized', async () => {
			const { proxy, translations } = proxyRequesting(['fr']);

			await deliverFinal(proxy, finalTranscription({ speaker: 2 }));

			expect(translations.mock.calls[0][0].speaker).toBe(2);
		});

		it('skips a target language the transcript is already in', async () => {
			const { proxy, translations } = proxyRequesting(['en', 'fr']);

			await deliverFinal(proxy, finalTranscription({ language: 'en-US' }));

			expect(translations).toHaveBeenCalledTimes(1);
			expect(translations.mock.calls[0][0].language).toBe('fr');
		});

		it('translates every language when the source language is unknown', async () => {
			const { proxy, translations } = proxyRequesting(['en', 'fr']);

			await deliverFinal(proxy, finalTranscription({ language: undefined }));

			expect(translations).toHaveBeenCalledTimes(2);
		});

		it('does not translate an empty transcript', async () => {
			const { proxy, translations } = proxyRequesting(['fr']);

			await deliverFinal(proxy, finalTranscription({ transcript: [{ text: '   ' }] }));

			expect(translations).not.toHaveBeenCalled();
		});

		it('does not translate interim transcriptions', async () => {
			const { proxy, translations } = proxyRequesting(['fr']);

			proxy.handleStartEvent({
				event: 'start',
				start: { tag: 'abc123-a0', mediaFormat: { encoding: 'opus', sampleRate: 48000, channels: 2 } },
			});
			const connection = (proxy as any).outgoingConnections.get('abc123-a0');
			connection.onInterimTranscription(finalTranscription({ is_interim: true }));
			await new Promise((resolve) => setImmediate(resolve));

			expect(translations).not.toHaveBeenCalled();
		});

		it('still emits the original transcription alongside the translations', async () => {
			const { proxy, translations } = proxyRequesting(['fr']);
			const transcriptions = vi.fn();
			proxy.on('transcription', transcriptions);

			await deliverFinal(proxy, finalTranscription());

			expect(transcriptions).toHaveBeenCalledTimes(1);
			expect(transcriptions.mock.calls[0][0].type).toBe('transcription-result');
			expect(translations).toHaveBeenCalledTimes(1);
		});

		it('drops only the failing language when a translation rejects', async () => {
			const { proxy, translations } = proxyRequesting(['fr', 'de']);
			(proxy as any).textTranslator = {
				translate: vi.fn((text: string, language: string) =>
					language === 'fr' ? Promise.reject(new Error('provider down')) : Promise.resolve(`[${language}] ${text}`),
				),
			};

			await deliverFinal(proxy, finalTranscription());

			expect(translations).toHaveBeenCalledTimes(1);
			expect(translations.mock.calls[0][0].language).toBe('de');
		});
	});
});

describe('isValidTargetLanguage', () => {
	it.each(['en', 'fr', 'ceb', 'haw', 'zh-CN', 'zh-TW'])('accepts %s', (code) => {
		expect(isValidTargetLanguage(code)).toBe(true);
	});

	it.each(['', 'e', 'toolongprimary', 'fr_CA!', 'a b', 42, null, undefined])('rejects %s', (code) => {
		expect(isValidTargetLanguage(code)).toBe(false);
	});
});

describe('needsTranslation', () => {
	it('compares the primary subtag only', () => {
		expect(needsTranslation('en', 'en-US')).toBe(false);
		expect(needsTranslation('zh-CN', 'zh-TW')).toBe(false);
		expect(needsTranslation('fr', 'en-US')).toBe(true);
	});

	it('is case insensitive and accepts underscore separators', () => {
		expect(needsTranslation('EN', 'en_GB')).toBe(false);
	});

	it('translates when the source language is unknown', () => {
		expect(needsTranslation('en', undefined)).toBe(true);
	});
});

describe('StubTextTranslator', () => {
	it('prefixes the text with the upper-cased target language', async () => {
		await expect(new StubTextTranslator().translate('hello', 'fr')).resolves.toBe('[FR] hello');
	});
});

describe('transcriptionText', () => {
	it('joins the transcript segments and trims', () => {
		expect(transcriptionText(finalTranscription({ transcript: [{ text: 'hello' }, { text: 'there ' }] }))).toBe(
			'hello there',
		);
	});

	it('is empty for a transcript with no segments', () => {
		expect(transcriptionText(finalTranscription({ transcript: [] }))).toBe('');
	});
});

describe('buildTextTranslationMessage', () => {
	it('omits speaker when the transcription has none', () => {
		const message = buildTextTranslationMessage(finalTranscription(), 'fr', 'bonjour');
		expect(message).not.toHaveProperty('speaker');
	});
});
