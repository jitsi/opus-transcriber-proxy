/*
 * Copyright @ 2026 - present 8x8, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Unit tests for worker/metrics.ts: the OTLP payload the Worker pushes, the request it makes, and
 * that a failed push is only logged.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	buildCounterPayload,
	CONTAINER_FAILURE_HEADER,
	containerFailureReason,
	containerStartPoints,
	containerUnreachablePoints,
	countLater,
	pushCounters,
} from '../../../worker/metrics';

const ENV = {
	OTLP_ENDPOINT: 'https://collector.example/',
	OTLP_ENV: 'prod',
	OTLP_RESOURCE_ATTRIBUTES: '{"cloudflare.source":"cloudflare-containers","team":"meetings"}',
	OTLP_HEADERS: '{"Authorization":"Bearer secret-token"}',
};

type Payload = {
	resourceMetrics: {
		resource: { attributes: { key: string; value: { stringValue: string } }[] };
		scopeMetrics: { scope: { name: string }; metrics: { name: string; sum: any }[] }[];
	}[];
};

function attrs(list: { key: string; value: { stringValue: string } }[]): Record<string, string> {
	return Object.fromEntries(list.map((a) => [a.key, a.value.stringValue]));
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('buildCounterPayload', () => {
	let resource: Record<string, string>;
	let metrics: { name: string; sum: any }[];
	beforeAll(() => {
		const payload = buildCounterPayload(
			ENV,
			[
				{ name: 'otp_worker_container_starts', value: 1, attributes: { result: 'ok', colo: 'IAD' } },
				{ name: 'otp_worker_container_starts', value: 1, attributes: { result: 'rescued', colo: 'LAX' } },
				{ name: 'otp_worker_container_start_retries', value: 2, attributes: { colo: 'LAX' } },
			],
			1_700_000_000_000,
		) as Payload;
		resource = attrs(payload.resourceMetrics[0].resource.attributes);
		metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
	});

	it('names the service and environment the way the container does, and merges the extra attributes', () => {
		expect(resource['service.name']).toBe('opus-transcriber-proxy');
		expect(resource['deployment.environment']).toBe('prod');
		expect(resource.env).toBe('prod');
		expect(resource.team).toBe('meetings');
	});

	it("declares the Worker as the source even though the shared settings name the container's", () => {
		expect(resource['cloudflare.source']).toBe('cloudflare-workers');
	});

	it('sends each name once, as a monotonic delta sum with one data point per series', () => {
		expect(metrics.map((m) => m.name)).toEqual(['otp_worker_container_starts', 'otp_worker_container_start_retries']);
		const starts = metrics[0].sum;
		expect(starts.aggregationTemporality).toBe(1);
		expect(starts.isMonotonic).toBe(true);
		expect(starts.dataPoints).toHaveLength(2);
		expect(starts.dataPoints[1].asInt).toBe('1');
		expect(attrs(starts.dataPoints[1].attributes)).toEqual({ result: 'rescued', colo: 'LAX' });
		expect(metrics[1].sum.dataPoints[0].asInt).toBe('2');
	});

	it('stamps a one-second window ending now, in nanoseconds', () => {
		const point = metrics[0].sum.dataPoints[0];
		expect(point.timeUnixNano).toBe('1700000000000000000');
		expect(point.startTimeUnixNano).toBe('1699999999000000000');
	});

	it('keeps a structured attribute value readable rather than "[object Object]"', () => {
		const payload = buildCounterPayload({ OTLP_RESOURCE_ATTRIBUTES: '{"k":{"a":1},"l":[1,2]}' }, [{ name: 'x', value: 1 }], 0) as Payload;
		const resource = attrs(payload.resourceMetrics[0].resource.attributes);
		expect(resource.k).toBe('{"a":1}');
		expect(resource.l).toBe('[1,2]');
	});

	it('accepts a clock with fractional milliseconds', () => {
		const payload = buildCounterPayload({}, [{ name: 'x', value: 1 }], 1000.7) as Payload;
		expect(payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].timeUnixNano).toBe('1000000000');
	});

	it('leaves out what is unset and ignores attributes that are not a JSON object', () => {
		const bare = buildCounterPayload({ OTLP_RESOURCE_ATTRIBUTES: 'not json' }, [{ name: 'x', value: 1 }], 0) as Payload;
		const keys = bare.resourceMetrics[0].resource.attributes.map((a) => a.key);
		expect(keys).toEqual(['service.name', 'cloudflare.source']);
		expect(bare.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes).toBeUndefined();
	});
});

describe('pushCounters', () => {
	it('POSTs the payload to <endpoint>/v1/metrics with the configured headers', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await pushCounters(ENV, [{ name: 'x', value: 1 }], () => 1000);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://collector.example/v1/metrics');
		expect(init.method).toBe('POST');
		expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer secret-token' });
		expect(JSON.parse(init.body as string)).toEqual(buildCounterPayload(ENV, [{ name: 'x', value: 1 }], 1000));
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('lets a configured header replace ours whatever its case', async () => {
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		await pushCounters({ ...ENV, OTLP_HEADERS: '{"Content-Type":"application/x-protobuf"}' }, [{ name: 'x', value: 1 }]);
		expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'content-type': 'application/x-protobuf' });
	});

	it('sends no instance identity, so every isolate adds to the same series', () => {
		const payload = buildCounterPayload(ENV, [{ name: 'x', value: 1 }], 0) as Payload;
		expect(payload.resourceMetrics[0].resource.attributes.map((a) => a.key)).not.toContain('service.instance.id');
	});

	it('does nothing when no endpoint is configured, or there is nothing to send', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		await pushCounters({}, [{ name: 'x', value: 1 }]);
		await pushCounters(ENV, []);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('logs a rejected push (a missing token answers 401) and resolves', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(pushCounters(ENV, [{ name: 'x', value: 1 }])).resolves.toBeUndefined();
		expect(error).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
	});

	it('logs a network failure and resolves', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('connection refused');
			}),
		);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(pushCounters(ENV, [{ name: 'x', value: 1 }])).resolves.toBeUndefined();
		expect(error).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
	});

	it('never logs the headers', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		await pushCounters(ENV, [{ name: 'x', value: 1 }]);
		expect(JSON.stringify(error.mock.calls)).not.toContain('secret-token');
	});
});

describe('containerStartPoints', () => {
	const counts = (points: ReturnType<typeof containerStartPoints>) =>
		Object.fromEntries(
			points
				.filter((p) => p.name !== 'otp_worker_container_unreachable')
				.map((p) => [`${p.name}{${p.attributes?.result ?? ''}}`, p.value]),
		);

	it('counts the start under its result, and every other result and the retries as zero', () => {
		expect(counts(containerStartPoints('ok', 1, 'IAD'))).toEqual({
			'otp_worker_container_starts{ok}': 1,
			'otp_worker_container_starts{rescued}': 0,
			'otp_worker_container_starts{gave_up}': 0,
			'otp_worker_container_starts{failed}': 0,
			'otp_worker_container_start_retries{}': 0,
		});
	});

	it('counts the retries a start took', () => {
		const points = containerStartPoints('rescued', 3, 'NRT');
		expect(counts(points)['otp_worker_container_starts{rescued}']).toBe(1);
		expect(counts(points)['otp_worker_container_start_retries{}']).toBe(2);
		expect(points.every((p) => p.attributes?.colo === 'NRT')).toBe(true);
	});

	it('labels a request with no colo as unknown', () => {
		expect(containerStartPoints('failed', 1, undefined).every((p) => p.attributes?.colo === 'unknown')).toBe(true);
	});

	it('keeps the unreachable series alive at zero', () => {
		const unreachable = containerStartPoints('ok', 1, 'IAD').filter((p) => p.name === 'otp_worker_container_unreachable');
		expect(unreachable).toHaveLength(6);
		expect(unreachable.every((p) => p.value === 0)).toBe(true);
	});
});

describe('containerUnreachablePoints', () => {
	it('counts the one path and reason, and the other series as zero', () => {
		const points = containerUnreachablePoints('dispatcher', 'disconnected', 'LAX');
		expect(points.map((p) => [p.attributes?.path, p.attributes?.reason, p.value])).toEqual([
			['direct', 'stub_failed', 0],
			['direct', 'start_failed', 0],
			['direct', 'disconnected', 0],
			['dispatcher', 'stub_failed', 0],
			['dispatcher', 'start_failed', 0],
			['dispatcher', 'disconnected', 1],
		]);
		expect(points.every((p) => p.name === 'otp_worker_container_unreachable' && p.attributes?.colo === 'LAX')).toBe(true);
	});
});

describe('containerFailureReason', () => {
	it("reads the Durable Object's own failure mark", () => {
		expect(containerFailureReason(new Response('x', { status: 500, headers: { [CONTAINER_FAILURE_HEADER]: 'disconnected' } }))).toBe('disconnected');
		expect(containerFailureReason(new Response('x', { status: 503, headers: { [CONTAINER_FAILURE_HEADER]: 'start_failed' } }))).toBe('start_failed');
	});

	it("ignores the container server's own answers, and an unknown mark", () => {
		expect(containerFailureReason(new Response('agent refused', { status: 503 }))).toBeUndefined();
		expect(containerFailureReason(new Response('x', { status: 500, headers: { [CONTAINER_FAILURE_HEADER]: 'other' } }))).toBeUndefined();
	});
});

describe('countLater', () => {
	it('hands the push to waitUntil', () => {
		const ctx = { waitUntil: vi.fn() };
		countLater(ctx as any, {}, () => [{ name: 'x', value: 1 }]);
		expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
	});

	it('never throws into the request, whether building the points or scheduling them fails', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const ctx = {
			waitUntil: vi.fn(() => {
				throw new Error('context ended');
			}),
		};
		expect(() => countLater(ctx as any, {}, () => [])).not.toThrow();
		expect(() =>
			countLater({ waitUntil: vi.fn() } as any, {}, () => {
				throw new Error('bad label');
			}),
		).not.toThrow();
		expect(error).toHaveBeenCalledTimes(2);
	});
});
