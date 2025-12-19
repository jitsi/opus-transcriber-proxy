/**
 * Metrics service for writing to Cloudflare Analytics Engine
 * Provides consistent metric structure across the transcription pipeline
 *
 * Note: Environment is not tracked since each Cloudflare account represents
 * a separate environment (dev, staging, prod).
 */

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
 * Writes a metric data point to Analytics Engine
 *
 * Schema:
 * - blob1: metric_name (e.g., 'ingester_success', 'transcription_failure')
 * - blob2: worker_name (e.g., 'webhook-ingester')
 * - blob3: error_type (optional, for failures)
 * - blob4: session_id (optional, for correlation)
 * - blob5: target_name (optional, for dispatcher)
 * - double1: count (default 1)
 * - double2: latency_ms (optional)
 * - index1: session_id (for sampling)
 */
export function writeMetric(analytics: AnalyticsEngineDataset | undefined, event: MetricEvent, count: number = 1): void {
	if (!analytics) {
		console.warn('Analytics Engine not configured, skipping metric:', event.name);
		return;
	}

	if (debugMetrics) {
		console.log(
			'Writing metric:',
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

	try {
		analytics.writeDataPoint({
			blobs: [event.name, event.worker, event.errorType ?? '', event.sessionId ?? '', event.targetName ?? ''],
			doubles: [count, event.latencyMs ?? 0],
			indexes: [event.sessionId ?? ''],
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('Failed to write metric:', message);
	}
}
