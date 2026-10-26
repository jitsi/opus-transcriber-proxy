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

import type { StartResult } from './startRetry';

/**
 * Counters pushed from the Worker itself, as OTLP/HTTP JSON, to the same collector and with the
 * same OTLP_* settings the container's metrics use (the Worker already holds them, to forward to
 * the container).
 *
 * The container exports through the OpenTelemetry SDK, which needs timers and a process the Worker
 * runtime does not have, so this builds the payload by hand and POSTs it with fetch.
 *
 * Each push is one delta, as the shared collector expects from a Worker. Every isolate sends the
 * same series identity (no instance dimension: isolates are short-lived, and a series per isolate
 * would lose each one's first count to rate()). The collector restamps delta points with their
 * arrival time, so concurrent or reordered pushes reach its delta-to-cumulative conversion in
 * order; each of its replicas keeps its own running total, tagged `collector_replica`, and stores
 * a counter published as `x` under `x_total`. A query therefore sums across replicas
 * (`sum(rate(x_total[5m]))`), unlike the container's cumulative `otp_*` counters, which take the
 * max across them.
 *
 * A push never throws and never delays the response: callers hand it to ctx.waitUntil, and a
 * failure, a missing token included (the collector answers 401), is only logged.
 */

export interface OtlpEnv {
	/** Collector base URL. Unset, every push is a no-op. */
	OTLP_ENDPOINT?: string;
	/** Copied to `deployment.environment` and `env`, as the container does. */
	OTLP_ENV?: string;
	/** JSON object merged into the resource attributes. Invalid JSON is ignored. */
	OTLP_RESOURCE_ATTRIBUTES?: string;
	/** JSON object of request headers; carries the collector's `Authorization`. */
	OTLP_HEADERS?: string;
}

/** One series of a counter: the increment and its labels. Label values must come from a small fixed set. */
export interface CounterPoint {
	name: string;
	value: number;
	attributes?: Record<string, string>;
}

const SERVICE_NAME = 'opus-transcriber-proxy';
const SCOPE_NAME = 'opus-transcriber-proxy-worker';
const PUSH_TIMEOUT_MS = 5000;

function parseJsonObject(value: string | undefined): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function keyValues(attrs: Record<string, unknown>): { key: string; value: { stringValue: string } }[] {
	return Object.entries(attrs)
		.filter(([, v]) => v !== undefined && v !== null && v !== '')
		.map(([key, v]) => ({ key, value: { stringValue: String(v) } }));
}

/** The OTLP/HTTP JSON body for one push of delta counters. */
export function buildCounterPayload(env: OtlpEnv, points: CounterPoint[], nowMs: number): unknown {
	const resource = {
		'service.name': SERVICE_NAME,
		'deployment.environment': env.OTLP_ENV,
		env: env.OTLP_ENV,
		...parseJsonObject(env.OTLP_RESOURCE_ATTRIBUTES),
		// The deployment's OTLP_RESOURCE_ATTRIBUTES declares the container as the source (the
		// collector cannot detect it), and the Worker shares those settings. A hand-built payload
		// carries no SDK marker either, so this has to say it is the Worker, and win over the merge.
		'cloudflare.source': 'cloudflare-workers',
	};
	const timeUnixNano = `${BigInt(nowMs) * 1_000_000n}`;
	// Each push is its own delta window; a second is enough to bracket it. The collector replaces
	// the end time with the arrival time, so only the start is ours.
	const startTimeUnixNano = `${(BigInt(nowMs) - 1000n) * 1_000_000n}`;

	const byName = new Map<string, CounterPoint[]>();
	for (const point of points) {
		if (!Number.isFinite(point.value)) continue;
		const list = byName.get(point.name) ?? [];
		list.push(point);
		byName.set(point.name, list);
	}

	return {
		resourceMetrics: [
			{
				resource: { attributes: keyValues(resource) },
				scopeMetrics: [
					{
						scope: { name: SCOPE_NAME },
						metrics: [...byName].map(([name, series]) => ({
							name,
							sum: {
								aggregationTemporality: 1, // DELTA
								isMonotonic: true,
								dataPoints: series.map((point) => ({
									startTimeUnixNano,
									timeUnixNano,
									asInt: String(Math.round(point.value)),
									...(point.attributes ? { attributes: keyValues(point.attributes) } : {}),
								})),
							},
						})),
					},
				],
			},
		],
	};
}

/** Push delta counters to the collector. Resolves once the POST settles; never rejects. */
export async function pushCounters(env: OtlpEnv, points: CounterPoint[], now: () => number = Date.now): Promise<void> {
	if (!env.OTLP_ENDPOINT || points.length === 0) return;
	// Configured headers replace ours case-insensitively, so a configured Content-Type is not doubled.
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	for (const [key, value] of Object.entries(parseJsonObject(env.OTLP_HEADERS))) {
		if (typeof value === 'string') headers[key.toLowerCase()] = value;
	}
	try {
		const response = await fetch(`${env.OTLP_ENDPOINT.replace(/\/+$/, '')}/v1/metrics`, {
			method: 'POST',
			headers,
			body: JSON.stringify(buildCounterPayload(env, points, now())),
			signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
		});
		// The collector's answer carries nothing we use, and an unread body holds the connection.
		await response.body?.cancel();
		if (!response.ok) {
			console.error(`Metrics push failed: HTTP ${response.status} (${points.map((p) => p.name).join(', ')})`);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`Metrics push failed: ${msg} (${points.map((p) => p.name).join(', ')})`);
	}
}

/**
 * The counters for one container start: `otp_worker_container_starts{result, colo}` by one, and
 * `otp_worker_container_start_retries{colo}` by the number of retries it took, when there were any.
 * `colo` is the Cloudflare data centre that handled the request (a fixed set of codes).
 */
export function containerStartPoints(result: StartResult, attempts: number, colo: string | undefined): CounterPoint[] {
	const where = { colo: colo || 'unknown' };
	const points: CounterPoint[] = [{ name: 'otp_worker_container_starts', value: 1, attributes: { result, ...where } }];
	if (attempts > 1) points.push({ name: 'otp_worker_container_start_retries', value: attempts - 1, attributes: where });
	return points;
}
