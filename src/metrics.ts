/**
 * Metrics service for writing to Cloudflare Analytics Engine
 * Provides consistent metric structure across the transcription pipeline
 *
 * Note: Environment is not tracked since each Cloudflare account represents
 * a separate environment (dev, staging, prod).
 */

export type MetricName =
  | 'ingester_success'
  | 'ingester_failure'
  | 'dispatcher_success'
  | 'dispatcher_failure'
  | 'transcription_success'
  | 'transcription_failure'
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
 * - double1: count (always 1)
 * - double2: latency_ms (optional)
 * - index1: session_id (for sampling)
 */
export function writeMetric(
  analytics: AnalyticsEngineDataset | undefined,
  event: MetricEvent
): void {
  if (!analytics) {
    console.warn('Analytics Engine not configured, skipping metric:', event.name);
    return;
  }

  analytics.writeDataPoint({
    blobs: [
      event.name,
      event.worker,
      event.errorType ?? '',
      event.sessionId ?? '',
      event.targetName ?? '',
    ],
    doubles: [1, event.latencyMs ?? 0],
    indexes: [event.sessionId ?? ''],
  });
}
