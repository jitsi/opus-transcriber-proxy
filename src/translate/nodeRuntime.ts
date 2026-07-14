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

/** Parse an integer env var, falling back to a default when unset or non-numeric. */
function parseIntOr(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

export function createNodeTranslationRuntime(): TranslationRuntime {
	return {
		logger,
		config: {
			openaiApiKey: config.translation.apiKey,
			translationModel: config.translation.model,
			emitTranscripts: config.translation.transcripts,
			debug: config.debug,
			translationUsageUrl: config.translation.usageUrl,
			usageReportIntervalMs: parseIntOr(process.env.TRANSLATION_USAGE_REPORT_INTERVAL_MS, 15000),
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
