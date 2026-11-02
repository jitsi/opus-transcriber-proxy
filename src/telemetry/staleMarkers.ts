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
 * Stale markers for the metrics of a container that stops.
 *
 * Each container exports its otp_* series with its own `service.instance.id`, and in session
 * routing one container serves one meeting. A collector that converts OTLP to Prometheus, such as
 * Grafana Alloy, can keep every series until that series gets a staleness marker (StaleNaN): the
 * global labelstore of Alloy works this way. Alloy writes a StaleNaN only for a data point with
 * the OTLP NO_RECORDED_VALUE flag, and a series that only stops arriving never gets one. So
 * without this module such a collector keeps the series of every container it ever saw, until it
 * restarts.
 *
 * When the container stops, `shutdownTelemetry` sends one more export: the last snapshot that
 * the SDK exported, with the NO_RECORDED_VALUE flag on every data point. The OpenTelemetry JS
 * SDK cannot set data point flags, so this module serializes the snapshot with the SDK's own
 * JSON serializer (the same encoding the exporter sends) and sets the flag on the result.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import type { Aggregation, AggregationTemporality, InstrumentType, PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { JsonMetricsSerializer } from '@opentelemetry/otlp-transformer';

/** OTLP DataPointFlags.FLAG_NO_RECORDED_VALUE. */
export const NO_RECORDED_VALUE_FLAG = 1;

/** The OTLP metric fields that hold data points. */
const DATA_POINT_KINDS = ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary'] as const;

/** One millisecond in nanoseconds: the minimum gap between the last export and the markers. */
const MARKER_GAP_NS = 1_000_000n;

/**
 * A metric exporter that keeps the last snapshot it exported and passes every export on to the
 * wrapped exporter. With cumulative temporality a snapshot holds every series that the process
 * recorded, so the last one names every series that needs a stale marker.
 */
export class SnapshotRecordingExporter implements PushMetricExporter {
	private snapshot: ResourceMetrics | undefined;

	// Both are optional on PushMetricExporter. Define them only when the wrapped exporter does, so
	// the reader keeps its own defaults otherwise.
	readonly selectAggregationTemporality?: (instrumentType: InstrumentType) => AggregationTemporality;
	readonly selectAggregation?: (instrumentType: InstrumentType) => Aggregation;

	constructor(private readonly inner: PushMetricExporter) {
		if (inner.selectAggregationTemporality) {
			this.selectAggregationTemporality = (instrumentType) => inner.selectAggregationTemporality!(instrumentType);
		}
		if (inner.selectAggregation) {
			this.selectAggregation = (instrumentType) => inner.selectAggregation!(instrumentType);
		}
	}

	export(metrics: ResourceMetrics, resultCallback: Parameters<PushMetricExporter['export']>[1]): void {
		if (metrics.scopeMetrics.some((sm) => sm.metrics.length > 0)) {
			this.snapshot = metrics;
		}
		this.inner.export(metrics, resultCallback);
	}

	/** The last snapshot that held data, or undefined if nothing was exported yet. */
	lastSnapshot(): ResourceMetrics | undefined {
		return this.snapshot;
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush();
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown();
	}
}

type OtlpDataPoint = { flags?: number; timeUnixNano?: string };
type OtlpRequest = {
	resourceMetrics?: { scopeMetrics?: { metrics?: Record<string, { dataPoints?: OtlpDataPoint[] } | undefined>[] }[] }[];
};

function dataPointsOf(request: OtlpRequest): OtlpDataPoint[] {
	const points: OtlpDataPoint[] = [];
	for (const rm of request.resourceMetrics ?? []) {
		for (const sm of rm.scopeMetrics ?? []) {
			for (const metric of sm.metrics ?? []) {
				for (const kind of DATA_POINT_KINDS) {
					points.push(...(metric[kind]?.dataPoints ?? []));
				}
			}
		}
	}
	return points;
}

/**
 * Build the OTLP JSON request that marks every series of `snapshot` as stale.
 *
 * Every data point keeps its attributes and values (a histogram keeps its bucket bounds, so each
 * `le` series gets its marker) and gets the NO_RECORDED_VALUE flag. All data points get one
 * timestamp: `nowNanos`, or 1 ms after the latest exported data point if the clock is behind.
 * Alloy skips a data point that is older than the last one it saw for that series.
 *
 * Returns null if the snapshot holds no data points. `dataPoints` counts OTLP data points, not
 * Prometheus series: Alloy makes one histogram data point into `_sum`, `_count` and one series per
 * bucket.
 */
export function buildStaleMarkerRequest(snapshot: ResourceMetrics, nowNanos: bigint): { body: string; dataPoints: number } | null {
	const json = new TextDecoder().decode(JsonMetricsSerializer.serializeRequest(snapshot));
	const request = JSON.parse(json) as OtlpRequest;
	const points = dataPointsOf(request);
	if (points.length === 0) {
		return null;
	}

	let latest = 0n;
	for (const point of points) {
		const time = BigInt(point.timeUnixNano ?? '0');
		if (time > latest) latest = time;
	}
	const markerTime = (nowNanos > latest ? nowNanos : latest + MARKER_GAP_NS).toString();

	for (const point of points) {
		point.flags = NO_RECORDED_VALUE_FLAG;
		point.timeUnixNano = markerTime;
	}

	return { body: JSON.stringify(request), dataPoints: points.length };
}

/** The most bytes of a response body that `postJsonNewConnection` keeps, for the error log. */
export const RESPONSE_BODY_LIMIT_BYTES = 200;

/** The HTTP status of a POST, and the start of its response body. */
export interface PostResult {
	status: number;
	body: string;
}

/**
 * POST a JSON body. Resolves with the status and the first RESPONSE_BODY_LIMIT_BYTES of the
 * response body. Rejects on a network error or timeout.
 */
export type PostJson = (url: string, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<PostResult>;

/**
 * POST on a new connection each time (no keep-alive agent), so that a load balancer in front of
 * several collector replicas can choose a different replica for each send.
 */
export const postJsonNewConnection: PostJson = (url, body, headers, timeoutMs) =>
	new Promise((resolve, reject) => {
		const target = new URL(url);
		const transport = target.protocol === 'https:' ? https : http;
		const request = transport.request(
			target,
			{
				method: 'POST',
				agent: false,
				timeout: timeoutMs,
				headers: {
					...headers,
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body),
					Connection: 'close',
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				let kept = 0;
				response.on('data', (chunk: Buffer) => {
					if (kept < RESPONSE_BODY_LIMIT_BYTES) {
						chunks.push(chunk);
						kept += chunk.length;
					}
				});
				response.on('end', () => {
					const body = Buffer.concat(chunks).subarray(0, RESPONSE_BODY_LIMIT_BYTES).toString('utf8');
					resolve({ status: response.statusCode ?? 0, body: body.replace(/\s+/g, ' ').trim() });
				});
				response.on('error', reject);
			},
		);
		request.on('timeout', () => request.destroy(new Error(`timeout after ${timeoutMs}ms`)));
		request.on('error', reject);
		request.end(body);
	});

export interface SendStaleMarkersOptions {
	url: string;
	body: string;
	headers: Record<string, string>;
	/** How many times to send the body. Each send can reach a different collector replica. */
	sends: number;
	timeoutMs: number;
	post?: PostJson;
}

/**
 * Send the stale-marker request `sends` times in parallel. Never rejects.
 *
 * UGLY STOPGAP. Each collector replica keeps its own series, so each replica that holds this
 * container's series must get the markers. If an LB in front of the replicas picks a backend for
 * each request, the pushes of one container reach several replicas, and the client cannot
 * address a replica itself. So the request goes out many times and relies on chance to reach
 * every replica. For example, 8 sends to 2 replicas miss one with a probability of about 0.8%.
 *
 * The real fix is on the collector. With `--feature.prometheus.direct-fanout.enabled`, Alloy has
 * no global labelstore, the markers do not free memory any more, and one send is enough to end
 * the series in the metrics backend. With that flag, set OTLP_STALE_MARKER_SENDS=1.
 * Routing by `service.instance.id` (a two-tier Alloy with `otelcol.exporter.loadbalancing`)
 * would also make one send enough.
 */
export async function sendStaleMarkers(options: SendStaleMarkersOptions): Promise<{ ok: number; failed: number; errors: string[] }> {
	const post = options.post ?? postJsonNewConnection;
	const attempts = Array.from({ length: Math.max(0, options.sends) }, () =>
		post(options.url, options.body, options.headers, options.timeoutMs),
	);
	const results = await Promise.allSettled(attempts);

	const errors: string[] = [];
	let ok = 0;
	for (const result of results) {
		if (result.status === 'rejected') {
			errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
		} else if (result.value.status >= 200 && result.value.status < 300) {
			ok++;
		} else {
			errors.push(result.value.body ? `HTTP ${result.value.status}: ${result.value.body}` : `HTTP ${result.value.status}`);
		}
	}
	return { ok, failed: errors.length, errors };
}
