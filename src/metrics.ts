/**
 * Metrics service for writing to Cloudflare Analytics Engine
 * Provides consistent metric structure across the transcription pipeline
 *
 * Note: Environment is not tracked since each Cloudflare account represents
 * a separate environment (dev, staging, prod).
 */

import logger from './logger';

/**
 * Internal debug state for logging metric writes
 */
let debugMetrics = false;

/**
 * Sets the debug state for metric logging
 * @param enabled - Whether to enable debug logging for metrics
 */
export function setMetricDebug(enabled: boolean): void {
	debugMetrics = enabled;
}

export type MetricName =
	| 'transcription_success'
	| 'transcription_failure'
	| 'opus_packet_received'
	| 'opus_packet_queued'
	| 'opus_loss_concealment'
	| 'opus_packet_decoded'
	| 'opus_decode_failure'
	| 'opus_packet_discarded'
	| 'backend_audio_queued'
	| 'backend_audio_sent'
	| 'backend_opus_sent'
	| 'openai_api_error'
	| 'gemini_api_error'
	| 'deepgram_api_error';

export interface MetricEvent {
	name: MetricName;
	worker: 'opus-transcriber-proxy';
	errorType?: string;
	sessionId?: string;
	latencyMs?: number;
}

/**
 * Writes a metric data point (legacy - logs to console when debug enabled)
 * Note: New metrics should use OpenTelemetry via telemetry/instruments.ts
 */
export function writeMetric(analytics: undefined, event: MetricEvent, count: number = 1): void {
	if (debugMetrics) {
		logger.debug(
			'[METRIC]',
			JSON.stringify({
				name: event.name,
				worker: event.worker,
				errorType: event.errorType,
				sessionId: event.sessionId,
				count,
				latencyMs: event.latencyMs,
			}),
		);
	}
}
