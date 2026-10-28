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

// The speech-to-speech translation providers behind /translate. Worker-safe (no Node imports).
//
// Both providers speak the same "session.*" realtime protocol: the client sends `session.update`,
// `session.input_audio_buffer.append` (base64 PCM16 mono 24 kHz) and `session.close`; the server
// streams `session.output_audio.delta` (base64 PCM16 24 kHz) and `session.output_transcript.delta`.
// What differs is captured in a TranslationProviderSpec so TranslatorConnection carries one code path:
//
// - OpenAI (/v1/realtime/translations, gpt-realtime-translate): the session is configured on socket
//   open and audio flows at once; the only session field accepted is the target language; there is no
//   transcript-done event (finals are the concatenated deltas, emitted at the talk-stop silence) and
//   the target language must be one of a fixed list.
// - xAI (/v1/realtime/translations, grok-realtime-translation-fast): the server first sends
//   `session.created`, the client answers `session.update`, and audio may flow only after
//   `session.updated`; `session.output_transcript.updated` is a per-segment FINAL (its `text` equals
//   the concatenated deltas, measured); any BCP-47 tag is accepted; the session is closed by the
//   server after ~5 min without client frames and billed on wall-clock time, idle included, so an
//   idle direction is closed proactively (`defaultIdleCloseMs`) and reopened on the next frame.

import type { TranslationRuntimeConfig } from './runtime';
import { isValidTargetLanguage } from '../textTranslate/TextTranslator';

export type TranslationProviderId = 'openai' | 'xai';

export const TRANSLATION_PROVIDERS: readonly TranslationProviderId[] = ['openai', 'xai'];

export function isTranslationProviderId(value: unknown): value is TranslationProviderId {
	return typeof value === 'string' && (TRANSLATION_PROVIDERS as readonly string[]).includes(value);
}

const OPENAI_TRANSLATIONS_ENDPOINT = 'wss://api.openai.com/v1/realtime/translations';
export const XAI_TRANSLATIONS_ENDPOINT = 'wss://api.x.ai/v1/realtime/translations';

/**
 * How long an xAI direction may go without a media frame before it is closed proactively (ms). xAI
 * bills the greater of audio duration and wall-clock session time, idle included, and itself drops a
 * session after ~5 min without client frames; a muted participant would otherwise cost money for
 * silence and then lose the direction at a time of xAI's choosing. The proxy reopens a closed
 * direction on the participant's next frame (TranslatorProxy), buffering the first frames while the
 * new session connects.
 */
export const XAI_DEFAULT_IDLE_CLOSE_MS = 120_000;

export interface TranslationProviderSpec {
	readonly id: TranslationProviderId;
	/** Display name for log lines. */
	readonly name: string;
	/** Full WebSocket URL to open, including any query parameters. */
	readonly url: string;
	readonly apiKey: string;
	/** Subprotocols to request, excluding the auth subprotocol the Node runtime adds. */
	readonly protocols: readonly string[];
	/** Prefix of the `<prefix><api key>` auth subprotocol used where headers cannot be set (Node). */
	readonly authSubprotocolPrefix: string;
	/**
	 * `open`: send `session.update` on socket open and stream audio at once (OpenAI).
	 * `session`: wait for the server's `session.created` before `session.update`, and for
	 * `session.updated` before streaming audio (xAI).
	 */
	readonly handshake: 'open' | 'session';
	/** Whether `session.output_transcript.updated` carries a segment's final transcript. */
	readonly serverTranscriptFinals: boolean;
	/** Idle-close default when `TranslationRuntimeConfig.idleCloseMs` is unset; 0 disables. */
	readonly defaultIdleCloseMs: number;
	/** The `session.update` message for a target language. */
	buildSessionUpdate(targetLanguage: string): Record<string, unknown>;
}

// Supported target languages for the gpt-realtime-translate endpoint.
// From https://github.com/openai/openai-cookbook examples/voice_solutions/realtime_translation_guide/.
const OPENAI_TARGET_LANGUAGES = new Set([
	'en', 'es', 'pt', 'fr', 'ja', 'ru', 'zh', 'de', 'ko', 'hi', 'id', 'vi', 'it',
]);

const LANGUAGE_NAME_TO_ISO: Record<string, string> = {
	english: 'en',
	spanish: 'es',
	portuguese: 'pt',
	french: 'fr',
	japanese: 'ja',
	russian: 'ru',
	chinese: 'zh',
	mandarin: 'zh',
	german: 'de',
	korean: 'ko',
	hindi: 'hi',
	indonesian: 'id',
	vietnamese: 'vi',
	italian: 'it',
	dutch: 'nl',
	arabic: 'ar',
	turkish: 'tr',
	polish: 'pl',
	ukrainian: 'uk',
	swedish: 'sv',
};

/** The ISO code for an English language name, or undefined. An own-property lookup: `__proto__` or
 * `constructor` as a requested language must not come back as an object. */
function languageNameToIso(name: string): string | undefined {
	return Object.prototype.hasOwnProperty.call(LANGUAGE_NAME_TO_ISO, name) ? LANGUAGE_NAME_TO_ISO[name] : undefined;
}

function normalizeOpenAITargetLanguage(input: string): string {
	const lower = input.trim().toLowerCase();
	if (OPENAI_TARGET_LANGUAGES.has(lower)) return lower;
	const mapped = languageNameToIso(lower);
	if (mapped && OPENAI_TARGET_LANGUAGES.has(mapped)) return mapped;
	throw new Error(
		`Unsupported target language "${input}". Supported: ${Array.from(OPENAI_TARGET_LANGUAGES).join(', ')}`,
	);
}

// xAI documents "any non-empty tag", but a free-form string would let a typo through to a paid session,
// so the tag must have the BCP-47 shape jitsi-meet sends (the same check as text translation's). The
// primary subtag is lowercased; the rest keep the caller's case (`zh-CN`, `zh-Hant`), since xAI's
// acceptance was probed only with bare two-letter codes and BCP-47 is case-insensitive anyway.
function normalizeXAITargetLanguage(input: string): string {
	const trimmed = input.trim();
	const mapped = languageNameToIso(trimmed.toLowerCase());
	if (mapped) return mapped;
	if (isValidTargetLanguage(trimmed)) {
		const [primary, ...rest] = trimmed.split('-');
		return [primary.toLowerCase(), ...rest].join('-');
	}
	throw new Error(`Unsupported target language "${input}": expected a BCP-47 language tag such as "es" or "zh-CN"`);
}

/**
 * Normalise a target language to what a provider accepts (lowercase code; English language names
 * like "spanish" are mapped). Throws with a user-facing message when unsupported. Used for the
 * `?lang=` dev path (server.ts, worker/handleTranslate.ts) and, re-exported from
 * TranslatorConnection, by the proxy for the bridge's `sources` requests.
 */
export function normalizeTargetLanguage(input: string, provider: TranslationProviderId = 'openai'): string {
	return provider === 'xai' ? normalizeXAITargetLanguage(input) : normalizeOpenAITargetLanguage(input);
}

/** The provider the deployment defaults to when a connection names none. */
export function defaultTranslationProvider(config: TranslationRuntimeConfig): TranslationProviderId {
	return config.provider ?? 'openai';
}

let warnedUnknownConfiguredProvider = false;

/**
 * The deployment's configured provider (`TRANSLATION_PROVIDER`), case-insensitively: unset → openai;
 * an unknown value → openai too, reported through `warn` once per process or isolate (the runtimes
 * are built per connection, so the check runs on every connect).
 */
export function resolveConfiguredTranslationProvider(raw: string | undefined, warn: (message: string) => void): TranslationProviderId {
	const lower = raw?.trim().toLowerCase();
	if (!lower) return 'openai';
	if (isTranslationProviderId(lower)) return lower;
	if (!warnedUnknownConfiguredProvider) {
		warnedUnknownConfiguredProvider = true;
		warn(`TRANSLATION_PROVIDER=${raw} is not a known speech-to-speech provider (${TRANSLATION_PROVIDERS.join(', ')}); using openai`);
	}
	return 'openai';
}

/** Whether a provider has the credentials it needs in this deployment. */
export function isTranslationProviderAvailable(id: TranslationProviderId, config: TranslationRuntimeConfig): boolean {
	return id === 'xai' ? !!config.xaiApiKey : !!config.openaiApiKey;
}

/**
 * Resolve the provider for a connection: the requested one (the `provider` URL parameter) or the
 * deployment default, which must be known and have a key. Otherwise returns an operator-facing
 * error message for the caller to refuse the upgrade with (every direction would fail at connect
 * anyway, so refusing early gives the bridge a clear signal), classified as `invalid` (the caller
 * named an unknown provider: a client error) or `unavailable` (no key for it: a deployment problem),
 * so the refusal can carry a 4xx or a 5xx accordingly.
 */
export function resolveTranslationProvider(
	requested: string | undefined,
	config: TranslationRuntimeConfig,
):
	| { provider: TranslationProviderId; error?: undefined; kind?: undefined }
	| { provider?: undefined; error: string; kind: 'invalid' | 'unavailable' } {
	const id = requested ? requested.toLowerCase() : defaultTranslationProvider(config);
	if (!isTranslationProviderId(id)) {
		return { kind: 'invalid', error: `Invalid translation provider: ${requested}. Valid providers are: ${TRANSLATION_PROVIDERS.join(', ')}` };
	}
	if (!isTranslationProviderAvailable(id, config)) {
		return { kind: 'unavailable', error: `Translation provider '${id}' is not available: its API key is not configured` };
	}
	return { provider: id };
}

export function getTranslationProvider(id: TranslationProviderId, config: TranslationRuntimeConfig): TranslationProviderSpec {
	if (id === 'xai') {
		const voice = config.xaiVoice;
		return {
			id,
			name: 'xAI',
			url: config.xaiTranslationUrl || XAI_TRANSLATIONS_ENDPOINT,
			apiKey: config.xaiApiKey ?? '',
			// With header auth xAI echoes no subprotocol, and a client that requested one then fails the
			// handshake; with subprotocol auth it echoes the auth subprotocol. So request none here.
			protocols: [],
			authSubprotocolPrefix: 'xai-insecure-api-key.',
			handshake: 'session',
			serverTranscriptFinals: true,
			defaultIdleCloseMs: XAI_DEFAULT_IDLE_CLOSE_MS,
			buildSessionUpdate: (targetLanguage) => ({
				type: 'session.update',
				session: {
					audio: {
						// Source captions are not needed: the bridge gets the source transcript from /transcribe.
						input: { transcription: false, format: { type: 'audio/pcm', rate: 24000 } },
						output: {
							language: targetLanguage,
							format: { type: 'audio/pcm', rate: 24000 },
							...(voice ? { voice } : {}),
						},
					},
				},
			}),
		};
	}
	return {
		id: 'openai',
		name: 'OpenAI',
		// The model (default gpt-realtime-translate, OPENAI_TRANSLATION_MODEL) is a query param. Requires
		// tier 1+ access. Docs: https://developers.openai.com/api/docs/models/gpt-realtime-translate
		url: `${OPENAI_TRANSLATIONS_ENDPOINT}?model=${encodeURIComponent(config.translationModel)}`,
		apiKey: config.openaiApiKey,
		protocols: ['realtime'],
		authSubprotocolPrefix: 'openai-insecure-api-key.',
		handshake: 'open',
		serverTranscriptFinals: false,
		defaultIdleCloseMs: 0,
		// Canonical session schema per openai/openai-cookbook examples/voice_solutions/realtime_translation_guide/:
		// the target language under audio.output.language as a 2-letter ISO code. The endpoint rejects
		// session.instructions, session.type, session.output_modalities, voice, etc. — the model is
		// purpose-built and intentionally unprompt-able to keep it translation-only.
		buildSessionUpdate: (targetLanguage) => ({
			type: 'session.update',
			session: { audio: { output: { language: targetLanguage } } },
		}),
	};
}
