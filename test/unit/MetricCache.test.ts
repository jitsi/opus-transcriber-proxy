/**
 * Tests for MetricCache module
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetricCache } from '../../src/MetricCache';
import type { MetricEvent } from '../../src/metrics';

// Mock the writeMetric function
vi.mock('../../src/metrics', () => ({
	writeMetric: vi.fn(),
}));

describe('MetricCache', () => {
	let writeMetricMock: any;

	beforeEach(async () => {
		// Get the mocked writeMetric function
		const metricsModule = await import('../../src/metrics');
		writeMetricMock = metricsModule.writeMetric;
		vi.clearAllMocks();
	});

	describe('Constructor', () => {
		it('should initialize with default interval', () => {
			const cache = new MetricCache(undefined);
			expect(cache).toBeDefined();
		});

		it('should initialize with custom interval', () => {
			const cache = new MetricCache(undefined, 5000);
			expect(cache).toBeDefined();
		});

		it('should initialize with NaN interval (manual flush only)', () => {
			const cache = new MetricCache(undefined, NaN);
			expect(cache).toBeDefined();
		});
	});

	describe('increment', () => {
		it('should increment metric count on first call', () => {
			const cache = new MetricCache(undefined, 1000);
			const event: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
			};

			cache.increment(event);

			// Should not flush immediately on first increment
			expect(writeMetricMock).not.toHaveBeenCalled();
		});

		it('should accumulate multiple increments for same metric', () => {
			const cache = new MetricCache(undefined, 1000);
			const event: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
			};

			cache.increment(event);
			cache.increment(event);
			cache.increment(event);

			// Should not flush until interval elapsed
			expect(writeMetricMock).not.toHaveBeenCalled();
		});

		it('should track different metrics separately', () => {
			const cache = new MetricCache(undefined, 1000);
			const event1: MetricEvent = {
				name: 'metric_one',
				worker: 'opus-transcriber-proxy',
			};
			const event2: MetricEvent = {
				name: 'metric_two',
				worker: 'opus-transcriber-proxy',
			};

			cache.increment(event1);
			cache.increment(event2);
			cache.increment(event1);

			expect(writeMetricMock).not.toHaveBeenCalled();
		});

		it('should flush after interval elapsed', () => {
			vi.useFakeTimers();
			const cache = new MetricCache(undefined, 1000);
			const event: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
			};

			// First increment
			cache.increment(event);
			expect(writeMetricMock).not.toHaveBeenCalled();

			// Advance time past interval
			vi.advanceTimersByTime(1100);

			// Second increment should trigger flush (flush includes the second increment)
			cache.increment(event);

			expect(writeMetricMock).toHaveBeenCalledWith(undefined, event, 2);

			vi.useRealTimers();
		});

		it('should not flush before interval elapsed', () => {
			vi.useFakeTimers();
			const cache = new MetricCache(undefined, 1000);
			const event: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
			};

			cache.increment(event);

			// Advance time but not past interval
			vi.advanceTimersByTime(500);
			cache.increment(event);

			// Should not have flushed yet
			expect(writeMetricMock).not.toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('should reset count after flushing', () => {
			vi.useFakeTimers();
			const cache = new MetricCache(undefined, 1000);
			const event: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
			};

			// Accumulate 3 increments
			cache.increment(event);
			cache.increment(event);
			cache.increment(event);

			// Advance time and trigger flush (4th increment triggers flush with count of 4)
			vi.advanceTimersByTime(1100);
			cache.increment(event);

			expect(writeMetricMock).toHaveBeenCalledWith(undefined, event, 4);

			// Now accumulate 2 more and flush again
			vi.clearAllMocks();
			cache.increment(event);
			vi.advanceTimersByTime(1100);
			cache.increment(event);

			// Should flush with count of 2 (not 6)
			expect(writeMetricMock).toHaveBeenCalledWith(undefined, event, 2);

			vi.useRealTimers();
		});

		it('should handle metrics with errorType', () => {
			const cache = new MetricCache(undefined, 1000);
			const event: MetricEvent = {
				name: 'error_metric',
				worker: 'opus-transcriber-proxy',
				errorType: 'connection_failed',
			};

			cache.increment(event);
			expect(writeMetricMock).not.toHaveBeenCalled();
		});

		it('should distinguish metrics by errorType', () => {
			vi.useFakeTimers();
			const cache = new MetricCache(undefined, 1000);
			const event1: MetricEvent = {
				name: 'api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'timeout',
			};
			const event2: MetricEvent = {
				name: 'api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'invalid_request',
			};

			cache.increment(event1);
			cache.increment(event1);
			cache.increment(event2);

			vi.advanceTimersByTime(1100);

			// Trigger flushes (increments that trigger flush are included in count)
			cache.increment(event1);
			cache.increment(event2);

			// Should have flushed separately (3 for event1, 2 for event2)
			expect(writeMetricMock).toHaveBeenCalledWith(undefined, event1, 3);
			expect(writeMetricMock).toHaveBeenCalledWith(undefined, event2, 2);

			vi.useRealTimers();
		});

		it('should never auto-flush with NaN interval', () => {
			vi.useFakeTimers();
			const cache = new MetricCache(undefined, NaN);
			const event: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
			};

			cache.increment(event);
			vi.advanceTimersByTime(10000); // Advance 10 seconds
			cache.increment(event);

			// Should never flush
			expect(writeMetricMock).not.toHaveBeenCalled();

			vi.useRealTimers();
		});
	});

	describe('flush', () => {
		it('should flush all accumulated metrics', () => {
			const cache = new MetricCache(undefined, 1000);
			const event1: MetricEvent = {
				name: 'metric_one',
				worker: 'opus-transcriber-proxy',
			};
			const event2: MetricEvent = {
				name: 'metric_two',
				worker: 'opus-transcriber-proxy',
			};

			cache.increment(event1);
			cache.increment(event1);
			cache.increment(event2);

			cache.flush();

			expect(writeMetricMock).toHaveBeenCalledWith(undefined, event1, 2);
			expect(writeMetricMock).toHaveBeenCalledWith(undefined, event2, 1);
			expect(writeMetricMock).toHaveBeenCalledTimes(2);
		});

		it('should not flush metrics with zero count', () => {
			vi.useFakeTimers();
			const cache = new MetricCache(undefined, 1000);
			const event: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
			};

			// Increment and auto-flush
			cache.increment(event);
			vi.advanceTimersByTime(1100);
			cache.increment(event);

			vi.clearAllMocks();

			// Flush again - should not write since count is 0
			cache.flush();

			expect(writeMetricMock).not.toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('should reset counts after flush', () => {
			const cache = new MetricCache(undefined, 1000);
			const event: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
			};

			cache.increment(event);
			cache.increment(event);
			cache.flush();

			expect(writeMetricMock).toHaveBeenCalledWith(undefined, event, 2);

			vi.clearAllMocks();

			// Increment once more and flush
			cache.increment(event);
			cache.flush();

			// Should only flush count of 1
			expect(writeMetricMock).toHaveBeenCalledWith(undefined, event, 1);
		});

		it('should work with empty cache', () => {
			const cache = new MetricCache(undefined, 1000);

			// Should not throw
			expect(() => cache.flush()).not.toThrow();
			expect(writeMetricMock).not.toHaveBeenCalled();
		});
	});

	describe('Key generation', () => {
		it('should generate same key for identical metrics', () => {
			const cache = new MetricCache(undefined, 1000);
			const event1: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
			};
			const event2: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
			};

			cache.increment(event1);
			cache.increment(event2);
			cache.flush();

			// Should be combined as one metric with count 2
			expect(writeMetricMock).toHaveBeenCalledWith(undefined, expect.any(Object), 2);
			expect(writeMetricMock).toHaveBeenCalledTimes(1);
		});

		it('should ignore sessionId in key generation', () => {
			const cache = new MetricCache(undefined, 1000);
			const event1: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
				sessionId: 'session-1',
			};
			const event2: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
				sessionId: 'session-2',
			};

			cache.increment(event1);
			cache.increment(event2);
			cache.flush();

			// Should be combined despite different sessionIds
			expect(writeMetricMock).toHaveBeenCalledTimes(1);
			expect(writeMetricMock).toHaveBeenCalledWith(undefined, expect.any(Object), 2);
		});

		it('should include targetName in key', () => {
			const cache = new MetricCache(undefined, 1000);
			const event1: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
				targetName: 'target-1',
			};
			const event2: MetricEvent = {
				name: 'test_metric',
				worker: 'opus-transcriber-proxy',
				targetName: 'target-2',
			};

			cache.increment(event1);
			cache.increment(event2);
			cache.flush();

			// Should be tracked separately
			expect(writeMetricMock).toHaveBeenCalledTimes(2);
			expect(writeMetricMock).toHaveBeenCalledWith(undefined, event1, 1);
			expect(writeMetricMock).toHaveBeenCalledWith(undefined, event2, 1);
		});
	});
});
