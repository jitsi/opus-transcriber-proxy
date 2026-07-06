// Cloudflare Worker implementation of the TranslationRuntime. Mirrors src/translate/nodeRuntime.ts
// but for workerd: console logging, config from the DO env, no-op metrics, the WASM Opus codec
// (import-loaded, no fs), and an outbound OpenAI socket opened via fetch-upgrade.

import type { Env } from './env';
import type { IWebSocket, OutboundWebSocketOptions, TranslationRuntime } from '../src/translate/runtime';
import { OpusDecoderWasm } from '../src/OpusDecoder/OpusDecoderWasm';
import { OpusEncoderWasm } from '../src/OpusEncoder/OpusEncoderWasm';
import { registerWorkerOpusWasm } from './opusWasmSource';

type Listener = (event: any) => void;

/**
 * Adapts workerd's async outbound WebSocket (fetch-upgrade → response.webSocket → accept()) to the
 * synchronous IWebSocket the core expects: it returns immediately, queues sends and event listeners,
 * and flushes/dispatches once the socket is established (or emits error+close on failure).
 */
class WorkerOutboundWebSocket implements IWebSocket {
	private ws?: WebSocket;
	private sendQueue: string[] = [];
	private closedByCaller = false;
	private readonly listeners: Record<string, Listener[]> = { open: [], message: [], error: [], close: [] };
	public readyState = 0; // CONNECTING

	constructor(url: string, options?: OutboundWebSocketOptions) {
		void this.connect(url, options);
	}

	private async connect(url: string, options?: OutboundWebSocketOptions): Promise<void> {
		try {
			const headers = new Headers({ Upgrade: 'websocket' });
			// Worker authenticates via the Authorization header (not the subprotocol) — sending both
			// makes OpenAI reject the connection.
			if (options?.bearerToken) {
				headers.set('Authorization', `Bearer ${options.bearerToken}`);
			}
			if (options?.protocols && options.protocols.length > 0) {
				headers.set('Sec-WebSocket-Protocol', options.protocols.join(', '));
			}
			// workerd's fetch-upgrade requires an http(s) scheme, not ws(s).
			const fetchUrl = url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
			const resp = await fetch(fetchUrl, { headers });
			const ws = resp.webSocket;
			if (!ws) {
				throw new Error(`outbound WebSocket upgrade failed (HTTP ${resp.status})`);
			}
			ws.accept();
			this.ws = ws;
			this.readyState = 1; // OPEN
			ws.addEventListener('message', (e) => this.dispatch('message', e));
			ws.addEventListener('close', (e) => {
				this.readyState = 3; // CLOSED
				this.dispatch('close', e);
			});
			ws.addEventListener('error', (e) => this.dispatch('error', e));
			for (const msg of this.sendQueue) ws.send(msg);
			this.sendQueue = [];
			if (this.closedByCaller) {
				ws.close();
				return;
			}
			this.dispatch('open', {});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.readyState = 3; // CLOSED
			this.dispatch('error', { message });
			this.dispatch('close', { code: 1006, reason: message.slice(0, 123), wasClean: false });
		}
	}

	send(data: string): void {
		if (this.ws) {
			this.ws.send(data);
		} else if (!this.closedByCaller) {
			this.sendQueue.push(data);
		}
	}

	close(code?: number, reason?: string): void {
		this.closedByCaller = true;
		if (this.readyState < 2) this.readyState = 2; // CLOSING (→ CLOSED on the close event)
		this.ws?.close(code, reason);
	}

	addEventListener(type: string, listener: Listener): void {
		(this.listeners[type] ??= []).push(listener);
	}

	private dispatch(type: string, event: any): void {
		for (const l of this.listeners[type] ?? []) {
			try {
				l(event);
			} catch {
				// a listener throwing must not break the others
			}
		}
	}
}

export function createWorkerTranslationRuntime(env: Env): TranslationRuntime {
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
			// The Worker entry augments/forwards info separately; nothing to send from the core here.
			return undefined;
		},
	};
}
