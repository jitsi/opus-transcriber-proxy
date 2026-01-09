import { writeMetric, MetricEvent } from './metrics';

/**
 * Aggregates metric counts and periodically flushes them (Node.js version - logs to console).
 * Reduces write frequency by batching metrics over a time interval.
 */
export class MetricCache {
	private analytics: undefined;
	private intervalMs: number;
	private metrics: Map<string, { event: MetricEvent; count: number; lastWriteTime: number }>;

	/**
	 * @param analytics - Always undefined in Node.js version (for compatibility)
	 * @param intervalMs - Time interval in milliseconds between metric writes (default: 1000ms).  NaN to force writes only on flush
	 */
	constructor(analytics: undefined, intervalMs: number = 1000) {
		this.analytics = analytics;
		this.intervalMs = intervalMs;
		this.metrics = new Map();
	}

	/**
	 * Increments the count for a metric. If the time interval has elapsed since
	 * the last write, flushes the accumulated count to Analytics Engine.
	 *
	 * @param event - The metric event to increment
	 */
	increment(event: MetricEvent): void {
		const key = this.getKey(event);
		const now = Date.now();
		const metric = this.metrics.get(key);

		if (!metric) {
			// First time seeing this metric
			this.metrics.set(key, { event, count: 1, lastWriteTime: now });
		} else {
			// Increment existing metric
			metric.count++;

			// Check if it's time to flush
			if (now - metric.lastWriteTime >= this.intervalMs) {
				writeMetric(this.analytics, metric.event, metric.count);
				metric.count = 0;
				metric.lastWriteTime = now;
			}
		}
	}

	/**
	 * Flushes all accumulated metrics immediately, regardless of time interval.
	 * Useful for cleanup on shutdown or before long idle periods.
	 */
	flush(): void {
		for (const [_, metric] of this.metrics) {
			if (metric.count > 0) {
				writeMetric(this.analytics, metric.event, metric.count);
				metric.count = 0;
				metric.lastWriteTime = Date.now();
			}
		}
	}

	/**
	 * Generates a unique key for a metric event based on its distinguishing properties.
	 * Does not include sessionId to allow aggregation across sessions.
	 */
	private getKey(event: MetricEvent): string {
		return JSON.stringify({
			name: event.name,
			worker: event.worker,
			errorType: event.errorType ?? '',
			targetName: event.targetName ?? '',
		});
	}
}
