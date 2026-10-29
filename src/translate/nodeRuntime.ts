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

// Node/container implementation of the TranslationRuntime: wires the translation core to the
// existing config, Winston logger, OTLP metrics, the Node WebSocket, and the Opus codec facades
// (which themselves pick native vs WASM via OPUS_BACKEND). The Cloudflare Worker will provide its
// own runtime instead of this one.

import { config } from '../config';
import logger from '../logger';
import { writeMetric } from '../metrics';
import { MetricCache } from '../MetricCache';
import { buildServerInfo } from '../serverInfo';
import { OpusDecoder } from '../OpusDecoder/OpusDecoder';
import { OpusEncoder } from '../OpusEncoder/OpusEncoder';
import { provideBase64 } from './base64';
import { parseIntOr } from './env';
import type { IWebSocket, OutboundWebSocketOptions, TranslationRuntime } from './runtime';

// Buffer-based base64 for the per-frame hot path: 20-100x faster than the portable atob/btoa
// fallback, and available on every Node the container runs (node:22 lacks Uint8Array.toBase64).
// Deliberately an import-time side effect: it globally overrides the implementation in base64.ts
// for this process, so it is in place before any frame is encoded. Importing this module from a
// context that shouldn't switch base64 to Buffer (e.g. a Worker bundle) would be a bug anyway —
// this file is Node-only by design.
provideBase64(
	(bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
	(b64) => {
		const buf = Buffer.from(b64, 'base64');
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	},
);

// Warn at most once per process if talk-end detection is disabled (see below).
let warnedTalkTimeoutDisabled = false;

export function createNodeTranslationRuntime(): TranslationRuntime {
	const talkSilenceTimeoutMs = parseIntOr(process.env.TRANSLATION_TALK_SILENCE_TIMEOUT_MS, 350);
	if (talkSilenceTimeoutMs <= 0 && !warnedTalkTimeoutDisabled) {
		warnedTalkTimeoutDisabled = true;
		logger.warn(
			'TRANSLATION_TALK_SILENCE_TIMEOUT_MS <= 0 disables talk-end detection; on the /v1/realtime/translations ' +
				'endpoint (no boundary event) translated sources will never report sending=false until the connection closes.',
		);
	}
	return {
		logger,
		config: {
			openaiApiKey: config.translation.apiKey,
			translationModel: config.translation.model,
			translationEndpoint: config.translation.endpoint,
			emitTranscripts: config.translation.transcripts,
			debug: config.debug,
			translationUsageUrl: config.translation.usageUrl,
			usageReportIntervalMs: parseIntOr(process.env.TRANSLATION_USAGE_REPORT_INTERVAL_MS, 15000),
			talkSilenceTimeoutMs,
		},
		writeMetric(metric) {
			writeMetric(undefined, metric as any);
		},
		createMetricBatcher() {
			const cache = new MetricCache(undefined);
			return {
				increment: (metric) => cache.increment(metric as any),
				flush: () => cache.flush(),
			};
		},
		createOutboundWebSocket(url: string, options?: OutboundWebSocketOptions): IWebSocket {
			// Node authenticates via the OpenAI subprotocol (the global WebSocket can't set headers).
			const protocols = [...(options?.protocols ?? [])];
			if (options?.bearerToken) {
				protocols.push(`openai-insecure-api-key.${options.bearerToken}`);
			}
			return new WebSocket(url, protocols) as unknown as IWebSocket;
		},
		createOpusDecoder(options) {
			return new OpusDecoder<24000>(options);
		},
		createOpusEncoder(config_) {
			return new OpusEncoder(config_);
		},
		buildServerInfo() {
			// Translation always runs on OpenAI, so the reported provider is fixed.
			return buildServerInfo({ provider: 'openai' });
		},
	};
}
