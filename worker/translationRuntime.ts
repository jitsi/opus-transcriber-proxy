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

// Cloudflare Worker implementation of the TranslationRuntime. Mirrors src/translate/nodeRuntime.ts
// but for workerd: console logging, config from the DO env, no-op metrics, the WASM Opus codec
// (import-loaded, no fs), and an outbound OpenAI socket opened via fetch-upgrade
// (see ./outboundWebSocket.ts).

import type { Env } from './env';
import type { IWebSocket, OutboundWebSocketOptions, TranslationRuntime } from '../src/translate/runtime';
import { OpusDecoderWasm } from '../src/OpusDecoder/OpusDecoderWasm';
import { OpusEncoderWasm } from '../src/OpusEncoder/OpusEncoderWasm';
import { GIT_HASH } from '../src/buildInfo';
import { registerWorkerOpusWasm } from './opusWasmSource';
import { WorkerOutboundWebSocket } from './outboundWebSocket';
import { parseIntOr } from '../src/translate/env';
import type { TranslateProvider } from './providerOverride';
import { defaultTranslationProvider, isTranslationProviderId, type TranslationProviderId } from '../src/translate/provider';

// Warn at most once per isolate about these settings (the runtime is built per connection).
let warnedTalkTimeoutDisabled = false;
let warnedBadProvider = false;
let warnedBadIdleClose = false;

/**
 * `providerOverride` is the provider an operator override (worker/providerOverride.ts) wrote into the
 * request, if one did; `buildServerInfo` reports it as `worker.providerOverride`.
 */
export function createWorkerTranslationRuntime(env: Env, request?: Request, providerOverride?: TranslateProvider): TranslationRuntime {
	registerWorkerOpusWasm();
	const debugEnabled = env.DEBUG === 'true';
	const talkSilenceTimeoutMs = parseIntOr(env.TRANSLATION_TALK_SILENCE_TIMEOUT_MS, 350);
	if (talkSilenceTimeoutMs <= 0 && !warnedTalkTimeoutDisabled) {
		warnedTalkTimeoutDisabled = true;
		console.warn(
			'TRANSLATION_TALK_SILENCE_TIMEOUT_MS <= 0 disables talk-end detection; on the /v1/realtime/translations ' +
				'endpoint (no boundary event) translated sources will never report sending=false until the connection closes.',
		);
	}
	const configuredProvider = env.TRANSLATION_PROVIDER?.toLowerCase();
	if (configuredProvider && !isTranslationProviderId(configuredProvider) && !warnedBadProvider) {
		warnedBadProvider = true; // the runtime is built per connection; one line per isolate, not per connect
		console.error(`TRANSLATION_PROVIDER=${configuredProvider} is not a known speech-to-speech provider (openai, xai); using openai`);
	}
	const provider: TranslationProviderId = isTranslationProviderId(configuredProvider) ? configuredProvider : 'openai';
	// Unset or malformed → undefined, so the provider default applies (as the container's parseIntOrUndefined does);
	// a typo must not silently disable the idle close that bounds xAI's wall-clock billing.
	const idleCloseParsed = env.TRANSLATION_IDLE_CLOSE_MS !== undefined ? parseInt(env.TRANSLATION_IDLE_CLOSE_MS, 10) : NaN;
	const idleCloseMs = Number.isFinite(idleCloseParsed) ? idleCloseParsed : undefined;
	if (env.TRANSLATION_IDLE_CLOSE_MS !== undefined && idleCloseMs === undefined && !warnedBadIdleClose) {
		warnedBadIdleClose = true;
		console.warn(`TRANSLATION_IDLE_CLOSE_MS=${env.TRANSLATION_IDLE_CLOSE_MS} is not a number; using the provider default`);
	}
	return {
		logger: {
			// Gate debug on the flag (mirrors the Node LOG_LEVEL behaviour). Unconditional console.debug
			// here floods the isolate: /translate logs once per OpenAI audio delta, and the synchronous
			// terminal writes compete with per-delta WASM opus-encode for the single workerd thread —
			// enough to starve the bridge ping/pong and trip JVB's ping timeout.
			debug: debugEnabled ? (m) => console.debug(m) : () => {},
			info: (m) => console.info(m),
			warn: (m) => console.warn(m),
			error: (m, e) => (e === undefined ? console.error(m) : console.error(m, e)),
		},
		config: {
			provider,
			openaiApiKey: env.OPENAI_TRANSLATION_API_KEY || env.OPENAI_API_KEY || '',
			translationModel: env.OPENAI_TRANSLATION_MODEL || 'gpt-realtime-translate',
			xaiApiKey: env.XAI_TRANSLATION_API_KEY || env.XAI_API_KEY || '',
			xaiTranslationUrl: env.XAI_TRANSLATION_URL || undefined,
			xaiVoice: env.XAI_TRANSLATION_VOICE || undefined,
			idleCloseMs,
			emitTranscripts: env.TRANSLATE_TRANSCRIPTS !== 'false',
			debug: debugEnabled,
			translationUsageUrl: env.TRANSLATION_USAGE_URL || '',
			usageReportIntervalMs: parseIntOr(env.TRANSLATION_USAGE_REPORT_INTERVAL_MS, 15000),
			talkSilenceTimeoutMs,
		},
		writeMetric() {
			// No OTLP in the Worker (yet); metrics are a no-op.
		},
		createMetricBatcher() {
			return { increment() {}, flush() {} };
		},
		createOutboundWebSocket(url: string, options?: OutboundWebSocketOptions): IWebSocket {
			return new WorkerOutboundWebSocket(url, options);
		},
		createOpusDecoder(options) {
			return new OpusDecoderWasm<24000>(options);
		},
		createOpusEncoder(config) {
			return new OpusEncoderWasm(config);
		},
		buildServerInfo(connectionProvider) {
			// The Worker-hosted /translate path never touches the container, so the container's info
			// (and sessionProxy.ts's in-place augmentation of it) does not apply here — build the equivalent
			// message directly. Mirrors src/serverInfo.ts, with a `worker` block for the Worker runtime.
			const info: Record<string, unknown> = {
				event: 'info',
				application: 'opus-transcriber-proxy',
				gitHash: GIT_HASH,
				runtime: 'cloudflare-worker',
				// The speech-to-speech provider of this connection (`?provider=` or the deployment default).
				provider: connectionProvider ?? defaultTranslationProvider(this.config),
				// Whether this deployment is configured to report per-customer usage (URL set). A flag,
				// not the URL itself — enough to answer "is usage reporting on for this worker?" from the
				// peer's logs without echoing the endpoint into them.
				config: { usageReporting: !!env.TRANSLATION_USAGE_URL },
			};
			// The Docker image tag the WASM Opus codec was sourced from. `gitHash` above is the WORKER CODE's
			// commit; this is the codec's origin, which is deployed independently — reporting both lets the peer
			// spot a code/WASM version mismatch (the two can drift, e.g. code from a branch + WASM from `latest`).
			if (env.SOURCE_IMAGE_TAG) info.sourceImageTag = env.SOURCE_IMAGE_TAG;
			const worker: Record<string, unknown> = { present: true };
			// Only when an override changed this connection's provider: `provider` above is what the
			// connection uses either way, and cannot tell an override apart from a client parameter.
			if (providerOverride) worker.providerOverride = providerOverride;
			if (env.CF_VERSION_METADATA) {
				worker.versionId = env.CF_VERSION_METADATA.id;
				worker.versionTag = env.CF_VERSION_METADATA.tag;
			}
			const cf = (request?.cf || {}) as Record<string, unknown>;
			if (cf.colo) worker.colo = cf.colo;
			if (cf.country) worker.country = cf.country;
			if (cf.city) worker.city = cf.city;
			info.worker = worker;
			return info;
		},
	};
}
