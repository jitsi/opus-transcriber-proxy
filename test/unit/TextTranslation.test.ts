/**
 * Tests for text translation on the /transcribe path:
 * - the `sources` control event that carries the requested target languages
 * - the per-language fan-out of translated finals
 * - the wire shape jitsi-meet expects for a `translation-result`
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriberProxy, type TranscriptionMessage } from '../../src/transcriberproxy';
import { isValidTargetLanguage, needsTranslation, type TextTranslationRequest } from '../../src/textTranslate/TextTranslator';
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
		textTranslation: {
			enabled: true,
			providersPriority: ['stub'],
			enableStub: true,
			historyTurns: 6,
			historyMaxChars: 2000,
			includeSpeakers: true,
			timeoutMs: 10000,
			temperature: undefined,
			reasoningEffort: undefined,
			maxOutputTokens: undefined,
			openai: { apiKey: '', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
			xai: { apiKey: '', url: 'https://api.x.ai/v1/chat/completions', model: 'grok-4.20-0309-non-reasoning' },
			gemini: { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash-lite', thinkingBudget: 0 },
			google: { apiKey: '', url: 'https://translation.googleapis.com/language/translate/v2' },
		},
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
		mockConfig.textTranslation.providersPriority = ['stub'];
		mockConfig.textTranslation.enableStub = true;
		mockConfig.textTranslation.historyTurns = 6;
		mockConfig.textTranslation.includeSpeakers = true;

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
				translate: vi.fn((request: TextTranslationRequest) =>
					request.targetLanguage === 'fr'
						? Promise.reject(new Error('provider down'))
						: Promise.resolve(`[${request.targetLanguage}] ${request.turn.text}`),
				),
			};

			await deliverFinal(proxy, finalTranscription());

			expect(translations).toHaveBeenCalledTimes(1);
			expect(translations.mock.calls[0][0].language).toBe('de');
		});
	});

	describe('an echoed speaker label', () => {
		it('is logged, and the text is published unchanged', async () => {
			const logger = (await import('../../src/logger')).default;
			const { proxy, translations } = proxyRequesting(['fr']);
			(proxy as any).textTranslator = {
				translate: vi.fn(() => Promise.resolve('Speaker 1: bonjour tout le monde')),
			};

			await deliverFinal(proxy, finalTranscription());

			// Reported so a prompt or model regression is visible...
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('came back with a speaker label'));
			// ...but never repaired: editing the text means recognising a label in an arbitrary human
			// language, which mangles ordinary sentences. The prompt is what keeps labels out.
			expect(translations).toHaveBeenCalledTimes(1);
			expect(translations.mock.calls[0][0].text).toBe('Speaker 1: bonjour tout le monde');
		});

		it('says nothing for an ordinary translation that merely contains a colon', async () => {
			const logger = (await import('../../src/logger')).default;
			const { proxy, translations } = proxyRequesting(['fr']);
			(proxy as any).textTranslator = {
				translate: vi.fn(() => Promise.resolve('Salle 12 : elle est réservée')),
			};

			await deliverFinal(proxy, finalTranscription());

			expect(logger.warn).not.toHaveBeenCalled();
			expect(translations.mock.calls[0][0].text).toBe('Salle 12 : elle est réservée');
		});
	});

	describe('context', () => {
		/** Replace the translator with a spy that records the requests it is given. */
		function captureRequests(proxy: TranscriberProxy): TextTranslationRequest[] {
			const requests: TextTranslationRequest[] = [];
			(proxy as any).textTranslator = {
				translate: vi.fn((request: TextTranslationRequest) => {
					// Copy: the proxy shares one history array across languages, and later turns push to it.
					requests.push({ ...request, history: [...request.history] });
					return Promise.resolve(`[${request.targetLanguage}] ${request.turn.text}`);
				}),
			};
			// An LLM provider, so the proxy passes context.
			(proxy as any).textTranslationProvider = 'openai';
			return requests;
		}

		it('passes no history for the first turn', async () => {
			const { proxy } = proxyRequesting(['fr']);
			const requests = captureRequests(proxy);

			await deliverFinal(proxy, finalTranscription());

			expect(requests).toHaveLength(1);
			expect(requests[0].history).toEqual([]);
			expect(requests[0].turn).toEqual({ speaker: 'Speaker 1', text: 'hello there', language: 'en' });
		});

		it('passes earlier turns as history, excluding the turn being translated', async () => {
			const { proxy } = proxyRequesting(['fr']);
			const requests = captureRequests(proxy);

			await deliverFinal(proxy, finalTranscription({ message_id: 'm1', transcript: [{ text: 'first' }] }));
			await deliverFinal(proxy, finalTranscription({ message_id: 'm2', transcript: [{ text: 'second' }] }));

			expect(requests[1].history).toEqual([{ speaker: 'Speaker 1', text: 'first', language: 'en' }]);
			expect(requests[1].turn.text).toBe('second');
		});

		it('labels each participant with a stable ordinal', async () => {
			const { proxy } = proxyRequesting(['fr']);
			const requests = captureRequests(proxy);
			const second = { id: 'def456', tag: 'def456-a0' };

			await deliverFinal(proxy, finalTranscription({ transcript: [{ text: 'from one' }] }));
			await deliverFinal(proxy, finalTranscription({ participant: second, transcript: [{ text: 'from two' }] }));
			await deliverFinal(proxy, finalTranscription({ transcript: [{ text: 'one again' }] }));

			expect(requests.map((r) => r.turn.speaker)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 1']);
		});

		it('gives every requested language the same history snapshot', async () => {
			const { proxy } = proxyRequesting(['fr', 'de']);
			const requests = captureRequests(proxy);

			await deliverFinal(proxy, finalTranscription({ message_id: 'm1', transcript: [{ text: 'first' }] }));
			await deliverFinal(proxy, finalTranscription({ message_id: 'm2', transcript: [{ text: 'second' }] }));

			const [fr, de] = requests.filter((r) => r.turn.text === 'second');
			expect(fr.history).toEqual(de.history);
			expect(fr.history.map((t) => t.text)).toEqual(['first']);
		});

		it('records a turn that needed no translation as context for later ones', async () => {
			const { proxy } = proxyRequesting(['en', 'fr']);
			const requests = captureRequests(proxy);

			// Already English: the 'en' request is skipped, but the turn is still context.
			await deliverFinal(proxy, finalTranscription({ message_id: 'm1', transcript: [{ text: 'in english' }] }));
			await deliverFinal(proxy, finalTranscription({ message_id: 'm2', transcript: [{ text: 'next' }] }));

			const next = requests.find((r) => r.turn.text === 'next')!;
			expect(next.history.map((t) => t.text)).toEqual(['in english']);
		});

		it('caps the history at historyTurns', async () => {
			mockConfig.textTranslation.historyTurns = 2;
			const { proxy } = proxyRequesting(['fr']);
			const requests = captureRequests(proxy);

			for (const text of ['one', 'two', 'three', 'four']) {
				await deliverFinal(proxy, finalTranscription({ message_id: text, transcript: [{ text }] }));
			}

			expect(requests[3].history.map((t) => t.text)).toEqual(['two', 'three']);
		});

		it('passes no history when history is disabled', async () => {
			mockConfig.textTranslation.historyTurns = 0;
			const { proxy } = proxyRequesting(['fr']);
			const requests = captureRequests(proxy);

			await deliverFinal(proxy, finalTranscription({ message_id: 'm1', transcript: [{ text: 'first' }] }));
			await deliverFinal(proxy, finalTranscription({ message_id: 'm2', transcript: [{ text: 'second' }] }));

			expect(requests.every((r) => r.history.length === 0)).toBe(true);
		});

		it('sends no speaker at all when speaker labels are disabled', async () => {
			mockConfig.textTranslation.includeSpeakers = false;
			const { proxy } = proxyRequesting(['fr']);
			const requests = captureRequests(proxy);

			await deliverFinal(proxy, finalTranscription({ message_id: 'm1', transcript: [{ text: 'first' }] }));
			await deliverFinal(proxy, finalTranscription({ message_id: 'm2', transcript: [{ text: 'second' }] }));

			expect(requests.every((r) => r.turn.speaker === undefined)).toBe(true);
			expect(requests[1].history).toEqual([{ text: 'first', language: 'en' }]);
		});

		it('passes no history to a provider that does not support context', async () => {
			const { proxy } = proxyRequesting(['fr']);
			const requests = captureRequests(proxy);
			// Cloud Translation takes one string with no conversation.
			(proxy as any).textTranslationProvider = 'google';

			await deliverFinal(proxy, finalTranscription({ message_id: 'm1', transcript: [{ text: 'first' }] }));
			await deliverFinal(proxy, finalTranscription({ message_id: 'm2', transcript: [{ text: 'second' }] }));

			expect(requests.every((r) => r.history.length === 0)).toBe(true);
		});
	});

	describe('provider selection', () => {
		it('uses the first available provider from the priority list', () => {
			mockConfig.textTranslation.providersPriority = ['openai', 'stub'];
			mockConfig.textTranslation.openai.apiKey = '';
			const { proxy } = proxyRequesting(['fr']);
			expect((proxy as any).textTranslationProvider).toBe('stub');
		});

		it('prefers an available higher-priority provider', () => {
			mockConfig.textTranslation.providersPriority = ['openai', 'stub'];
			mockConfig.textTranslation.openai.apiKey = 'sk-test';
			try {
				const { proxy } = proxyRequesting(['fr']);
				expect((proxy as any).textTranslationProvider).toBe('openai');
			} finally {
				mockConfig.textTranslation.openai.apiKey = '';
			}
		});

		it('uses the connection override over the priority list', () => {
			mockConfig.textTranslation.providersPriority = ['openai'];
			mockConfig.textTranslation.openai.apiKey = 'sk-test';
			try {
				options.textTranslationProvider = 'stub';
				const { proxy } = proxyRequesting(['fr']);
				expect((proxy as any).textTranslationProvider).toBe('stub');
			} finally {
				mockConfig.textTranslation.openai.apiKey = '';
			}
		});

		it('drops the requested languages when no provider is available', async () => {
			mockConfig.textTranslation.providersPriority = ['openai'];
			mockConfig.textTranslation.enableStub = false;
			const { proxy, translations } = proxyRequesting(['fr']);

			expect((proxy as any).targetLanguages).toEqual([]);
			await deliverFinal(proxy, finalTranscription());
			expect(translations).not.toHaveBeenCalled();
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
		const request: TextTranslationRequest = {
			turn: { speaker: 'Speaker 1', text: 'hello' },
			targetLanguage: 'fr',
			history: [{ speaker: 'Speaker 2', text: 'earlier' }],
		};
		// Neither the speaker label nor the history reaches the output.
		await expect(new StubTextTranslator().translate(request)).resolves.toBe('[FR] hello');
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
