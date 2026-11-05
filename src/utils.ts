/*
 * Copyright @ 2025 - present 8x8, Inc.
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

export type AudioEncoding = 'opus' | 'ogg-opus';

/**
 * The shape of an endpoint name: 1 to 32 characters, lower case letters, digits and hyphens, the
 * first a letter or digit. Keep it the same as ENDPOINT_NAME_RE in worker/vars.ts. That file has no
 * imports on purpose, so that the variable table stays a plain data file. This file reads
 * `./config` lazily, and an import of this file from there would pull dotenv and the loading of
 * `process.env` into the Worker bundle. A test in configOverride.test.ts checks that the two
 * agree on a sample of names.
 */
export const ENDPOINT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface ISessionParameters {
	url: URL;
	sessionId?: string;
	connect?: string;
	useDispatcher: boolean;
	sendBack: boolean;
	sendBackInterim: boolean;
	language?: string;
	provider?: string;
	encoding: AudioEncoding;
	tags: string[];
	openaiCustomUrl?: string;
	deepgramMipOptOut?: boolean;
	/** Per-connection xAI segmentation overrides (undefined = use config). */
	xaiEndpointing?: number;
	xaiSmartTurn?: number;
	xaiSmartTurnTimeout?: number;
	/** Per-connection xAI roll-own granular finalization overrides (undefined = use config). */
	xaiGranularFinals?: boolean;
	xaiGranularStabilityMs?: number;
	xaiGranularGuardWords?: number;
	/**
	 * Per-connection xAI STT endpoint: a name from XAI_STT_ENDPOINTS (undefined = XAI_STT_URL).
	 * Well-formed here. server.ts checks that the name is configured.
	 */
	xaiSttEndpoint?: string;
	/**
	 * Per-connection text-translation provider (undefined = the first available entry of
	 * TEXT_TRANSLATION_PROVIDERS_PRIORITY). Validated in server.ts, like the transcription `provider`.
	 */
	textTranslationProvider?: string;
}

/**
 * Validates tags according to Deepgram requirements.
 * Tags must be ≤ 128 characters per tag.
 *
 * Note: This validation is applied universally to all connections regardless of provider.
 * Non-Deepgram backends currently ignore tags, so this is harmless. If a future backend
 * has different tag constraints, it should either override this validation or bypass it.
 *
 * @see https://developers.deepgram.com/docs/stt-tagging
 * @throws Error if any tag is invalid
 */
export function validateTags(tags: string[]): void {
	const maxTagLength = 128;

	for (const tag of tags) {
		if (tag.length > maxTagLength) {
			throw new Error(
				`Invalid tag: "${tag.substring(0, 50)}..." exceeds maximum length of ${maxTagLength} characters (actual: ${tag.length})`
			);
		}
	}
}

export function extractSessionParameters(url: string): ISessionParameters {
	const parsedUrl = new URL(url);
	const sessionId = parsedUrl.searchParams.get('sessionId');
	const connect = parsedUrl.searchParams.get('connect');
	const useDispatcher = parsedUrl.searchParams.get('useDispatcher');
	const sendBack = parsedUrl.searchParams.get('sendBack');
	const sendBackInterim = parsedUrl.searchParams.get('sendBackInterim');
	const lang = parsedUrl.searchParams.get('lang');
	const rawProvider = parsedUrl.searchParams.get('provider')?.toLowerCase();
	const provider = rawProvider === 'custom_openai' ? 'openai_custom' : rawProvider;
	const encodingParam = parsedUrl.searchParams.get('encoding');
	let encoding: AudioEncoding;
	if (encodingParam === null || encodingParam === 'opus') {
		encoding = 'opus';
	} else if (encodingParam === 'ogg-opus') {
		encoding = 'ogg-opus';
	} else {
		throw new Error(`Invalid encoding parameter: "${encodingParam}". Valid values are: opus, ogg-opus`);
	}
	// Parse tags as multiple tag= parameters (like Deepgram API), filter empty strings
	const tags = parsedUrl.searchParams.getAll('tag').filter((t) => t);
	const openaiCustomUrl = parsedUrl.searchParams.get('openaiCustomUrl');
	// Per-connection override for Deepgram MIP opt-out. Absent = undefined (use config).
	const mipOptOutParam = parsedUrl.searchParams.get('deepgram_mip_opt_out');
	const deepgramMipOptOut = mipOptOutParam === null ? undefined : mipOptOutParam === 'true';
	// Per-connection xAI segmentation overrides. Absent or unparseable = undefined (use config).
	const parseFloatParam = (name: string): number | undefined => {
		const raw = parsedUrl.searchParams.get(name);
		if (raw === null) return undefined;
		const n = parseFloat(raw);
		return Number.isFinite(n) ? n : undefined;
	};
	const parseIntParam = (name: string): number | undefined => {
		const raw = parsedUrl.searchParams.get(name);
		if (raw === null) return undefined;
		const n = parseInt(raw, 10);
		return Number.isFinite(n) ? n : undefined;
	};
	const xaiEndpointing = parseIntParam('endpointing');
	const xaiSmartTurn = parseFloatParam('smart_turn');
	const xaiSmartTurnTimeout = parseIntParam('smart_turn_timeout');
	// Per-connection xAI roll-own granular finalization overrides.
	const granularFinalsParam = parsedUrl.searchParams.get('xai_granular_finals');
	const xaiGranularFinals = granularFinalsParam === null ? undefined : granularFinalsParam === 'true';
	const xaiGranularStabilityMs = parseIntParam('xai_granular_stability_ms');
	const xaiGranularGuardWords = parseIntParam('xai_granular_guard_words');
	// Per-connection xAI STT endpoint: the name of an endpoint that the operator configured in
	// XAI_STT_ENDPOINTS, never a URL. A caller that names an endpoint may do so to keep audio in a
	// region, so an empty value is rejected like any other malformed name: it would otherwise mean
	// the default endpoint, for example when a URL template leaves a variable unresolved. The
	// error does not echo the value, to keep caller text out of the response and the logs. Whether
	// the name is configured is checked in server.ts, which has the config.
	const rawXaiSttEndpoint = parsedUrl.searchParams.get('xai_stt_endpoint');
	let xaiSttEndpoint: string | undefined;
	if (rawXaiSttEndpoint !== null) {
		xaiSttEndpoint = rawXaiSttEndpoint.toLowerCase();
		if (!ENDPOINT_NAME_RE.test(xaiSttEndpoint)) {
			throw new Error(`Invalid xai_stt_endpoint parameter. Use 1 to 32 characters: a-z, 0-9 and hyphen. Start with a letter or digit.`);
		}
	}
	// Per-connection text-translation provider override.
	const textTranslationProvider = parsedUrl.searchParams.get('text_translation_provider')?.toLowerCase();

	// Validate tags according to provider requirements (Deepgram: ≤ 128 chars)
	validateTags(tags);

	return {
		url: parsedUrl,
		sessionId: sessionId ?? undefined,
		connect: connect ?? undefined,
		useDispatcher: useDispatcher === 'true',
		sendBack: sendBack === 'true',
		sendBackInterim: sendBackInterim === 'true',
		language: lang ?? undefined,
		provider: provider ?? undefined,
		encoding,
		tags,
		openaiCustomUrl: openaiCustomUrl ?? undefined,
		deepgramMipOptOut,
		xaiEndpointing,
		xaiSmartTurn,
		xaiSmartTurnTimeout,
		xaiGranularFinals,
		xaiGranularStabilityMs,
		xaiGranularGuardWords,
		xaiSttEndpoint,
		textTranslationProvider: textTranslationProvider ?? undefined,
	};
}

export function getTurnDetectionConfig() {
	// Configuration is loaded from environment variables in config.ts
	// Import dynamically to avoid circular dependencies
	const { config } = require('./config');
	return config.openai.turnDetection;
}

const CREDENTIAL_KEY = /authorization|token|secret|api-?key|cookie/i;

/**
 * A copy of a record (request headers, session parameters) with credential values masked, for debug logging: bearer
 * tokens, shared secrets, API keys, cookies.
 */
export function redactCredentials(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [key, CREDENTIAL_KEY.test(key) && value !== undefined ? '[redacted]' : value]),
	);
}
