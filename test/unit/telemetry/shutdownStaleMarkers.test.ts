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
 * Tests for the stale markers that shutdownTelemetry sends after the final export. These run the
 * real telemetry setup and the real OTLP exporter against a local HTTP server.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { metrics } from '@opentelemetry/api';

const mocked = vi.hoisted(() => ({
	config: {
		otlp: {
			endpoint: '',
			env: '',
			exportIntervalMs: 1_000_000,
			resourceAttributes: {} as Record<string, string>,
			headers: {} as Record<string, string>,
			staleMarkerSends: 2,
		},
	},
}));

vi.mock('../../../src/config', () => ({ config: mocked.config }));
vi.mock('../../../src/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

type DataPoint = { flags?: number };
type MetricsRequest = { resourceMetrics: { scopeMetrics: { metrics: Record<string, { dataPoints?: DataPoint[] }>[] }[] }[] };

/** The flags of every data point in one OTLP JSON request. */
function flagsOf(body: string): (number | undefined)[] {
	const request = JSON.parse(body) as MetricsRequest;
	return request.resourceMetrics.flatMap((rm) =>
		rm.scopeMetrics.flatMap((sm) =>
			sm.metrics.flatMap((metric) => ['sum', 'gauge', 'histogram'].flatMap((kind) => (metric[kind]?.dataPoints ?? []).map((p) => p.flags))),
		),
	);
}

describe('shutdownTelemetry stale markers', () => {
	let server: http.Server;
	let bodies: string[];

	beforeEach(async () => {
		bodies = [];
		server = http.createServer((req, res) => {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				if (req.url === '/v1/metrics') bodies.push(body);
				res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		mocked.config.otlp.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		mocked.config.otlp.staleMarkerSends = 2;
		vi.resetModules();
	});

	afterEach(async () => {
		metrics.disable();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	async function runSession(record: boolean): Promise<void> {
		const telemetry = await import('../../../src/telemetry');
		telemetry.initTelemetry();
		if (record) {
			telemetry.getMeter().createCounter('otp_session_starts_total').add(1);
		}
		await telemetry.shutdownTelemetry();
	}

	it('sends the final export first and then the stale markers, once for each configured send', async () => {
		await runSession(true);

		expect(bodies.map(flagsOf)).toEqual([[undefined], [1], [1]]);
	});

	it('sends only the final export when OTLP_STALE_MARKER_SENDS is 0', async () => {
		mocked.config.otlp.staleMarkerSends = 0;

		await runSession(true);

		expect(bodies.map(flagsOf)).toEqual([[undefined]]);
	});

	it('sends no stale markers when the process recorded no metrics', async () => {
		await runSession(false);

		expect(bodies.flatMap(flagsOf)).not.toContain(1);
	});
});
