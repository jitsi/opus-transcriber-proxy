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
import type { IWebSocket, OutboundWebSocketOptions, TranslationRuntime } from './runtime';

export function createNodeTranslationRuntime(): TranslationRuntime {
	return {
		logger,
		config: {
			openaiApiKey: config.translation.apiKey,
			translationModel: config.translation.model,
			emitTranscripts: config.translation.transcripts,
			debug: config.debug,
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
