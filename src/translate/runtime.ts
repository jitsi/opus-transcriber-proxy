// Runtime-injection boundary for the translation core (TranslatorProxy / TranslatorConnection).
//
// The core is runtime-agnostic: it never imports config, the logger, metrics, the `ws` package, or
// the Opus codec modules directly. Instead it receives a TranslationRuntime, letting it run both in
// the Node container (see ../translate/nodeRuntime.ts) and, later, in a Cloudflare Worker/Durable
// Object (which has no filesystem, no `ws`, and creates outbound WebSockets via fetch-upgrade).

import type { IOpusDecoder, OpusDecoderOptions } from '../OpusDecoder/opusTypes';
import type { IOpusEncoder, OpusEncoderConfig } from '../OpusEncoder/opusEncoderTypes';

/** Minimal logger surface used by the translation core (a subset of the Winston logger's API). */
export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string, error?: unknown): void;
}

/**
 * The subset of the WebSocket API the core uses, common to the Node `ws` socket, the Node global
 * WebSocket, and the Cloudflare Worker WebSocket. Both the inbound (bridge) socket and the outbound
 * (OpenAI) socket are consumed through this shape.
 */
export interface IWebSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: 'open', listener: (event: unknown) => void): void;
	addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
	addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
	addEventListener(type: 'close', listener: (event: { code?: number; reason?: string; wasClean?: boolean }) => void): void;
	readonly readyState?: number;
}

/** Options for opening the outbound WebSocket to the OpenAI realtime endpoint. */
export interface OutboundWebSocketOptions {
	/** Required subprotocols (e.g. `realtime`), NOT including any auth. */
	protocols?: string[];
	/**
	 * Bearer token for auth. Each runtime applies it the way its transport allows — Node via the
	 * `openai-insecure-api-key.<token>` subprotocol (the global WebSocket can't set headers), a Worker
	 * via the `Authorization: Bearer` header on its fetch-upgrade. Only one form is sent, never both
	 * (OpenAI rejects receiving both).
	 */
	bearerToken?: string;
}

/** Effective translation configuration, resolved by each runtime from its own environment. */
export interface TranslationRuntimeConfig {
	/** OpenAI API key for the translations endpoint. */
	openaiApiKey: string;
	/** Speech-to-speech translation model. */
	translationModel: string;
	/** Emit target-language transcripts (false → translated audio only). */
	emitTranscripts: boolean;
	/** Enable debug-only latency instrumentation. */
	debug: boolean;
	/**
	 * Endpoint for live-translation audio-duration usage reports. When unset, usage reporting is a
	 * no-op (the usage reporter warns once and drops), so dev/replay runs and deployments without a
	 * reporting endpoint cost nothing. Resolved by each runtime from its environment.
	 */
	translationUsageUrl?: string;
	/**
	 * Interval (ms) between periodic incremental usage reports for an open translation direction.
	 * Each TranslatorConnection reports the audio duration translated since its previous report;
	 * the deltas sum to the direction's total. Reporting incrementally (rather than once at close)
	 * survives an abrupt kill (e.g. a Cloudflare Worker hitting its CPU limit), which would
	 * otherwise lose the usage of any direction still open. Default 15000; <=0 disables the timer
	 * (only the final delta at close is reported). Resolved by each runtime from its environment.
	 */
	usageReportIntervalMs?: number;
}

/** Per-connection metric batcher (Node aggregates + flushes to OTLP; a Worker may no-op). */
export interface MetricBatcher {
	increment(metric: Record<string, unknown>): void;
	flush(): void;
}

/** Everything the translation core needs from its host runtime. */
export interface TranslationRuntime {
	readonly logger: Logger;
	readonly config: TranslationRuntimeConfig;
	/** Record a one-off metric. May be a no-op (e.g. in a Worker without OTLP). */
	writeMetric(metric: Record<string, unknown>): void;
	/** Create a per-connection metric batcher. */
	createMetricBatcher(): MetricBatcher;
	/** Open the outbound WebSocket to OpenAI. */
	createOutboundWebSocket(url: string, options?: OutboundWebSocketOptions): IWebSocket;
	/** Create the Opus decoder for the selected backend. */
	createOpusDecoder(options: OpusDecoderOptions<24000>): IOpusDecoder<24000>;
	/** Create the Opus encoder for the selected backend. */
	createOpusEncoder(config: OpusEncoderConfig): IOpusEncoder;
	/**
	 * Build the server `info` message sent to the bridge on connect (build hash, runtime, deployment).
	 * Returns undefined to skip sending it. The Worker may augment/replace this.
	 */
	buildServerInfo(): Record<string, unknown> | undefined;
}
