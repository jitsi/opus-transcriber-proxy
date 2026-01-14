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
	| 'ingester_success'
	| 'ingester_failure'
	| 'dispatcher_success'
	| 'dispatcher_failure'
	| 'transcription_success'
	| 'transcription_failure'
	| 'opus_packet_received'
	| 'opus_packet_queued'
	| 'opus_loss_concealment'
	| 'opus_packet_decoded'
	| 'opus_decode_failure'
	| 'opus_packet_discarded'
	| 'openai_audio_queued'
	| 'openai_audio_sent'
	| 'openai_api_error';

export interface MetricEvent {
	name: MetricName;
	worker: 'webhook-ingester' | 'transcription-dispatcher' | 'opus-transcriber-proxy';
	errorType?: string;
	sessionId?: string;
	targetName?: string;
	latencyMs?: number;
}

/**
 * Writes a metric data point (Node.js version - logs to console instead of Analytics Engine)
 *
 * Schema (for reference, not used in Node.js):
 * - blob1: metric_name (e.g., 'ingester_success', 'transcription_failure')
 * - blob2: worker_name (e.g., 'webhook-ingester')
 * - blob3: error_type (optional, for failures)
 * - blob4: session_id (optional, for correlation)
 * - blob5: target_name (optional, for dispatcher)
 * - double1: count (default 1)
 * - double2: latency_ms (optional)
 * - index1: session_id (for sampling)
 */
export function writeMetric(analytics: undefined, event: MetricEvent, count: number = 1): void {
	// In Node.js, we log metrics when debug is enabled
	// Cloudflare Analytics Engine is not available
	if (debugMetrics) {
		logger.debug(
			'[METRIC]',
			JSON.stringify({
				name: event.name,
				worker: event.worker,
				errorType: event.errorType,
				sessionId: event.sessionId,
				targetName: event.targetName,
				count,
				latencyMs: event.latencyMs,
			}),
		);
	}
}
