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
 * Tests for the stale-marker export sent when the container stops.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Resource } from '@opentelemetry/resources';
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
	type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { JsonMetricsSerializer } from '@opentelemetry/otlp-transformer';
import {
	NO_RECORDED_VALUE_FLAG,
	RESPONSE_BODY_LIMIT_BYTES,
	SnapshotRecordingExporter,
	buildStaleMarkerRequest,
	postJsonNewConnection,
	sendStaleMarkers,
} from '../../../src/telemetry/staleMarkers';

const RESOURCE_ATTRS = { 'service.name': 'opus-transcriber-proxy', 'service.instance.id': 'meeting-1' };

/** Record one value on each instrument kind the proxy uses, export once, return the snapshot. */
async function recordSnapshot(): Promise<{ snapshot: ResourceMetrics; recorder: SnapshotRecordingExporter }> {
	const recorder = new SnapshotRecordingExporter(new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE));
	const reader = new PeriodicExportingMetricReader({ exporter: recorder, exportIntervalMillis: 1_000_000 });
	const provider = new MeterProvider({ resource: new Resource(RESOURCE_ATTRS), readers: [reader] });
	const meter = provider.getMeter('test');

	meter.createCounter('otp_backend_errors_total').add(1, { provider: 'xai', type: 'api_error' });
	meter.createCounter('otp_backend_errors_total').add(2, { provider: 'xai', type: 'websocket_error' });
	meter.createUpDownCounter('otp_sessions_active').add(1);
	meter.createHistogram('otp_session_duration_seconds', { advice: { explicitBucketBoundaries: [60, 300] } }).record(120);
	meter.createObservableGauge('otp_dispatcher_queue_depth').addCallback((result) => result.observe(3));

	await provider.forceFlush();
	await provider.shutdown();
	const snapshot = recorder.lastSnapshot();
	if (!snapshot) throw new Error('the recorder kept no snapshot');
	return { snapshot, recorder };
}

type DataPoint = { flags?: number; timeUnixNano: string; attributes?: { key: string }[]; explicitBounds?: number[] };
type Request = {
	resourceMetrics: {
		resource: { attributes: { key: string; value: { stringValue?: string } }[] };
		scopeMetrics: { metrics: Record<string, unknown>[] }[];
	}[];
};

function parse(body: string): Request {
	return JSON.parse(body) as Request;
}

function dataPointsOf(request: Request): DataPoint[] {
	const points: DataPoint[] = [];
	for (const rm of request.resourceMetrics) {
		for (const sm of rm.scopeMetrics) {
			for (const metric of sm.metrics) {
				for (const kind of ['sum', 'gauge', 'histogram']) {
					const data = metric[kind] as { dataPoints: DataPoint[] } | undefined;
					if (data) points.push(...data.dataPoints);
				}
			}
		}
	}
	return points;
}

describe('buildStaleMarkerRequest', () => {
	it('flags every data point as no recorded value', async () => {
		const { snapshot } = await recordSnapshot();

		const result = buildStaleMarkerRequest(snapshot, 0n);

		const points = dataPointsOf(parse(result!.body));
		expect(points.length).toBe(5);
		expect(points.every((p) => p.flags === NO_RECORDED_VALUE_FLAG)).toBe(true);
	});

	it('reports the number of data points it marks', async () => {
		const { snapshot } = await recordSnapshot();

		expect(buildStaleMarkerRequest(snapshot, 0n)!.dataPoints).toBe(5);
	});

	it('keeps the resource attributes, so the series identity matches the earlier exports', async () => {
		const { snapshot } = await recordSnapshot();

		const request = parse(buildStaleMarkerRequest(snapshot, 0n)!.body);

		const attrs = request.resourceMetrics[0].resource.attributes;
		expect(attrs).toContainEqual({ key: 'service.instance.id', value: { stringValue: 'meeting-1' } });
	});

	it('keeps the data point attributes', async () => {
		const { snapshot } = await recordSnapshot();

		const points = dataPointsOf(parse(buildStaleMarkerRequest(snapshot, 0n)!.body));

		const types = points.flatMap((p) => (p.attributes ?? []).filter((a) => a.key === 'type'));
		expect(types.length).toBe(2);
	});

	it('keeps the histogram bucket bounds, so every le series gets its marker', async () => {
		const { snapshot } = await recordSnapshot();

		const points = dataPointsOf(parse(buildStaleMarkerRequest(snapshot, 0n)!.body));

		expect(points.find((p) => p.explicitBounds)?.explicitBounds).toEqual([60, 300]);
	});

	it('stamps the markers later than every exported data point when the clock is behind', async () => {
		const { snapshot } = await recordSnapshot();
		const exported = dataPointsOf(parse(new TextDecoder().decode(JsonMetricsSerializer.serializeRequest(snapshot))));
		const latestExported = exported.reduce((max, p) => (BigInt(p.timeUnixNano) > max ? BigInt(p.timeUnixNano) : max), 0n);

		const points = dataPointsOf(parse(buildStaleMarkerRequest(snapshot, 0n)!.body));

		expect(points.every((p) => BigInt(p.timeUnixNano) > latestExported)).toBe(true);
	});

	it('stamps the markers with the given time when it is later than the exported data', async () => {
		const { snapshot } = await recordSnapshot();
		const now = BigInt(Date.now() + 60_000) * 1_000_000n;

		const points = dataPointsOf(parse(buildStaleMarkerRequest(snapshot, now)!.body));

		expect(points.every((p) => p.timeUnixNano === now.toString())).toBe(true);
	});

	it('returns null for a snapshot without data points', () => {
		const empty: ResourceMetrics = { resource: new Resource(RESOURCE_ATTRS), scopeMetrics: [] };

		expect(buildStaleMarkerRequest(empty, 0n)).toBeNull();
	});
});

describe('SnapshotRecordingExporter', () => {
	it('keeps the last of several exported snapshots', async () => {
		const recorder = new SnapshotRecordingExporter(new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE));
		const first = (await recordSnapshot()).snapshot;
		const second = (await recordSnapshot()).snapshot;

		await new Promise<void>((resolve) => recorder.export(first, () => resolve()));
		await new Promise<void>((resolve) => recorder.export(second, () => resolve()));

		expect(recorder.lastSnapshot()).toBe(second);
	});

	it('passes each export to the wrapped exporter', async () => {
		const inner = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		const recorder = new SnapshotRecordingExporter(inner);
		const snapshot: ResourceMetrics = { resource: new Resource(RESOURCE_ATTRS), scopeMetrics: [] };

		await new Promise<void>((resolve) => recorder.export(snapshot, () => resolve()));

		expect(inner.getMetrics()).toEqual([snapshot]);
	});

	it('uses the aggregation temporality of the wrapped exporter', () => {
		const recorder = new SnapshotRecordingExporter(new InMemoryMetricExporter(AggregationTemporality.DELTA));

		expect(recorder.selectAggregationTemporality!(0)).toBe(AggregationTemporality.DELTA);
	});

	it('keeps an earlier snapshot when a later export holds no data points', async () => {
		const recorder = new SnapshotRecordingExporter(new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE));
		const { snapshot } = await recordSnapshot();
		const empty: ResourceMetrics = { resource: new Resource(RESOURCE_ATTRS), scopeMetrics: [] };

		await new Promise<void>((resolve) => recorder.export(snapshot, () => resolve()));
		await new Promise<void>((resolve) => recorder.export(empty, () => resolve()));

		expect(recorder.lastSnapshot()).toBe(snapshot);
	});
});

describe('sendStaleMarkers', () => {
	const base = { url: 'https://otlp.example/v1/metrics', body: '{}', headers: { Authorization: 'Bearer x' }, timeoutMs: 1000 };

	const ok = { status: 200, body: '' };

	it('posts the body the given number of times', async () => {
		const post = vi.fn().mockResolvedValue(ok);

		await sendStaleMarkers({ ...base, sends: 4, post });

		expect(post).toHaveBeenCalledTimes(4);
	});

	it('posts the body and the configured headers to the url', async () => {
		const post = vi.fn().mockResolvedValue(ok);

		await sendStaleMarkers({ ...base, sends: 1, post });

		expect(post).toHaveBeenCalledWith(base.url, base.body, base.headers, base.timeoutMs);
	});

	it('posts nothing when sends is 0', async () => {
		const post = vi.fn().mockResolvedValue(ok);

		await sendStaleMarkers({ ...base, sends: 0, post });

		expect(post).not.toHaveBeenCalled();
	});

	it('counts a non-2xx answer and a network error as failures', async () => {
		const post = vi
			.fn()
			.mockResolvedValueOnce(ok)
			.mockResolvedValueOnce({ status: 503, body: '' })
			.mockRejectedValueOnce(new Error('reset'));

		const result = await sendStaleMarkers({ ...base, sends: 3, post });

		expect(result).toEqual({ ok: 1, failed: 2, errors: ['HTTP 503', 'reset'] });
	});

	it('puts the response body of a non-2xx answer in the error', async () => {
		const post = vi.fn().mockResolvedValue({ status: 401, body: 'missing bearer token' });

		const result = await sendStaleMarkers({ ...base, sends: 1, post });

		expect(result.errors).toEqual(['HTTP 401: missing bearer token']);
	});
});

describe('postJsonNewConnection', () => {
	type Received = { method?: string; headers: http.IncomingHttpHeaders; body: string };
	let server: http.Server;
	let url: string;
	let received: Received[];
	let answer: (res: http.ServerResponse) => void;

	beforeEach(async () => {
		received = [];
		answer = (res) => res.writeHead(200).end('{}');
		server = http.createServer((req, res) => {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				received.push({ method: req.method, headers: req.headers, body });
				answer(res);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/metrics`;
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it('POSTs the JSON body with the given headers on a connection that closes after the request', async () => {
		await postJsonNewConnection(url, '{"a":1}', { Authorization: 'Bearer x' }, 1000);

		expect(received).toEqual([
			{
				method: 'POST',
				body: '{"a":1}',
				headers: expect.objectContaining({
					authorization: 'Bearer x',
					'content-type': 'application/json',
					connection: 'close',
				}),
			},
		]);
	});

	it('resolves with the status of a 2xx answer', async () => {
		const result = await postJsonNewConnection(url, '{}', {}, 1000);

		expect(result.status).toBe(200);
	});

	it('resolves with the status and the body of a non-2xx answer', async () => {
		answer = (res) => res.writeHead(401).end('missing\n bearer token');

		const result = await postJsonNewConnection(url, '{}', {}, 1000);

		expect(result).toEqual({ status: 401, body: 'missing bearer token' });
	});

	it('keeps at most RESPONSE_BODY_LIMIT_BYTES of the response body', async () => {
		answer = (res) => res.writeHead(500).end('x'.repeat(RESPONSE_BODY_LIMIT_BYTES * 5));

		const result = await postJsonNewConnection(url, '{}', {}, 1000);

		expect(result.body.length).toBe(RESPONSE_BODY_LIMIT_BYTES);
	});

	it('rejects when the server does not answer within the timeout', async () => {
		answer = () => {};

		await expect(postJsonNewConnection(url, '{}', {}, 100)).rejects.toThrow('timeout after 100ms');
	});

	it('rejects when nothing listens on the port', async () => {
		// afterEach closes the server again. That second close only reports "not running".
		await new Promise<void>((resolve) => server.close(() => resolve()));

		await expect(postJsonNewConnection(url, '{}', {}, 1000)).rejects.toThrow();
	});
});
