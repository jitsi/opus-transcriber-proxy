/*
 * Copyright @ 2026 - present 8x8, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, it, expect } from 'vitest';
import {
	getTranslationProvider,
	isTranslationProviderAvailable,
	normalizeTargetLanguage,
	resolveTranslationProvider,
	XAI_DEFAULT_IDLE_CLOSE_MS,
	XAI_TRANSLATIONS_ENDPOINT,
} from '../../src/translate/provider';
import type { TranslationRuntimeConfig } from '../../src/translate/runtime';

const base: TranslationRuntimeConfig = {
	openaiApiKey: 'oa-key',
	translationModel: 'gpt-realtime-translate',
	emitTranscripts: true,
	debug: false,
};

describe('translation provider resolution', () => {
	it('defaults to openai and requires its key', () => {
		expect(resolveTranslationProvider(undefined, base)).toEqual({ provider: 'openai' });
		expect(resolveTranslationProvider(undefined, { ...base, openaiApiKey: '' }).error).toMatch(/openai.*not available/);
	});

	it('honours the deployment default and a per-connection override, case-insensitively', () => {
		const cfg = { ...base, provider: 'xai' as const, xaiApiKey: 'x-key' };
		expect(resolveTranslationProvider(undefined, cfg)).toEqual({ provider: 'xai' });
		expect(resolveTranslationProvider('OpenAI', cfg)).toEqual({ provider: 'openai' });
		expect(resolveTranslationProvider('XAI', base).error).toMatch(/xai.*not available/);
	});

	it('rejects an unknown provider by name as a client error, a missing key as a deployment one', () => {
		const invalid = resolveTranslationProvider('deepgram', base);
		expect(invalid.error).toMatch(/Invalid translation provider: deepgram/);
		expect(invalid.kind).toBe('invalid');
		expect(resolveTranslationProvider('xai', base).kind).toBe('unavailable');
	});

	it('availability follows the per-provider key', () => {
		expect(isTranslationProviderAvailable('xai', base)).toBe(false);
		expect(isTranslationProviderAvailable('xai', { ...base, xaiApiKey: 'k' })).toBe(true);
		expect(isTranslationProviderAvailable('openai', { ...base, openaiApiKey: '' })).toBe(false);
	});
});

describe('translation provider specs', () => {
	it('openai: model in the query, realtime subprotocol, configure-on-open, no server finals', () => {
		const p = getTranslationProvider('openai', base);
		expect(p.url).toBe('wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate');
		expect(p.protocols).toEqual(['realtime']);
		expect(p.authSubprotocolPrefix).toBe('openai-insecure-api-key.');
		expect(p.handshake).toBe('open');
		expect(p.serverTranscriptFinals).toBe(false);
		expect(p.defaultIdleCloseMs).toBe(0);
		expect(p.buildSessionUpdate('es')).toEqual({ type: 'session.update', session: { audio: { output: { language: 'es' } } } });
	});

	it('xai: fixed endpoint, no subprotocol, session handshake, server finals, idle close, PCM 24 kHz both ways', () => {
		const p = getTranslationProvider('xai', { ...base, xaiApiKey: 'x-key' });
		expect(p.url).toBe(XAI_TRANSLATIONS_ENDPOINT);
		expect(p.apiKey).toBe('x-key');
		expect(p.protocols).toEqual([]);
		expect(p.authSubprotocolPrefix).toBe('xai-insecure-api-key.');
		expect(p.handshake).toBe('session');
		expect(p.serverTranscriptFinals).toBe(true);
		expect(p.defaultIdleCloseMs).toBe(XAI_DEFAULT_IDLE_CLOSE_MS);
		expect(p.buildSessionUpdate('nl')).toEqual({
			type: 'session.update',
			session: {
				audio: {
					input: { transcription: false, format: { type: 'audio/pcm', rate: 24000 } },
					output: { language: 'nl', format: { type: 'audio/pcm', rate: 24000 } },
				},
			},
		});
	});

	it('xai: URL override and voice are applied when configured', () => {
		const p = getTranslationProvider('xai', { ...base, xaiApiKey: 'k', xaiTranslationUrl: 'wss://proxy.test/rt', xaiVoice: 'Ara' });
		expect(p.url).toBe('wss://proxy.test/rt');
		expect((p.buildSessionUpdate('es') as any).session.audio.output.voice).toBe('Ara');
	});
});

describe('normalizeTargetLanguage', () => {
	it('openai: accepts its list and English names, rejects the rest', () => {
		expect(normalizeTargetLanguage('ES')).toBe('es');
		expect(normalizeTargetLanguage('Spanish', 'openai')).toBe('es');
		expect(() => normalizeTargetLanguage('nl', 'openai')).toThrow(/Unsupported target language "nl"/);
		expect(() => normalizeTargetLanguage('dutch', 'openai')).toThrow(/Unsupported/);
	});

	it('xai: accepts any BCP-47-shaped tag and English names, rejects free text', () => {
		expect(normalizeTargetLanguage('nl', 'xai')).toBe('nl');
		expect(normalizeTargetLanguage('zh-CN', 'xai')).toBe('zh-cn');
		expect(normalizeTargetLanguage('Dutch', 'xai')).toBe('nl');
		expect(normalizeTargetLanguage('ceb', 'xai')).toBe('ceb');
		expect(() => normalizeTargetLanguage('', 'xai')).toThrow(/Unsupported/);
		expect(() => normalizeTargetLanguage('klingon please', 'xai')).toThrow(/BCP-47/);
	});
});
