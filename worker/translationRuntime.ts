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

export function createWorkerTranslationRuntime(env: Env, request?: Request): TranslationRuntime {
	registerWorkerOpusWasm();
	return {
		logger: {
			debug: (m) => console.debug(m),
			info: (m) => console.info(m),
			warn: (m) => console.warn(m),
			error: (m, e) => (e === undefined ? console.error(m) : console.error(m, e)),
		},
		config: {
			openaiApiKey: env.OPENAI_TRANSLATION_API_KEY || env.OPENAI_API_KEY || '',
			translationModel: env.OPENAI_TRANSLATION_MODEL || 'gpt-realtime-translate',
			emitTranscripts: env.TRANSLATE_TRANSCRIPTS !== 'false',
			debug: env.DEBUG === 'true',
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
		buildServerInfo() {
			// The Worker-hosted /translate path never touches the container, so the container's info
			// (and the index.ts in-place augmentation of it) does not apply here — build the equivalent
			// message directly. Mirrors src/serverInfo.ts, with a `worker` block for the Worker runtime.
			const info: Record<string, unknown> = {
				event: 'info',
				application: 'opus-transcriber-proxy',
				gitHash: GIT_HASH,
				runtime: 'cloudflare-worker',
				// Translation always runs on OpenAI, so the reported provider is fixed.
				provider: 'openai',
			};
			const worker: Record<string, unknown> = { present: true };
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
