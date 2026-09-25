/**
 * Tests for XAIBackend module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XAIBackend, resetXAIConnectCooldown } from '../../../src/backends/XAIBackend';
import type { MockWebSocketInstance } from '../../helpers/websocket-mock';
import type { BackendConfig, AudioFormat } from '../../../src/backends/TranscriptionBackend';
import type { TranscriptionMessage } from '../../../src/transcriberproxy';
import { config } from '../../../src/config';
import logger from '../../../src/logger';
import { writeMetric } from '../../../src/metrics';

// Track the WsWebSocket instances created by the ws mock (one per handshake attempt).
// Defined at module scope so the vi.mock factory (hoisted before imports) can reference them.
let lastWsInstance: any = null;
const wsInstances: any[] = [];

// vi.mock is hoisted to the top of the file by vitest — the factory cannot reference
// symbols imported above. We define a self-contained mock here instead.
vi.mock('ws', () => {
	const { EventEmitter } = require('node:events');

	class MockWs extends EventEmitter {
		public readyState = 1; // OPEN
		public url: string;
		private _sentMessages: any[] = [];
		private _listeners: Map<string, Set<Function>> = new Map();
		static OPEN = 1;
		static CLOSED = 3;

		public options: any;

		constructor(url: string, options?: any) {
			super();
			this.url = url;
			this.options = options;
			lastWsInstance = this;
			wsInstances.push(this);
		}

		addEventListener(event: string, handler: Function): void {
			if (!this._listeners.has(event)) this._listeners.set(event, new Set());
			this._listeners.get(event)!.add(handler);
		}

		send(data: any): void { this._sentMessages.push(data); }
		close(): void { this.readyState = 3; }
		terminate(): void { this.readyState = 3; }
		getSentMessages(): any[] { return [...this._sentMessages]; }
		clearSentMessages(): void { this._sentMessages = []; }

		_trigger(event: string, data: any): void {
			this._listeners.get(event)?.forEach((fn) => fn(data));
		}

		simulateOpen(): void { this.readyState = 1; this._trigger('open', {}); }
		simulateMessage(data: any): void { this._trigger('message', { data }); }
		simulateError(msg: string): void { this._trigger('error', { message: msg }); }

		/**
		 * Reject the upgrade the way `ws` does: emit 'unexpected-response' with the
		 * ClientRequest and the HTTP response. Real `ws` only emits this when a listener
		 * is attached — otherwise it raises "Unexpected server response: <code>".
		 */
		simulateUnexpectedResponse(status: number, headers: Record<string, string> = {}, body = ''): void {
			const req = { destroy: () => {} };
			const res = new EventEmitter() as any;
			res.statusCode = status;
			res.statusMessage = status === 503 ? 'Service Unavailable' : 'Error';
			res.headers = headers;
			res.destroy = () => {};
			// The backend reads the body as text, like it does off a real IncomingMessage.
			res.setEncoding = () => {};
			this.emit('unexpected-response', req, res);
			// The body arrives asynchronously, after the backend has attached its readers.
			setImmediate(() => {
				if (body) res.emit('data', body);
				res.emit('end');
			});
		}

		simulateUpgrade(headers: Record<string, string> = {}): void {
			this.emit('upgrade', { statusCode: 101, headers });
		}
		simulateClose(code = 1000, reason = '', wasClean = true): void {
			this.readyState = 3;
			this._trigger('close', { code, reason, wasClean });
		}
	}

	return { default: MockWs };
});

function getMockWs(): any {
	if (!lastWsInstance) throw new Error('No ws instance created yet');
	return lastWsInstance;
}

vi.mock('../../../src/logger', () => ({
	default: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../src/metrics', () => ({
	writeMetric: vi.fn(),
}));

// The OTel handshake-failure counter. vi.hoisted so the (hoisted) mock factory can see it.
const { handshakeFailuresAdd } = vi.hoisted(() => ({ handshakeFailuresAdd: vi.fn() }));
vi.mock('../../../src/telemetry/instruments', () => ({
	getInstruments: () => ({ backendHandshakeFailuresTotal: { add: handshakeFailuresAdd } }),
}));

vi.mock('../../../src/config', () => ({
	config: {
		xai: {
			apiKey: 'test-xai-key',
			sttUrl: 'wss://api.x.ai/v1/stt',
			language: undefined,
			diarize: false,
			includeLanguage: false,
			endpointing: 850,
			smartTurn: undefined,
			smartTurnTimeout: 500,
			granularFinals: false,
			granularStabilityMs: 1000,
			granularGuardWords: 3,
			granularMinWords: 5,
			maxTurnMs: 15000,
			idleTurnEndGraceMs: 3000,
			// 1 attempt by default so the existing tests see the pre-retry behaviour;
			// the retry tests raise it. Zero backoff keeps them fast.
			connectAttempts: 1,
			connectBackoffMs: 0,
		},
	},
}));

const DEFAULT_CONFIG: BackendConfig = { model: undefined, language: undefined, prompt: undefined };

describe('XAIBackend', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastWsInstance = null;
		wsInstances.length = 0;
		(config.xai as any).connectAttempts = 1;
		resetXAIConnectCooldown();
	});

	describe('Constructor', () => {
		it('should initialize with pending status', () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			expect(backend.getStatus()).toBe('pending');
		});
	});

	describe('getDesiredAudioFormat', () => {
		it('should always return l16 at 16kHz', () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const inputFormat: AudioFormat = { encoding: 'opus', sampleRate: 48000 };
			expect(backend.getDesiredAudioFormat(inputFormat)).toEqual({ encoding: 'l16', sampleRate: 16000 });
		});
	});

	describe('connect', () => {
		it('should connect and build URL with required params', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			expect(getMockWs().url).toContain('wss://api.x.ai/v1/stt');
			expect(getMockWs().url).toContain('sample_rate=16000');
			expect(getMockWs().url).toContain('encoding=pcm');
			expect(getMockWs().url).toContain('interim_results=true');
			expect(backend.getStatus()).toBe('connected');
		});

		it('should include language from backendConfig', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect({ ...DEFAULT_CONFIG, language: 'fr' });
			getMockWs().simulateOpen();
			await connectPromise;

			expect(getMockWs().url).toContain('language=fr');
		});

		it('should include language from global config if not in backendConfig', async () => {
			(config.xai as any).language = 'de';
			try {
				const backend = new XAIBackend('test-tag', { id: 'p1' });
				const connectPromise = backend.connect(DEFAULT_CONFIG);
				getMockWs().simulateOpen();
				await connectPromise;

				expect(getMockWs().url).toContain('language=de');
			} finally {
				(config.xai as any).language = undefined;
			}
		});

		it('should include diarize param when enabled', async () => {
			(config.xai as any).diarize = true;
			try {
				const backend = new XAIBackend('test-tag', { id: 'p1' });
				const connectPromise = backend.connect(DEFAULT_CONFIG);
				getMockWs().simulateOpen();
				await connectPromise;

				expect(getMockWs().url).toContain('diarize=true');
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('should send endpointing and NOT smart_turn by default (one stream per participant)', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			expect(getMockWs().url).toContain('endpointing=850');
			expect(getMockWs().url).not.toContain('smart_turn');
		});

		it('should send smart_turn params only when configured', async () => {
			(config.xai as any).smartTurn = 0.7;
			(config.xai as any).smartTurnTimeout = 3000;
			try {
				const backend = new XAIBackend('test-tag', { id: 'p1' });
				const connectPromise = backend.connect(DEFAULT_CONFIG);
				getMockWs().simulateOpen();
				await connectPromise;

				expect(getMockWs().url).toContain('smart_turn=0.7');
				expect(getMockWs().url).toContain('smart_turn_timeout=3000');
			} finally {
				(config.xai as any).smartTurn = undefined;
				(config.xai as any).smartTurnTimeout = 500;
			}
		});

		it('should apply per-connection endpointing override over config', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect({ ...DEFAULT_CONFIG, xaiEndpointing: 300 });
			getMockWs().simulateOpen();
			await connectPromise;

			expect(getMockWs().url).toContain('endpointing=300');
		});

		it('should enable smart_turn via per-connection override even when config disables it', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect({ ...DEFAULT_CONFIG, xaiSmartTurn: 0.4, xaiSmartTurnTimeout: 1200 });
			getMockWs().simulateOpen();
			await connectPromise;

			expect(getMockWs().url).toContain('smart_turn=0.4');
			expect(getMockWs().url).toContain('smart_turn_timeout=1200');
		});

		it('should reject when API key is missing', async () => {
			(config.xai as any).apiKey = '';
			try {
				const backend = new XAIBackend('test-tag', { id: 'p1' });
				await expect(backend.connect(DEFAULT_CONFIG)).rejects.toThrow('XAI_API_KEY not configured');
			} finally {
				(config.xai as any).apiKey = 'test-xai-key';
			}
		});

		it('should set status to failed on WebSocket error', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateError('connection refused');
			await expect(connectPromise).rejects.toThrow();
			expect(backend.getStatus()).toBe('closed');
		});
	});

	describe('handshake failures (retry + diagnostics)', () => {
		/**
		 * Wait until the mock has created `count` sockets — each retry creates a new one.
		 *
		 * Polls on a real timer, NOT on a count of setImmediate ticks: the retry is gated
		 * on waitBeforeRetry's setTimeout, and Node clamps even a 0ms timeout to 1ms, so a
		 * tick-counting loop can spin out its whole budget inside that 1ms and report a
		 * retry that was merely still pending as one that never happened.
		 */
		async function waitForWsInstances(count: number): Promise<any> {
			return vi.waitFor(
				() => {
					if (wsInstances.length < count) {
						throw new Error(`expected ${count} ws instance(s), saw ${wsInstances.length}`);
					}
					return wsInstances[count - 1];
				},
				{ timeout: 2000, interval: 5 },
			);
		}

		const errorLogs = (): string[] => (logger.error as any).mock.calls.map((args: any[]) => String(args[0]));
		const warnLogs = (): string[] => (logger.warn as any).mock.calls.map((args: any[]) => String(args[0]));

		it('retries a 503 upgrade rejection and connects on the next attempt', async () => {
			(config.xai as any).connectAttempts = 3;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateUnexpectedResponse(503, { 'x-request-id': 'req-1' }, '{"error":"unavailable"}');
			const second = await waitForWsInstances(2);
			second.simulateOpen();

			await connectPromise;
			expect(backend.getStatus()).toBe('connected');
			expect(wsInstances).toHaveLength(2);
		});

		it('retries a pre-open transport error', async () => {
			(config.xai as any).connectAttempts = 2;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateError('ECONNRESET');
			const second = await waitForWsInstances(2);
			second.simulateOpen();

			await connectPromise;
			expect(backend.getStatus()).toBe('connected');
		});

		it('logs the status, request id, retry-after and body of a rejected upgrade', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateUnexpectedResponse(
				503,
				{ 'x-request-id': 'req-abc123', 'retry-after': '1' },
				'{"error":"backend temporarily unavailable"}',
			);

			await expect(connectPromise).rejects.toThrow(/HTTP 503/);

			const rejection = errorLogs().find((line) => line.includes('handshake rejected for tag'));
			expect(rejection).toBeDefined();
			expect(rejection).toContain('status=503');
			expect(rejection).toContain('requestId=req-abc123');
			expect(rejection).toContain('retryAfter=1');
			expect(rejection).toContain('backend temporarily unavailable');
			// The endpoint (and its params) go in the same line — xAI support asks for it.
			expect(rejection).toContain('wss://api.x.ai/v1/stt?');
		});

		it('retries a Cloudflare origin failure (521) — api.x.ai sits behind Cloudflare', async () => {
			(config.xai as any).connectAttempts = 2;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateUnexpectedResponse(521, { 'cf-ray': 'ray-1' }, 'web server is down');
			const second = await waitForWsInstances(2);
			second.simulateOpen();

			await connectPromise;
			expect(backend.getStatus()).toBe('connected');
		});

		it('retries a 404 — xAI answered 404 fleet-wide during the 2026-09-22 outage', async () => {
			(config.xai as any).connectAttempts = 2;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			// The real rejection carried an empty body and no error detail whatsoever.
			wsInstances[0].simulateUnexpectedResponse(404, { 'cf-ray': 'a3ed619c9d00efd6-PDX' }, '');
			const second = await waitForWsInstances(2);
			second.simulateOpen();

			await connectPromise;
			expect(backend.getStatus()).toBe('connected');
		});

		it('retries any status that is not an auth failure', async () => {
			for (const status of [400, 404, 418, 500, 521]) {
				resetXAIConnectCooldown();
				wsInstances.length = 0;
				(config.xai as any).connectAttempts = 2;
				const backend = new XAIBackend('test-tag', { id: 'p1' });
				const connectPromise = backend.connect(DEFAULT_CONFIG);

				wsInstances[0].simulateUnexpectedResponse(status, {}, '');
				const second = await waitForWsInstances(2);
				second.simulateOpen();

				await connectPromise;
				expect(backend.getStatus(), `status ${status} should be retried`).toBe('connected');
				backend.close();
			}
		});

		it('does not retry a non-retryable status (401)', async () => {
			(config.xai as any).connectAttempts = 4;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateUnexpectedResponse(401, { 'x-request-id': 'req-auth' }, '{"error":"invalid api key"}');

			await expect(connectPromise).rejects.toThrow(/HTTP 401/);
			expect(wsInstances).toHaveLength(1);
		});

		it('does not retry a non-retryable status (403)', async () => {
			(config.xai as any).connectAttempts = 4;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateUnexpectedResponse(403, { 'x-request-id': 'req-forbidden' }, '{"error":"forbidden"}');

			await expect(connectPromise).rejects.toThrow(/HTTP 403/);
			expect(wsInstances).toHaveLength(1);
		});

		it('reports websocket_error with the status and request id after exhausting attempts', async () => {
			(config.xai as any).connectAttempts = 2;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const onError = vi.fn();
			backend.onError = onError;
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateUnexpectedResponse(503, { 'x-request-id': 'req-1' });
			const second = await waitForWsInstances(2);
			second.simulateUnexpectedResponse(503, { 'x-request-id': 'req-2' });

			await expect(connectPromise).rejects.toThrow(/HTTP 503/);
			// errorType stays 'websocket_error' so otp_backend_errors_total{type=...} keeps
			// its meaning; the status and request id ride along in the message.
			expect(onError).toHaveBeenCalledWith('websocket_error', expect.stringContaining('HTTP 503'));
			expect(onError).toHaveBeenCalledWith('websocket_error', expect.stringContaining('req-2'));
			expect(backend.getStatus()).toBe('closed');
		});

		it('honours a Retry-After the server sent, in place of its own backoff', async () => {
			(config.xai as any).connectAttempts = 2;
			(config.xai as any).connectBackoffMs = 60_000; // would never fire inside the test
			try {
				const backend = new XAIBackend('test-tag', { id: 'p1' });
				const connectPromise = backend.connect(DEFAULT_CONFIG);

				// Retry-After: 0 → retry immediately, rather than the 60s backoff.
				wsInstances[0].simulateUnexpectedResponse(503, { 'retry-after': '0' });
				const second = await waitForWsInstances(2);
				second.simulateOpen();

				await connectPromise;
				expect(backend.getStatus()).toBe('connected');
				expect((logger.warn as any).mock.calls.some((args: any[]) => String(args[0]).includes('(Retry-After)'))).toBe(true);
			} finally {
				(config.xai as any).connectBackoffMs = 0;
			}
		});

		it('caps a Retry-After beyond the ceiling instead of giving up', async () => {
			(config.xai as any).connectAttempts = 4;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			// 30s is far longer than we are willing to buffer a participant's audio for — but
			// not retrying at all would not honour it either (the next media frame would open
			// a fresh connection immediately), so the wait is capped, not skipped.
			wsInstances[0].simulateUnexpectedResponse(503, { 'retry-after': '30' });
			await vi.waitFor(() => expect(warnLogs().some((line) => line.includes('capping at 4000ms'))).toBe(true));
			expect(warnLogs().some((line) => line.includes('retrying in 4000ms (Retry-After)'))).toBe(true);
			expect(wsInstances).toHaveLength(1);

			// Cut the capped wait short rather than sitting through 4s in a unit test.
			backend.close();
			await expect(connectPromise).rejects.toThrow(/HTTP 503/);
			expect(wsInstances).toHaveLength(1);
		});

		it('does not retry when connectAttempts is 1, even for a retryable status', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateUnexpectedResponse(503);

			await expect(connectPromise).rejects.toThrow(/HTTP 503/);
			expect(wsInstances).toHaveLength(1);
		});

		it('retries a close that arrives during the handshake with no error event', async () => {
			(config.xai as any).connectAttempts = 2;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateClose(1006, '', false);
			const second = await waitForWsInstances(2);
			second.simulateOpen();

			await connectPromise;
			expect(backend.getStatus()).toBe('connected');
		});

		it('stops retrying when close() is called during the backoff window', async () => {
			(config.xai as any).connectAttempts = 4;
			// Long enough that the retry cannot fire before close() lands, whatever the
			// runner's timing — the test is about the guard, not about racing the sleep.
			(config.xai as any).connectBackoffMs = 5000;
			try {
				const backend = new XAIBackend('test-tag', { id: 'p1' });
				const connectPromise = backend.connect(DEFAULT_CONFIG);

				wsInstances[0].simulateUnexpectedResponse(503);
				// Wait for the attempt to actually fail (the retry log) before closing, so
				// we are provably inside the backoff window and not ahead of it.
				await vi.waitFor(() =>
					expect((logger.warn as any).mock.calls.some((args: any[]) => String(args[0]).includes('retrying in'))).toBe(true),
				);
				const closedAt = Date.now();
				backend.close();

				await expect(connectPromise).rejects.toThrow(/HTTP 503/);
				expect(wsInstances).toHaveLength(1);
				// close() cuts the wait short instead of leaving connect() parked for the
				// remaining 5s of backoff.
				expect(Date.now() - closedAt).toBeLessThan(1000);
			} finally {
				(config.xai as any).connectBackoffMs = 0;
			}
		});

		it('accepts an HTTP-date Retry-After as well as delay-seconds', async () => {
			(config.xai as any).connectAttempts = 4;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			// A date ~60s out is past the ceiling, so this both proves the HTTP-date form
			// parses and that the cap applies to it.
			const httpDate = new Date(Date.now() + 60_000).toUTCString();
			wsInstances[0].simulateUnexpectedResponse(503, { 'retry-after': httpDate });
			await vi.waitFor(() => expect(warnLogs().some((line) => line.includes('capping at 4000ms'))).toBe(true));

			backend.close();
			await expect(connectPromise).rejects.toThrow(/HTTP 503/);
			expect(wsInstances).toHaveLength(1);
		});

		it('counts each rejection under its HTTP status', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateUnexpectedResponse(503);

			await expect(connectPromise).rejects.toThrow(/HTTP 503/);
			expect(writeMetric).toHaveBeenCalledWith(undefined, expect.objectContaining({ errorType: 'upgrade_http_503' }));
			// The terminal metric keeps the historical type, whatever the status was.
			expect(writeMetric).toHaveBeenCalledWith(undefined, expect.objectContaining({ errorType: 'websocket_error' }));
		});

		it('bounds each handshake attempt so a silent endpoint cannot hang connect()', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			expect(wsInstances[0].options.handshakeTimeout).toBeGreaterThan(0);

			wsInstances[0].simulateOpen();
			await connectPromise;
		});

		it('records the request id of a successful handshake and includes it in stream errors', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			wsInstances[0].simulateUpgrade({ 'x-request-id': 'req-live' });
			wsInstances[0].simulateOpen();
			await connectPromise;

			wsInstances[0].simulateMessage(JSON.stringify({ type: 'error', message: 'ASR stream timed out' }));

			expect(errorLogs().some((line) => line.includes('requestId=req-live'))).toBe(true);
		});

		it('leaves a process-wide cooldown after exhausting attempts, which the next connect waits out', async () => {
			(config.xai as any).connectBackoffMs = 250;
			try {
				const first = new XAIBackend('tag-a', { id: 'p1' });
				const firstConnect = first.connect(DEFAULT_CONFIG);
				wsInstances[0].simulateUnexpectedResponse(503);
				await expect(firstConnect).rejects.toThrow(/HTTP 503/);

				// A fresh backend — what the participant's next media frame creates once the
				// first one is torn down — must not hit xAI again immediately.
				const second = new XAIBackend('tag-b', { id: 'p2' });
				const secondConnect = second.connect(DEFAULT_CONFIG);
				expect(wsInstances).toHaveLength(1);
				expect(warnLogs().some((line) => line.includes('deferred'))).toBe(true);

				const ws = await vi.waitFor(
					() => {
						expect(wsInstances).toHaveLength(2);
						return wsInstances[1];
					},
					{ timeout: 2000 },
				);
				ws.simulateOpen();
				await secondConnect;
				expect(second.getStatus()).toBe('connected');
			} finally {
				(config.xai as any).connectBackoffMs = 0;
			}
		});

		it('leaves no cooldown behind after a non-retryable rejection', async () => {
			(config.xai as any).connectBackoffMs = 250;
			try {
				const first = new XAIBackend('tag-a', { id: 'p1' });
				const firstConnect = first.connect(DEFAULT_CONFIG);
				wsInstances[0].simulateUnexpectedResponse(401);
				await expect(firstConnect).rejects.toThrow(/HTTP 401/);

				const second = new XAIBackend('tag-b', { id: 'p2' });
				const secondConnect = second.connect(DEFAULT_CONFIG);
				expect(wsInstances).toHaveLength(2);
				expect(warnLogs().some((line) => line.includes('deferred'))).toBe(false);
				wsInstances[1].simulateOpen();
				await secondConnect;
			} finally {
				(config.xai as any).connectBackoffMs = 0;
			}
		});

		it('treats close() during the handshake as an abandonment, not a provider failure', async () => {
			(config.xai as any).connectAttempts = 4;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const onError = vi.fn();
			backend.onError = onError;
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			backend.close();
			// The mock's close() emits nothing; deliver the abort the way `ws` does.
			wsInstances[0].simulateError('WebSocket was closed before the connection was established');

			await expect(connectPromise).rejects.toThrow(/closed before the connection/);
			expect(wsInstances).toHaveLength(1);
			expect(onError).not.toHaveBeenCalled();
			expect(errorLogs().some((line) => line.includes('connect failed'))).toBe(false);
			expect((logger.info as any).mock.calls.some((args: any[]) => String(args[0]).includes('connect abandoned'))).toBe(true);
		});

		it('counts every failed attempt on otp_backend_handshake_failures_total', async () => {
			(config.xai as any).connectAttempts = 2;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateUnexpectedResponse(503);
			const second = await waitForWsInstances(2);
			second.simulateError('ECONNRESET');

			await expect(connectPromise).rejects.toThrow(/ECONNRESET/);
			expect(handshakeFailuresAdd).toHaveBeenCalledWith(1, { provider: 'xai', reason: 'http_503' });
			expect(handshakeFailuresAdd).toHaveBeenCalledWith(1, { provider: 'xai', reason: 'transport' });
		});

		it('logs retried attempts at warn, with full detail only on the first and final attempt', async () => {
			(config.xai as any).connectAttempts = 3;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateUnexpectedResponse(503, { 'x-request-id': 'req-1' }, 'body-1');
			const second = await waitForWsInstances(2);
			second.simulateUnexpectedResponse(503, { 'x-request-id': 'req-2' }, 'body-2');
			const third = await waitForWsInstances(3);
			third.simulateUnexpectedResponse(503, { 'x-request-id': 'req-3' }, 'body-3');
			await expect(connectPromise).rejects.toThrow(/HTTP 503/);

			const warned = warnLogs().filter((line) => line.includes('handshake rejected for tag'));
			const errored = errorLogs().filter((line) => line.includes('handshake rejected for tag'));
			expect(warned).toHaveLength(2);
			expect(errored).toHaveLength(1);
			// First attempt: full detail, so support has the request id + body of the first failure.
			expect(warned[0]).toContain('requestId=req-1');
			expect(warned[0]).toContain('body-1');
			// Intermediate attempt: status + request id only — no headers/body.
			expect(warned[1]).toContain('requestId=req-2');
			expect(warned[1]).not.toContain('headers=');
			expect(warned[1]).not.toContain('body-2');
			// Final attempt: the failure the caller sees — full detail, at error.
			expect(errored[0]).toContain('requestId=req-3');
			expect(errored[0]).toContain('body-3');
		});
	});

	describe('sendAudio', () => {
		it('should send binary frame', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			const audioBase64 = Buffer.from('fake-pcm-data').toString('base64');
			await backend.sendAudio(audioBase64);

			const sent = getMockWs().getSentMessages();
			expect(sent).toHaveLength(1);
			expect(Buffer.isBuffer(sent[0])).toBe(true);
		});

		it('should throw when not connected', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			await expect(backend.sendAudio('dGVzdA==')).rejects.toThrow('connection not ready');
		});
	});

	describe('forceCommit', () => {
		it('should inject a silence tail (not audio.done) to flush the final and keep the WS open', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			backend.forceCommit();

			const sent = getMockWs().getSentMessages();
			expect(sent).toHaveLength(1);
			// Binary silence, NOT an audio.done (which would close the stream).
			expect(Buffer.isBuffer(sent[0])).toBe(true);
			expect(sent.some((m: any) => typeof m === 'string' && m.includes('audio.done'))).toBe(false);
			// (endpointing 850ms + 300ms margin) of 16kHz signed-16-bit mono silence.
			const expectedBytes = Math.round((16000 * (850 + 300)) / 1000) * 2;
			expect(sent[0].length).toBe(expectedBytes);
			expect(sent[0].every((b: number) => b === 0)).toBe(true);
			// Stream stays open — no teardown.
			expect(backend.getStatus()).toBe('connected');
		});

		it('should size the silence tail to a per-connection endpointing override', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect({ ...DEFAULT_CONFIG, xaiEndpointing: 300 });
			getMockWs().simulateOpen();
			await connectPromise;

			backend.forceCommit();

			const sent = getMockWs().getSentMessages();
			expect(sent).toHaveLength(1);
			expect(sent[0].length).toBe(Math.round((16000 * (300 + 300)) / 1000) * 2);
		});
	});

	describe('message handling', () => {
		let backend: XAIBackend;
		let interimResults: TranscriptionMessage[];
		let finalResults: TranscriptionMessage[];

		beforeEach(async () => {
			backend = new XAIBackend('test-tag', { id: 'p1' });
			interimResults = [];
			finalResults = [];
			backend.onInterimTranscription = (msg) => interimResults.push(msg);
			backend.onCompleteTranscription = (msg) => finalResults.push(msg);

			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;
		});

		it('should emit interim on transcript.partial with is_final=false', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: false,
				speech_final: false,
				text: 'hello world',
				language: 'English',
				words: [
					{ text: 'hello', confidence: 0.9, start: 0, end: 0.5 },
					{ text: 'world', confidence: 0.8, start: 0.5, end: 1.0 },
				],
			}));

			expect(interimResults).toHaveLength(1);
			expect(interimResults[0].is_interim).toBe(true);
			expect(interimResults[0].transcript[0].text).toBe('hello world');
			expect(interimResults[0].transcript[0].confidence).toBeCloseTo(0.85);
			expect(finalResults).toHaveLength(0);
		});

		it('should emit final on transcript.partial with speech_final=true', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: true,
				speech_final: true,
				text: 'hello world',
				language: 'English',
				words: [
					{ text: 'hello', confidence: 0.95, start: 0, end: 0.5 },
					{ text: 'world', confidence: 0.85, start: 0.5, end: 1.0 },
				],
			}));

			expect(finalResults).toHaveLength(1);
			expect(finalResults[0].is_interim).toBe(false);
			expect(finalResults[0].transcript[0].text).toBe('hello world');
			expect(finalResults[0].language).toBe('English');
			expect(interimResults).toHaveLength(0);
		});

		it('should emit interim on transcript.partial with is_final=true but speech_final=false', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: true,
				speech_final: false,
				text: 'hello world',
				language: 'English',
			}));

			expect(interimResults).toHaveLength(1);
			expect(interimResults[0].is_interim).toBe(true);
			expect(finalResults).toHaveLength(0);
		});

		it('should emit final on transcript.done when text is non-empty', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.done',
				text: 'hello world',
				language: 'en',
				duration: 2.5,
				words: [],
			}));

			expect(finalResults).toHaveLength(1);
			expect(finalResults[0].is_interim).toBe(false);
			expect(finalResults[0].language).toBe('en');
			expect(interimResults).toHaveLength(0);
		});

		it('should ignore empty transcript.done (stream-end notification)', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.done',
				text: '',
				words: [],
				duration: 28.24,
			}));

			expect(finalResults).toHaveLength(0);
			expect(interimResults).toHaveLength(0);
		});

		it('should set language from transcript.partial', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: true,
				speech_final: true,
				text: 'bonjour',
				language: 'French',
			}));

			expect(finalResults[0].language).toBe('French');
		});

		it('should append language suffix when XAI_INCLUDE_LANGUAGE is set', () => {
			(config.xai as any).includeLanguage = true;
			try {
				getMockWs().simulateMessage(JSON.stringify({
					type: 'transcript.partial',
					is_final: true,
					speech_final: true,
					text: 'bonjour',
					language: 'French',
				}));
				expect(finalResults[0].transcript[0].text).toBe('bonjour [French]');
			} finally {
				(config.xai as any).includeLanguage = false;
			}
		});

		it('should ignore empty transcripts', () => {
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.partial', text: '', is_final: false }));
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: '   ', language: 'en', duration: 1 }));

			expect(interimResults).toHaveLength(0);
			expect(finalResults).toHaveLength(0);
		});

		it('should call onError (non-recoverable) and close on a generic error message', () => {
			const errorSpy = vi.fn();
			const closedSpy = vi.fn();
			backend.onError = errorSpy;
			backend.onClosed = closedSpy;

			getMockWs().simulateMessage(JSON.stringify({
				type: 'error',
				message: 'invalid api key',
			}));

			expect(errorSpy).toHaveBeenCalledWith('api_error', 'invalid api key', false);
			expect(backend.getStatus()).toBe('closed');
		});

		it('should flag "ASR stream timed out" as recoverable (JIT-15901)', () => {
			const errorSpy = vi.fn();
			backend.onError = errorSpy;

			getMockWs().simulateMessage(JSON.stringify({
				type: 'error',
				message: 'ASR stream timed out',
			}));

			expect(errorSpy).toHaveBeenCalledWith('api_error', 'ASR stream timed out', true);
			// The dead WS is still closed; recovery happens on the OutgoingConnection side.
			expect(backend.getStatus()).toBe('closed');
		});
	});

	describe('diarization', () => {
		let backend: XAIBackend;
		let interimResults: TranscriptionMessage[];
		let finalResults: TranscriptionMessage[];

		beforeEach(async () => {
			(config.xai as any).diarize = true;
			backend = new XAIBackend('test-tag', { id: 'p1' });
			interimResults = [];
			finalResults = [];
			backend.onInterimTranscription = (msg) => interimResults.push(msg);
			backend.onCompleteTranscription = (msg) => finalResults.push(msg);

			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;
		});

		afterEach(() => {
			(config.xai as any).diarize = false;
		});

		it('should split interim transcript.partial by speaker', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: false,
				text: 'hello how are you',
				language: 'English',
				words: [
					{ text: 'hello', speaker: 0, confidence: 0.9, start: 0, end: 0.3 },
					{ text: 'how', speaker: 1, confidence: 0.85, start: 0.5, end: 0.7 },
					{ text: 'are', speaker: 1, confidence: 0.88, start: 0.7, end: 0.9 },
					{ text: 'you', speaker: 1, confidence: 0.92, start: 0.9, end: 1.1 },
				],
			}));

			expect(interimResults).toHaveLength(2);
			expect(interimResults[0].speaker).toBe(0);
			expect(interimResults[0].transcript[0].text).toBe('hello');
			expect(interimResults[1].speaker).toBe(1);
			expect(interimResults[1].transcript[0].text).toBe('how are you');
		});

		it('keeps interim words with no speaker in the preceding speaker\'s segment', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: false,
				text: 'hello how are you',
				words: [
					{ text: 'hello', speaker: 0, confidence: 0.9 },
					{ text: 'how', speaker: 1, confidence: 0.85 },
					{ text: 'are', confidence: 0.88 },
					{ text: 'you', confidence: 0.92 },
				],
			}));

			expect(interimResults.map((m) => [m.speaker, m.transcript[0].text])).toEqual([
				[0, 'hello'],
				[1, 'how are you'],
			]);
		});

		it('should split final transcript.partial (speech_final=true) by speaker', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: true,
				speech_final: true,
				text: 'hello how are you',
				language: 'English',
				words: [
					{ text: 'hello', speaker: 0, confidence: 0.9, start: 0, end: 0.3 },
					{ text: 'how', speaker: 1, confidence: 0.85, start: 0.5, end: 0.7 },
					{ text: 'are', speaker: 1, confidence: 0.88, start: 0.7, end: 0.9 },
					{ text: 'you', speaker: 1, confidence: 0.92, start: 0.9, end: 1.1 },
				],
			}));

			expect(finalResults).toHaveLength(2);
			expect(finalResults[0].speaker).toBe(0);
			expect(finalResults[0].language).toBe('English');
			expect(finalResults[1].speaker).toBe(1);
		});

		it('should emit single final message when words have no speaker', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: true,
				speech_final: true,
				text: 'hello world',
				language: 'English',
				words: [
					{ text: 'hello', confidence: 0.9, start: 0, end: 0.5 },
					{ text: 'world', confidence: 0.8, start: 0.5, end: 1.0 },
				],
			}));

			expect(finalResults).toHaveLength(1);
			expect(finalResults[0].speaker).toBeUndefined();
		});
	});

	describe('granular finalization (roll-own)', () => {
		let backend: XAIBackend;
		let interimResults: TranscriptionMessage[];
		let finalResults: TranscriptionMessage[];

		async function connectGranular(overrides: Partial<BackendConfig> = {}) {
			backend = new XAIBackend('test-tag', { id: 'p1' });
			interimResults = [];
			finalResults = [];
			backend.onInterimTranscription = (msg) => interimResults.push(msg);
			backend.onCompleteTranscription = (msg) => finalResults.push(msg);
			const connectPromise = backend.connect({
				...DEFAULT_CONFIG,
				xaiGranularFinals: true,
				xaiGranularStabilityMs: 600,
				xaiGranularGuardWords: 2,
				...overrides,
			});
			getMockWs().simulateOpen();
			await connectPromise;
		}

		const partial = (text: string, isFinal: boolean, speechFinal: boolean) =>
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.partial', is_final: isFinal, speech_final: speechFinal, text }));

		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			(config.xai as any).granularMinWords = 3;
		});

		afterEach(() => {
			vi.useRealTimers();
			(config.xai as any).granularMinWords = 5;
		});

		it('does NOT enable granular by default (one final per turn preserved)', async () => {
			// Default config (no granular flag) -> is_final/!speech_final stays interim, only
			// speech_final commits. This guards the default behavioral contract.
			const b = new XAIBackend('test-tag', { id: 'p1' });
			const finals: TranscriptionMessage[] = [];
			b.onCompleteTranscription = (m) => finals.push(m);
			const p = b.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await p;
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.partial', is_final: true, speech_final: false, text: 'one two three four five' }));
			expect(finals).toHaveLength(0); // no granular commit without the flag
		});

		it('commits a stabilized prefix as a FINAL before end of turn', async () => {
			await connectGranular();
			partial('one two three four five', false, false); // t=0
			expect(finalResults).toHaveLength(0); // nothing stable yet

			vi.setSystemTime(700);
			partial('one two three four five six', false, false); // first 4 stable >=600ms
			// guard=2 holds back the last two; minWords=3 -> "one two three" committed.
			expect(finalResults).toHaveLength(1);
			expect(finalResults[0].is_interim).toBe(false);
			expect(finalResults[0].transcript[0].text).toBe('one two three');
		});

		it('speech_final flushes only the trailing remainder (no double-emit of committed text)', async () => {
			await connectGranular();
			partial('hello world foo bar', false, false); // t=0
			vi.setSystemTime(700);
			partial('hello world foo bar baz', false, false); // commit "hello world foo"
			const committedSoFar = finalResults.map((m) => m.transcript[0].text).join(' ');
			expect(committedSoFar).toBe('hello world foo');

			vi.setSystemTime(800);
			partial('hello world foo bar baz qux', true, true); // speech_final re-emits whole turn
			const all = finalResults.map((m) => m.transcript[0].text);
			// the end-of-turn commit must be only the uncommitted tail, never the whole turn
			expect(all[all.length - 1]).toBe('bar baz qux');
			expect(finalResults.map((m) => m.transcript[0].text).join(' ')).toBe('hello world foo bar baz qux');
		});

		it('marks commits before the end of the turn as mid-utterance, and the end-of-turn commit not', async () => {
			await connectGranular();
			const flags: Array<[string, boolean | undefined]> = [];
			backend.onCompleteTranscription = (msg, midUtterance) => flags.push([msg.transcript[0].text, midUtterance]);
			partial('hello world foo bar', false, false);
			vi.setSystemTime(700);
			partial('hello world foo bar baz', false, false);
			vi.setSystemTime(800);
			partial('hello world foo bar baz qux', true, true);
			expect(flags).toEqual([
				['hello world foo', true],
				['bar baz qux', false],
			]);
		});

		it('emits the in-progress remainder as an interim (Deepgram-like)', async () => {
			await connectGranular();
			partial('one two three four five', false, false);
			vi.setSystemTime(700);
			partial('one two three four five six', false, false);
			// after committing "one two three", the interim shows the uncommitted remainder
			expect(interimResults[interimResults.length - 1].is_interim).toBe(true);
			expect(interimResults[interimResults.length - 1].transcript[0].text).toBe('four five six');
		});

		it('flushes a now-stable prefix on the timer when interims stop (pause)', async () => {
			await connectGranular();
			partial('aa bb cc dd ee', false, false); // t=0, nothing stable yet
			expect(finalResults).toHaveLength(0);
			// No further interims arrive; advance time so the scheduled flush timer fires.
			await vi.advanceTimersByTimeAsync(900);
			expect(finalResults.length).toBeGreaterThanOrEqual(1);
			expect(finalResults[0].transcript[0].text).toBe('aa bb cc');
		});

		it('clears the flush timer on close — no ghost commit after teardown (reconnect safety)', async () => {
			// On a recoverable "ASR stream timed out" reconnect the old backend is closed and a fresh
			// XAIBackend (fresh segmenter) takes over. The old backend's armed flush timer must not
			// fire a late/ghost commit after teardown — close() clears it.
			await connectGranular();
			partial('aa bb cc dd ee', false, false); // arms the flush timer, nothing committed yet
			expect(finalResults).toHaveLength(0);
			backend.close();
			await vi.advanceTimersByTimeAsync(3000); // the timer would have fired by now
			expect(finalResults).toHaveLength(0); // no ghost commit
		});

		it('flushes the in-progress tail on transcript.done when no speech_final occurred', async () => {
			await connectGranular();
			partial('hello world foo bar', false, false); // t=0
			vi.setSystemTime(700);
			partial('hello world foo bar baz', false, false); // commit "hello world foo"
			expect(finalResults.map((m) => m.transcript[0].text).join(' ')).toBe('hello world foo');
			// stream closes mid-turn -> transcript.done re-emits the whole turn; flush only the tail
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: 'hello world foo bar baz', duration: 3 }));
			expect(finalResults.map((m) => m.transcript[0].text).join(' ')).toBe('hello world foo bar baz');
		});

		it('ignores transcript.done that repeats an already-committed turn (no duplicate)', async () => {
			await connectGranular();
			partial('hello world foo bar baz', true, true); // speech_final ends the turn
			const afterTurn = finalResults.map((m) => m.transcript[0].text).join(' ');
			expect(afterTurn).toBe('hello world foo bar baz');
			// stream-end done repeats the whole turn -> must be ignored
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: 'hello world foo bar baz', duration: 5 }));
			expect(finalResults.map((m) => m.transcript[0].text).join(' ')).toBe(afterTurn);
		});

		it('injects the idle silence for a granular turn that opened after the previous one ended', async () => {
			await connectGranular();
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('hello world foo bar', true, true); // turn A ends after the last audio
			getMockWs().clearSentMessages();
			backend.forceCommit();
			expect(getMockWs().getSentMessages()).toHaveLength(0); // nothing left of A to finalize

			partial('bye bye', false, false); // B, from audio already in flight: never speech_final'd on its own
			getMockWs().clearSentMessages();
			backend.forceCommit();
			expect(getMockWs().getSentMessages()).toHaveLength(1);
		});

		it('falls back to default mode (no granular) when diarize is enabled', async () => {
			(config.xai as any).diarize = true;
			try {
				await connectGranular();
				// is_final/!speech_final must remain interim (granular disabled under diarize)
				partial('one two three four five', true, false);
				vi.setSystemTime(700);
				partial('one two three four five six', true, false);
				expect(finalResults).toHaveLength(0);
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('can be enabled via global config flag (not just per-connection)', async () => {
			(config.xai as any).granularFinals = true;
			(config.xai as any).granularStabilityMs = 600;
			(config.xai as any).granularGuardWords = 2;
			try {
				backend = new XAIBackend('test-tag', { id: 'p1' });
				finalResults = [];
				backend.onCompleteTranscription = (m) => finalResults.push(m);
				const p = backend.connect(DEFAULT_CONFIG); // no per-connection override
				getMockWs().simulateOpen();
				await p;
				partial('one two three four five', false, false);
				vi.setSystemTime(700);
				partial('one two three four five six', false, false);
				expect(finalResults).toHaveLength(1);
				expect(finalResults[0].transcript[0].text).toBe('one two three');
			} finally {
				(config.xai as any).granularFinals = false;
				(config.xai as any).granularStabilityMs = 1000;
				(config.xai as any).granularGuardWords = 3;
			}
		});
	});

	describe('long-turn cap (default mode)', () => {
		let backend: XAIBackend;
		let interimResults: TranscriptionMessage[];
		let finalResults: TranscriptionMessage[];

		async function connectDefault() {
			backend = new XAIBackend('test-tag', { id: 'p1' });
			interimResults = [];
			finalResults = [];
			backend.onInterimTranscription = (msg) => interimResults.push(msg);
			backend.onCompleteTranscription = (msg) => finalResults.push(msg);
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;
		}

		const partial = (text: string, isFinal: boolean, speechFinal: boolean, words?: any[]) =>
			getMockWs().simulateMessage(
				JSON.stringify({ type: 'transcript.partial', is_final: isFinal, speech_final: speechFinal, text, ...(words && { words }) }),
			);
		const finalTexts = () => finalResults.map((m) => m.transcript[0].text);
		const warnLogs = (): string[] => (logger.warn as any).mock.calls.map((args: any[]) => String(args[0]));

		beforeEach(async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			await connectDefault();
		});

		afterEach(() => {
			vi.useRealTimers();
			(config.xai as any).maxTurnMs = 15000;
		});

		it('keeps one final per turn when the turn ends inside the cap', () => {
			partial('first part', false, false);
			vi.setSystemTime(3000);
			partial('first part.', true, false);
			vi.setSystemTime(6000);
			partial('second part.', true, false);
			expect(finalResults).toHaveLength(0);

			vi.setSystemTime(7000);
			partial('first part. second part.', true, true);
			expect(finalTexts()).toEqual(['first part. second part.']);
		});

		it('emits committed segments as a final once the turn outlives the cap, with no speech_final', () => {
			partial('It is a colorless', false, false); // turn starts at t=0
			vi.setSystemTime(6000);
			partial('It is a colorless, odorless gas.', true, false);
			vi.setSystemTime(12000);
			partial('Its boiling point is the lowest.', true, false);
			expect(finalResults).toHaveLength(0); // still inside the 15s cap

			vi.setSystemTime(16000);
			partial('An unknown yellow spectral line.', true, false);
			expect(finalTexts()).toEqual([
				'It is a colorless, odorless gas. Its boiling point is the lowest. An unknown yellow spectral line.',
			]);
			expect(finalResults[0].is_interim).toBe(false);
			// The flushed segment is not re-sent as an interim after its final.
			expect(interimResults.map((m) => m.transcript[0].text)).not.toContain('An unknown yellow spectral line.');

			// Past the cap, each further segment goes out as soon as xAI commits it.
			vi.setSystemTime(20000);
			partial('Pierre Janssen.', true, false);
			expect(finalTexts()[1]).toBe('Pierre Janssen.');
		});

		it('emits only the rest of the turn when speech_final follows an early final', () => {
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma delta.', true, false); // flushes "alpha beta. gamma delta."
			vi.setSystemTime(18000);
			partial('epsilon', false, false);
			partial('alpha beta. gamma delta. epsilon zeta.', true, true);

			expect(finalTexts()).toEqual(['alpha beta. gamma delta.', 'epsilon zeta.']);
		});

		it('aligns the rest, without warning, when xAI re-punctuates the turn text', () => {
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma delta.', true, false);
			// End-of-turn text differs from what was committed (re-punctuated), so it is no prefix;
			// the anchor words are still found once punctuation and case are ignored.
			partial('Alpha, beta, gamma, delta, epsilon.', true, true);

			expect(finalTexts()).toEqual(['alpha beta. gamma delta.', 'epsilon.']);
			expect((logger.warn as any).mock.calls.some((args: any[]) => String(args[0]).includes('does not contain the last words'))).toBe(false);
		});

		it('emits nothing more when speech_final repeats only what already went out', () => {
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma delta.', true, false);
			partial('alpha beta. gamma delta.', true, true);

			expect(finalTexts()).toEqual(['alpha beta. gamma delta.']);
		});

		it('flushes only the rest of the turn on a transcript.done at stream end', () => {
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma delta.', true, false);
			getMockWs().simulateMessage(
				JSON.stringify({ type: 'transcript.done', text: 'alpha beta. gamma delta. epsilon.', words: [] }),
			);

			expect(finalTexts()).toEqual(['alpha beta. gamma delta.', 'epsilon.']);
		});

		it('starts the next turn fresh after a speech_final', () => {
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma delta.', true, false);
			partial('alpha beta. gamma delta.', true, true);

			vi.setSystemTime(20000);
			partial('new turn.', true, false); // turn age 0 again, so held rather than emitted
			expect(finalTexts()).toEqual(['alpha beta. gamma delta.']);
			partial('new turn.', true, true);
			expect(finalTexts()).toEqual(['alpha beta. gamma delta.', 'new turn.']);
		});

		it('is disabled by XAI_MAX_TURN_MS=0', () => {
			(config.xai as any).maxTurnMs = 0;
			partial('alpha beta.', true, false);
			vi.setSystemTime(60000);
			partial('gamma delta.', true, false);
			expect(finalResults).toHaveLength(0);
		});

		it('splits the early final and the rest by speaker when diarized', () => {
			(config.xai as any).diarize = true;
			try {
				const w = (text: string, speaker: number) => ({ text, speaker, confidence: 0.9 });
				partial('hello there.', true, false, [w('hello', 0), w('there.', 0)]);
				vi.setSystemTime(16000);
				partial('how are you.', true, false, [w('how', 1), w('are', 1), w('you.', 1)]);
				expect(finalResults.map((m) => [m.speaker, m.transcript[0].text])).toEqual([
					[0, 'hello there.'],
					[1, 'how are you.'],
				]);

				partial('hello there. how are you. fine.', true, true, [
					w('hello', 0), w('there.', 0), w('how', 1), w('are', 1), w('you.', 1), w('fine.', 0),
				]);
				expect(finalResults.map((m) => [m.speaker, m.transcript[0].text]).slice(2)).toEqual([[0, 'fine.']]);
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('keeps a diarized segment whose trailing words have no speaker as one final (staging shape, 2026-09-23)', () => {
			(config.xai as any).diarize = true;
			try {
				const w = (text: string, speaker?: number) => ({ text, confidence: 0.9, ...(speaker !== undefined && { speaker }) });
				// xAI's is_final segments label the leading words only; the speech_final labels all of them.
				partial('why is it speaker zero? there is only one speaker here.', true, false, [
					w('why', 0), w('is', 0), w('it', 0), w('speaker', 0), w('zero?', 0),
					w('there'), w('is'), w('only'), w('one'), w('speaker'), w('here.'),
				]);
				vi.advanceTimersByTime(15000);
				expect(finalResults.map((m) => [m.speaker, m.transcript[0].text])).toEqual([
					[0, 'why is it speaker zero? there is only one speaker here.'],
				]);

				partial('why is it speaker zero? there is only one speaker here. in your room?', true, true, [
					w('why', 0), w('is', 0), w('it', 0), w('speaker', 0), w('zero?', 0),
					w('there', 0), w('is', 0), w('only', 0), w('one', 0), w('speaker', 0), w('here.', 0),
					w('in', 0), w('your', 0), w('room?', 0),
				]);
				expect(finalResults.map((m) => [m.speaker, m.transcript[0].text]).slice(1)).toEqual([[0, 'in your room?']]);
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('gives a diarized rest that starts on an unlabelled word the speaker it was emitted under', () => {
			(config.xai as any).diarize = true;
			try {
				const w = (text: string, speaker?: number) => ({ text, confidence: 0.9, ...(speaker !== undefined && { speaker }) });
				partial('hello there.', true, false, [w('hello', 1), w('there.', 1)]);
				vi.advanceTimersByTime(15000);
				expect(finalResults.map((m) => [m.speaker, m.transcript[0].text])).toEqual([[1, 'hello there.']]);

				partial('hello there. how are you.', true, true, [w('hello', 1), w('there.', 1), w('how'), w('are'), w('you.')]);
				expect(finalResults.map((m) => [m.speaker, m.transcript[0].text]).slice(1)).toEqual([[1, 'how are you.']]);
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('warns when the diarized speech_final has fewer words than were already emitted', () => {
			(config.xai as any).diarize = true;
			try {
				const w = (text: string, speaker: number) => ({ text, speaker, confidence: 0.9 });
				partial('hello there my friend.', true, false, [w('hello', 0), w('there', 0), w('my', 0), w('friend.', 0)]);
				vi.advanceTimersByTime(15000);
				// Starts like the turn, so it is the whole turn revised shorter: nothing is left.
				partial('hello there my.', true, true, [w('hello', 0), w('there', 0), w('my.', 0)]);
				expect(finalResults.map((m) => m.transcript[0].text)).toEqual(['hello there my friend.']);
				expect((logger.warn as any).mock.calls.some((args: any[]) => String(args[0]).includes('carries 3 words but 4 were already emitted'))).toBe(true);
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('warns when the emitted words cannot be found in the speech_final text', () => {
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma delta.', true, false);
			// xAI revised the anchor words, so the rest is found by word count instead.
			partial('alpha beta. gamma foxtrot. epsilon.', true, true);
			expect(finalTexts()).toEqual(['alpha beta. gamma delta.', 'epsilon.']);
			expect((logger.warn as any).mock.calls.some((args: any[]) => String(args[0]).includes('does not contain the last words already emitted'))).toBe(true);
		});

		it('says so when the cap timer fires with no committed segment', () => {
			partial('still talking', false, false); // interims only, no is_final
			vi.advanceTimersByTime(15000);
			expect(finalResults).toHaveLength(0);
			expect((logger.info as any).mock.calls.some((args: any[]) => String(args[0]).includes('reached 15000ms with no committed segment'))).toBe(true);
		});

		it('flushes a held segment when the turn reaches the cap with no further commit', () => {
			partial('alpha beta.', true, false); // held: inside the cap, and nothing else comes
			vi.advanceTimersByTime(14999);
			expect(finalResults).toHaveLength(0);
			vi.advanceTimersByTime(1);
			expect(finalTexts()).toEqual(['alpha beta.']);

			// A late speech_final still emits only the rest.
			partial('alpha beta. gamma.', true, true);
			expect(finalTexts()).toEqual(['alpha beta.', 'gamma.']);
		});

		it('does not arm the cap timer when disabled', () => {
			(config.xai as any).maxTurnMs = 0;
			partial('alpha beta.', true, false);
			vi.advanceTimersByTime(60000);
			expect(finalResults).toHaveLength(0);
		});

		it('never cuts a word when the whole-turn text extends an emitted word', () => {
			partial('one two alpha beta', true, false);
			vi.setSystemTime(16000);
			partial('gamma', true, false);
			// "beta" became "betamax": a literal prefix match would emit "max delta".
			partial('one two alpha betamax gamma delta', true, true);
			expect(finalTexts()).toEqual(['one two alpha beta gamma', 'delta']);
		});

		it('aligns the rest by words when xAI re-tokenises an emitted word', () => {
			partial('regulatory compliant and things like that.', true, false);
			vi.setSystemTime(16000);
			partial('so yeah.', true, false);
			// Six words went out; the turn renders them as five, so dropping six would lose "so".
			partial('Regulatory-compliant and things like that, so yeah, done.', true, true);
			expect(finalTexts()).toEqual(['regulatory compliant and things like that. so yeah.', 'done.']);
		});

		it('ends the turn on an empty speech_final, emitting what xAI committed', () => {
			partial('alpha beta.', true, false);
			partial('', true, true);
			expect(finalTexts()).toEqual(['alpha beta.']);

			// The next turn starts clean: nothing is sliced off it.
			vi.setSystemTime(20000);
			partial('next turn.', true, true);
			expect(finalTexts()).toEqual(['alpha beta.', 'next turn.']);
		});

		it('does not slice the next turn after an early final and an empty speech_final', () => {
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma delta.', true, false); // flushed early
			partial('', true, true);
			partial('next turn here.', true, true);
			expect(finalTexts()).toEqual(['alpha beta. gamma delta.', 'next turn here.']);
		});

		it('flushes a held segment before reporting a stream error', () => {
			const order: string[] = [];
			backend.onCompleteTranscription = (msg) => order.push(`final:${msg.transcript[0].text}`);
			backend.onError = (type) => order.push(`error:${type}`);
			partial('alpha beta.', true, false);
			getMockWs().simulateMessage(JSON.stringify({ type: 'error', message: 'ASR stream timed out' }));
			expect(order).toEqual(['final:alpha beta.', 'error:api_error']);
		});

		it('flushes a held segment when xAI closes the socket', () => {
			partial('alpha beta.', true, false);
			getMockWs().simulateClose(1006, '', false);
			expect(finalTexts()).toEqual(['alpha beta.']);
		});

		it('marks an early final as mid-utterance, and the speech_final rest as not', () => {
			const flags: Array<[string, boolean | undefined]> = [];
			backend.onCompleteTranscription = (msg, midUtterance) => flags.push([msg.transcript[0].text, midUtterance]);
			partial('alpha beta.', true, false);
			vi.advanceTimersByTime(15000); // cap timer
			vi.setSystemTime(20000);
			partial('gamma delta.', true, false); // commit past the cap
			partial('alpha beta. gamma delta. epsilon.', true, true);
			expect(flags).toEqual([
				['alpha beta.', true],
				['gamma delta.', true],
				['epsilon.', false],
			]);
		});

		it('marks what an empty speech_final flushes as the end of the utterance', () => {
			const flags: Array<boolean | undefined> = [];
			backend.onCompleteTranscription = (_msg, midUtterance) => flags.push(midUtterance);
			partial('alpha beta.', true, false);
			partial('', true, true);
			expect(flags).toEqual([false]);
		});

		it('emits a speech_final that carries only the turn\'s tail whole, rather than slicing it by count', () => {
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma delta.', true, false);
			// Neither the last emitted words nor the turn's first words: this is not the whole turn.
			partial('epsilon zeta.', true, true);
			expect(finalTexts()).toEqual(['alpha beta. gamma delta.', 'epsilon zeta.']);
			expect((logger.warn as any).mock.calls.some((args: any[]) => String(args[0]).includes('emitting it whole as the rest of the turn'))).toBe(true);
		});

		it('emits a diarized speech_final that carries only the turn\'s tail whole, rather than slicing it by count', () => {
			(config.xai as any).diarize = true;
			try {
				const w = (text: string, speaker: number) => ({ text, speaker, confidence: 0.9 });
				partial('hello there.', true, false, [w('hello', 1), w('there.', 1)]);
				vi.advanceTimersByTime(15000);
				// One word against two emitted: slicing by count would have dropped it.
				partial('fine.', true, true, [w('fine.', 0)]);
				expect(finalResults.map((m) => [m.speaker, m.transcript[0].text])).toEqual([
					[1, 'hello there.'],
					[0, 'fine.'],
				]);
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('keeps the speaker on a diarized segment that arrived without words', () => {
			(config.xai as any).diarize = true;
			try {
				const w = (text: string, speaker: number) => ({ text, speaker, confidence: 0.9 });
				partial('hello there.', true, false, [w('hello', 1), w('there.', 1)]);
				partial('how are you.', true, false); // no words array
				vi.advanceTimersByTime(15000);
				expect(finalResults.map((m) => [m.speaker, m.transcript[0].text])).toEqual([[1, 'hello there. how are you.']]);

				partial('hello there. how are you. fine.', true, true, [
					w('hello', 1), w('there.', 1), w('how', 1), w('are', 1), w('you.', 1), w('fine.', 1),
				]);
				expect(finalResults.map((m) => [m.speaker, m.transcript[0].text]).slice(1)).toEqual([[1, 'fine.']]);
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('flushes a held segment before reporting a live WebSocket error', () => {
			const order: string[] = [];
			backend.onCompleteTranscription = (msg) => order.push(`final:${msg.transcript[0].text}`);
			backend.onError = (type) => order.push(`error:${type}`);
			partial('alpha beta.', true, false);
			getMockWs().simulateError('ECONNRESET');
			expect(order).toEqual(['final:alpha beta.', 'error:websocket_error']);
		});

		it('ends the turn on an empty transcript.done, flushing what xAI committed', () => {
			partial('alpha beta.', true, false);
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: '' }));
			expect(finalTexts()).toEqual(['alpha beta.']);
			// The turn is over: the cap timer no longer fires for it.
			vi.advanceTimersByTime(15000);
			expect((logger.info as any).mock.calls.some((args: any[]) => String(args[0]).includes('reached 15000ms'))).toBe(false);
		});

		it('does not mistake a tail that shares the turn\'s first word for the whole turn', () => {
			partial('So I think we should ship it.', true, false);
			vi.setSystemTime(16000);
			partial('The tests are green.', true, false);
			// xAI reset the turn: the speech_final carries only what followed, starting with the same "so".
			partial('So what we need is a date.', true, true);
			expect(finalTexts()).toEqual(['So I think we should ship it. The tests are green.', 'So what we need is a date.']);
			expect((logger.warn as any).mock.calls.some((args: any[]) => String(args[0]).includes('emitting it whole'))).toBe(true);
		});

		it('aligns the rest of a turn in a language written without spaces', () => {
			partial('你好世界。', true, false);
			vi.setSystemTime(16000);
			partial('我们需要。', true, false);
			partial('你好世界，我们需要，还有问题。', true, true);
			expect(finalTexts()).toEqual(['你好世界。我们需要。', '还有问题。']); // no space put between the segments
			expect((logger.warn as any).mock.calls.some((args: any[]) => String(args[0]).includes('speech_final for test-tag'))).toBe(false);
		});

		it('aligns across a punctuation-only token in the speech_final', () => {
			partial('alpha beta', true, false);
			vi.setSystemTime(16000);
			partial('gamma', true, false);
			partial('alpha beta — gamma … delta', true, true);
			expect(finalTexts()).toEqual(['alpha beta gamma', 'delta']);
			expect((logger.warn as any).mock.calls.some((args: any[]) => String(args[0]).includes('speech_final for test-tag'))).toBe(false);
		});

		it('keeps transcript text out of the reconciliation warnings', () => {
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma delta.', true, false);
			partial('epsilon zeta.', true, true);
			const warns = (logger.warn as any).mock.calls.map((args: any[]) => String(args[0]));
			expect(warns.some((w: string) => w.includes('emitting it whole'))).toBe(true);
			expect(warns.some((w: string) => /alpha|gamma|epsilon/.test(w))).toBe(false);
		});

		it('gives an early final the turn\'s language when the committing partial has none', () => {
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.partial', is_final: false, speech_final: false, text: 'bonjour', language: 'fr' }));
			vi.setSystemTime(16000);
			partial('bonjour tout le monde.', true, false); // no language field
			expect(finalResults.map((m) => m.language)).toEqual(['fr']);
		});

		it('does not re-emit a turn when transcript.done follows its speech_final', () => {
			partial('alpha beta.', true, true);
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: 'alpha beta.' }));
			expect(finalTexts()).toEqual(['alpha beta.']);
		});

		it('skips the idle silence when the turn already ended after the last audio', async () => {
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma.', true, false); // the cap emits everything
			partial('alpha beta. gamma.', true, true); // nothing left: no final, so the owner's idle timer stays armed
			getMockWs().clearSentMessages();
			backend.forceCommit();
			expect(getMockWs().getSentMessages()).toHaveLength(0);

			// New audio: the next idle has something to finalize again.
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			getMockWs().clearSentMessages();
			backend.forceCommit();
			expect(getMockWs().getSentMessages()).toHaveLength(1);
		});

		it('ends the turn when xAI sends no speech_final after the idle silence', () => {
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma delta.', true, false); // emitted past the cap
			partial('epsilon.', true, false); // likewise
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000);
			expect((logger.info as any).mock.calls.some((args: any[]) => String(args[0]).includes('no speech_final'))).toBe(true);

			// Minutes later a new turn starts fresh: held inside its own cap, not emitted at once,
			// and its speech_final is not aligned against the old turn.
			vi.setSystemTime(300000);
			partial('next turn starts.', true, false);
			expect(finalTexts()).toEqual(['alpha beta. gamma delta.', 'epsilon.']);
			partial('next turn starts. and ends.', true, true);
			expect(finalTexts()).toEqual(['alpha beta. gamma delta.', 'epsilon.', 'next turn starts. and ends.']);
		});

		it('keeps the turn open after the idle silence when the speaker resumes', async () => {
			partial('alpha beta.', true, false);
			backend.forceCommit();
			vi.advanceTimersByTime(1000);
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			vi.advanceTimersByTime(10000);
			expect((logger.info as any).mock.calls.some((args: any[]) => String(args[0]).includes('within'))).toBe(false);
			partial('alpha beta. gamma.', true, true);
			expect(finalTexts()).toEqual(['alpha beta. gamma.']);
		});

		it('does not repeat an idle-ended turn when its speech_final arrives late', () => {
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma delta.', true, false); // emitted past the cap
			partial('epsilon.', true, false); // past the cap, emitted as it commits
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000); // the idle turn end fires
			expect(finalTexts()).toEqual(['alpha beta. gamma delta.', 'epsilon.']);

			// xAI answers after the grace period with the whole turn: only the tail is new.
			partial('alpha beta. gamma delta. epsilon. zeta.', true, true);
			expect(finalTexts()).toEqual(['alpha beta. gamma delta.', 'epsilon.', 'zeta.']);
		});

		it('does not repeat an idle-ended turn that xAI keeps open after the speaker resumes', async () => {
			partial('alpha beta gamma.', true, false);
			vi.advanceTimersByTime(15000); // cap timer emits "alpha beta gamma."
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000); // idle turn end
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('delta', false, false); // xAI's turn is still the same one
			partial('alpha beta gamma. delta epsilon.', true, true);
			expect(finalTexts()).toEqual(['alpha beta gamma.', 'delta epsilon.']);
		});

		it('emits the tail a late transcript.done carries after an idle-ended turn', () => {
			partial('alpha beta gamma.', true, false);
			vi.advanceTimersByTime(15000);
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000);
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: 'alpha beta gamma. delta.' }));
			expect(finalTexts()).toEqual(['alpha beta gamma.', 'delta.']);
		});

		it('does not repeat a short idle-ended turn when its speech_final arrives late', () => {
			partial('alpha beta.', true, false);
			vi.advanceTimersByTime(15000);
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000);
			partial('alpha beta.', true, true); // exactly the turn again: the late answer, not a new turn
			expect(finalTexts()).toEqual(['alpha beta.']);
		});

		it('emits a fresh turn whole after an idle-ended turn whose last words it happens to contain', async () => {
			partial('okay', true, false);
			vi.advanceTimersByTime(15000);
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000);
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			// A one-word anchor is in most turns; at the end of this one it would drop the whole turn.
			partial('I think that is okay', true, true);
			expect(finalTexts()).toEqual(['okay', 'I think that is okay']);

			partial('okay', true, false);
			vi.advanceTimersByTime(15000);
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000);
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			// At the start it is as likely a repeat as a continuation: a repeat is preferred to a loss.
			partial('okay so let us move on', true, true);
			expect(finalTexts().slice(2)).toEqual(['okay', 'okay so let us move on']);
		});

		it('emits a fresh turn whole after an idle-ended turn whose full anchor it contains elsewhere', async () => {
			partial('see you soon everyone bye.', true, false);
			vi.advanceTimersByTime(15000);
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000);
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			// The full anchor ("soon everyone bye") is there, but far from where the count puts it: not this turn.
			partial('thanks. right, I will say it once more: soon everyone bye.', true, true);
			expect(finalTexts()).toEqual(['see you soon everyone bye.', 'thanks. right, I will say it once more: soon everyone bye.']);
		});

		it('does not end the turn on idle when the silence could not be sent', () => {
			partial('alpha beta.', true, false);
			const ws = getMockWs();
			const send = ws.send;
			ws.send = () => {
				throw new Error('EPIPE');
			};
			try {
				backend.forceCommit();
			} finally {
				ws.send = send;
			}
			vi.advanceTimersByTime(850 + 300 + 3000);
			expect((logger.info as any).mock.calls.some((args: any[]) => String(args[0]).includes('no speech_final'))).toBe(false);
			expect(finalResults).toHaveLength(0);
		});

		it('emits a transcript.done that carries a turn never seen in a partial after a speech_final', async () => {
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('alpha beta gamma.', true, true); // turn A ends after the last audio
			// The stream ends before B's partials arrive; its transcript.done is all there is of B.
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: 'delta epsilon.' }));
			expect(finalTexts()).toEqual(['alpha beta gamma.', 'delta epsilon.']);
		});

		it('emits only the tail of a transcript.done that extends the turn a speech_final ended', async () => {
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('alpha beta gamma.', true, true);
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: 'alpha beta gamma. delta.' }));
			expect(finalTexts()).toEqual(['alpha beta gamma.', 'delta.']);
		});

		it('marks what a socket close flushes as the end of the utterance', () => {
			const flags: Array<boolean | undefined> = [];
			backend.onCompleteTranscription = (_msg, midUtterance) => flags.push(midUtterance);
			partial('alpha beta.', true, false);
			getMockWs().simulateClose(1006, '', false);
			expect(flags).toEqual([false]);
		});

		it('injects the idle silence for a turn that opened after the previous one ended', async () => {
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('alpha beta.', true, false);
			vi.setSystemTime(16000);
			partial('gamma.', true, false); // the cap emits everything
			// All of "yes" was sent before A's speech_final arrived; its partials open a new turn.
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('alpha beta. gamma.', true, true);
			partial('yes', false, false);
			getMockWs().clearSentMessages();
			backend.forceCommit();
			expect(getMockWs().getSentMessages()).toHaveLength(1);
		});

		it('aligns a labelled diarized speech_final against an unlabelled segment in the same word units', () => {
			(config.xai as any).diarize = true;
			try {
				const w = (text: string, speaker?: number) => ({ text, confidence: 0.9, ...(speaker !== undefined && { speaker }) });
				partial('hello there.', true, false, [w('hello', 0), w('there.', 0)]);
				vi.advanceTimersByTime(15000); // emits under speaker 0
				vi.setSystemTime(20000);
				// No word labelled: it keeps speaker 0, and "regulatory-compliant" counts as two words.
				partial('it is regulatory-compliant.', true, false, [w('it'), w('is'), w('regulatory-compliant.')]);
				expect(finalResults.map((m) => [m.speaker, m.transcript[0].text])).toEqual([
					[0, 'hello there.'],
					[0, 'it is regulatory-compliant.'],
				]);

				partial('hello there. it is regulatory-compliant. done.', true, true, [
					w('hello', 0), w('there.', 0), w('it', 0), w('is', 0), w('regulatory-compliant.', 0), w('done.', 0),
				]);
				expect(finalResults.map((m) => [m.speaker, m.transcript[0].text]).slice(2)).toEqual([[0, 'done.']]);
				expect((logger.warn as any).mock.calls.some((args: any[]) => String(args[0]).includes('speech_final for test-tag'))).toBe(false);
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('cuts a diarized words entry that xAI re-tokenised across the emitted boundary', () => {
			(config.xai as any).diarize = true;
			try {
				const w = (text: string, speaker: number) => ({ text, speaker, confidence: 0.9 });
				partial('it is regulatory', true, false, [w('it', 0), w('is', 0), w('regulatory', 0)]);
				vi.advanceTimersByTime(15000); // emitted
				vi.setSystemTime(20000);
				// The speech_final joins the emitted "regulatory" and the rest into one entry.
				partial('it is regulatory-compliant. done.', true, true, [w('it', 0), w('is', 0), w('regulatory-compliant.', 0), w('done.', 0)]);
				expect(finalResults.map((m) => [m.speaker, m.transcript[0].text])).toEqual([
					[0, 'it is regulatory'],
					[0, 'compliant. done.'],
				]);
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('keeps a segment that starts with the previous one\'s words: a speaker repeating themselves', () => {
			partial('Thank you.', true, false);
			partial('Thank you very much.', true, false);
			vi.setSystemTime(16000);
			partial('Okay.', true, false);
			expect(finalTexts()).toEqual(['Thank you. Thank you very much. Okay.']);
		});

		describe('with XAI_MAX_TURN_MS=0', () => {
			beforeEach(() => {
				(config.xai as any).maxTurnMs = 0;
			});

			it('holds nothing, so neither an error nor a close emits a committed segment', () => {
				partial('alpha beta.', true, false);
				getMockWs().simulateMessage(JSON.stringify({ type: 'error', message: 'ASR stream timed out' }));
				expect(finalResults).toHaveLength(0);
			});

			it('does not end a turn on idle, and always injects the idle silence', () => {
				partial('alpha beta.', true, false);
				backend.forceCommit();
				vi.advanceTimersByTime(60000);
				expect((logger.info as any).mock.calls.some((args: any[]) => String(args[0]).includes('no speech_final'))).toBe(false);
				partial('', true, true); // an empty speech_final emits nothing
				getMockWs().clearSentMessages();
				backend.forceCommit();
				expect(getMockWs().getSentMessages()).toHaveLength(1);
			});

			it('always injects the idle silence in granular mode too', async () => {
				const g = new XAIBackend('g-tag', { id: 'p2' });
				const p = g.connect({ ...DEFAULT_CONFIG, xaiGranularFinals: true, xaiGranularStabilityMs: 600, xaiGranularGuardWords: 2 });
				getMockWs().simulateOpen();
				await p;
				await g.sendAudio(Buffer.from([1, 2]).toString('base64'));
				partial('hello world foo bar', true, true); // the granular turn ends after the last audio
				getMockWs().clearSentMessages();
				g.forceCommit();
				expect(getMockWs().getSentMessages()).toHaveLength(1);
				g.close();
			});

			it('emits a non-empty transcript.done, as before the cap', () => {
				partial('alpha beta.', true, true);
				getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: 'gamma.' }));
				expect(finalTexts()).toEqual(['alpha beta.', 'gamma.']);
			});
		});

		it('does not repeat the early finals of a fresh turn that follows an idle-ended one', async () => {
			partial('alpha beta gamma delta epsilon.', true, false);
			vi.advanceTimersByTime(15000); // cap timer emits turn A
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000); // idle turn end: A's record is carried
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('one two three.', true, false); // turn B
			vi.advanceTimersByTime(15000); // cap timer emits "one two three."
			partial('four five six.', true, false); // past the cap: emitted at once
			// xAI started a fresh turn: B's speech_final does not contain A. Only its rest goes out.
			partial('one two three. four five six. seven eight.', true, true);
			expect(finalTexts()).toEqual(['alpha beta gamma delta epsilon.', 'one two three.', 'four five six.', 'seven eight.']);
			expect(warnLogs().filter((l) => l.includes('speech_final'))).toEqual([]);
		});

		it('emits only the rest when xAI folds an idle-ended turn into the next capped turn', async () => {
			partial('alpha beta gamma delta epsilon.', true, false);
			vi.advanceTimersByTime(15000);
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000);
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('one two three.', true, false);
			vi.advanceTimersByTime(15000);
			partial('four five six.', true, false);
			partial('alpha beta gamma delta epsilon. one two three. four five six. seven eight.', true, true);
			expect(finalTexts()).toEqual(['alpha beta gamma delta epsilon.', 'one two three.', 'four five six.', 'seven eight.']);
		});

		it('does not accept the anchor far from where the count puts it when xAI revised the emitted tail', () => {
			partial('I think that is right.', true, false);
			vi.setSystemTime(16000);
			partial('And we go with what I think that.', true, false); // flushes both (13 words, tail "I think that")
			expect(finalTexts()).toEqual(['I think that is right. And we go with what I think that.']);
			// The revised speech_final no longer holds the tail at the end, but does at words 0-3.
			partial('I think that is right. And we go with what I thought that. Then more.', true, true);
			expect(finalTexts()).toEqual(['I think that is right. And we go with what I think that.', 'Then more.']);
			expect(warnLogs().some((l) => l.includes('dropping 13 words by count'))).toBe(true);
		});

		it('keeps the punctuation that opens the rest of the turn', () => {
			partial('Hola.', true, false);
			vi.setSystemTime(16000);
			partial('Gracias.', true, false);
			partial('Hola. Gracias. ¿Vienes mañana? "Sí", dijo.', true, true);
			expect(finalTexts()).toEqual(['Hola. Gracias.', '¿Vienes mañana? "Sí", dijo.']);
		});

		it('flushes a held segment the speech_final does not carry before emitting the speech_final', () => {
			partial('alpha beta gamma.', true, false); // held, inside the cap
			vi.setSystemTime(5000);
			partial('delta epsilon zeta.', true, true); // xAI reset mid-turn: only what followed
			expect(finalTexts()).toEqual(['alpha beta gamma.', 'delta epsilon zeta.']);
			expect(warnLogs().some((l) => l.includes('does not carry'))).toBe(true);
		});

		it('discards a held segment the speech_final carries, re-punctuated', () => {
			partial('alpha beta gamma.', true, false);
			vi.setSystemTime(5000);
			partial('Alpha, beta gamma, delta epsilon.', true, true);
			expect(finalTexts()).toEqual(['Alpha, beta gamma, delta epsilon.']);
		});

		it('remembers the language a speech_final carries for the next turn\'s early finals', () => {
			const msg = (o: any) => getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.partial', ...o }));
			msg({ text: 'hello', is_final: false, speech_final: false, language: 'en' });
			msg({ text: 'bonjour tout le monde.', is_final: true, speech_final: true, language: 'fr' });
			vi.setSystemTime(1000);
			msg({ text: 'alpha beta.', is_final: true, speech_final: false }); // no language on the commits
			vi.setSystemTime(17000);
			msg({ text: 'gamma.', is_final: true, speech_final: false });
			expect(finalResults.map((m) => [m.transcript[0].text, m.language])).toEqual([
				['bonjour tout le monde.', 'fr'],
				['alpha beta. gamma.', 'fr'],
			]);
		});

		it('joins diarized words of a script without spaces without one, including outside the BMP', () => {
			(config.xai as any).diarize = true;
			try {
				const w = (text: string, speaker: number) => ({ text, speaker, confidence: 0.9 });
				partial('𠮷野家に行った。𠮷田です。', true, true, [w('𠮷野家に', 0), w('行った。', 0), w('𠮷田です。', 0)]);
				expect(finalTexts()).toEqual(['𠮷野家に行った。𠮷田です。']);
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('does not repeat a late speech_final for the second of two idle-ended turns', async () => {
			const idleEnd = async (text: string) => {
				partial(text, true, false);
				vi.advanceTimersByTime(15000);
				backend.forceCommit();
				vi.advanceTimersByTime(850 + 300 + 3000);
				await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			};
			await idleEnd('alpha beta gamma delta.');
			await idleEnd('one two three four five.');
			partial('one two three four five.', true, true); // the late answer for the second turn alone
			expect(finalTexts()).toEqual(['alpha beta gamma delta.', 'one two three four five.']);
			// ...and a fresh turn with early finals after both is still aligned against its own count.
			partial('six seven eight nine.', true, false);
			vi.advanceTimersByTime(15000);
			partial('six seven eight nine. ten.', true, true);
			expect(finalTexts().slice(2)).toEqual(['six seven eight nine.', 'ten.']);
		});

		it('discards a one-word held segment the speech_final re-renders rather than risk repeating it', () => {
			partial('OK.', true, false);
			vi.setSystemTime(5000);
			partial('Okay, let us go.', true, true);
			expect(finalTexts()).toEqual(['Okay, let us go.']);
		});

		it('drops a dash xAI put between the emitted part and the rest, but keeps an opening quote', () => {
			partial('we agreed.', true, false);
			vi.setSystemTime(16000);
			partial('the next step.', true, false);
			partial('We agreed — the next step — “fine”, he said.', true, true);
			expect(finalTexts()).toEqual(['we agreed. the next step.', '“fine”, he said.']);
		});

		it('accepts the anchor when xAI spells out what was emitted a little longer', () => {
			partial('paid 1250 for it.', true, false);
			vi.setSystemTime(16000);
			partial('cheap.', true, false); // 5 words emitted
			partial('paid one thousand two hundred fifty for it. cheap. then more words.', true, true); // 9 + 3
			expect(finalTexts()).toEqual(['paid 1250 for it. cheap.', 'then more words.']);
			expect(warnLogs().filter((l) => l.includes('speech_final'))).toEqual([]);
		});

		it('keeps a symbol that prefixes the first word of the rest, and a minus sign, but not a spaced dash', () => {
			partial('It cost.', true, false);
			vi.setSystemTime(16000);
			partial('The temperature was.', true, false);
			partial('It cost — the temperature was -5 degrees, $100 more.', true, true);
			expect(finalTexts()).toEqual(['It cost. The temperature was.', '-5 degrees, $100 more.']);
		});

		it('does not repeat a transcript.done that repeats the turn after an idle-ended one', async () => {
			partial('alpha beta gamma delta.', true, false);
			vi.advanceTimersByTime(15000);
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000); // A idle-ends, carried
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('one two three four five.', true, true); // B, a fresh turn
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: 'one two three four five.' }));
			expect(finalTexts()).toEqual(['alpha beta gamma delta.', 'one two three four five.']);
		});

		it('drops what is attached to the last emitted word, and an unspaced or doubled dash', () => {
			partial('went up 20%.', true, false);
			vi.setSystemTime(16000);
			partial('then it fell.', true, false);
			partial('went up 20%, and then it fell—so we -- sold “everything”.', true, true);
			expect(finalTexts()).toEqual(['went up 20%. then it fell.', 'so we -- sold “everything”.']);
			// (the "--" mid-rest is inside the rest, untouched; only what sits at the cut is dropped)
			partial('a b c.', true, false);
			vi.setSystemTime(40000);
			partial('d e f.', true, false);
			partial('a b c. d e f -- “g”', true, true);
			expect(finalTexts().slice(3)).toEqual(['“g”']);
		});

		it('keeps the opener of a fresh turn emitted whole after an idle-ended turn', async () => {
			partial('alpha beta gamma delta.', true, false);
			vi.advanceTimersByTime(15000);
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000);
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('¿Qué pasa contigo? “Hello,” he said. $100.', true, true);
			expect(finalTexts()).toEqual(['alpha beta gamma delta.', '¿Qué pasa contigo? “Hello,” he said. $100.']);
		});

		it('keeps an opener that has no space before it, in a script without spaces or after a dash', () => {
			partial('涨了。', true, false);
			vi.setSystemTime(16000);
			partial('然后跌了。', true, false);
			partial('涨了。「然后跌了」，「再涨」', true, true);
			expect(finalTexts()).toEqual(['涨了。然后跌了。', '「再涨」']);
			partial('it fell.', true, false);
			vi.setSystemTime(40000);
			partial('so we sold.', true, false);
			partial('it fell—so we sold—“cheap”.', true, true);
			expect(finalTexts().slice(2)).toEqual(['it fell. so we sold.', '“cheap”.']);
		});

		it('drops a straight closing quote or postfix currency symbol attached to the last emitted word', () => {
			partial('he said "yes".', true, false);
			vi.setSystemTime(16000);
			partial('it cost 20€.', true, false);
			partial('he said "yes". it cost 20€. "Then" the dogs\' bowls.', true, true);
			expect(finalTexts()).toEqual(['he said "yes". it cost 20€.', '"Then" the dogs\' bowls.']);
		});

		it('warns, not debugs, when a capped turn after an idle-ended one is emitted whole', async () => {
			partial('alpha beta gamma delta epsilon.', true, false);
			vi.advanceTimersByTime(15000);
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000); // A idle-ends, carried
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('one two three.', true, false);
			vi.advanceTimersByTime(15000); // cap emits "one two three."
			partial('one two tree. four.', true, true); // B's tail revised: neither anchor nor A's head
			expect(finalTexts()).toEqual(['alpha beta gamma delta epsilon.', 'one two three.', 'one two tree. four.']);
			expect(warnLogs().some((l) => l.includes('emitting it whole'))).toBe(true);
		});

		it('still flushes held segments a speech_final lacks when a carried record precedes them', async () => {
			partial('alpha beta gamma delta epsilon.', true, false);
			vi.advanceTimersByTime(15000);
			backend.forceCommit();
			vi.advanceTimersByTime(850 + 300 + 3000);
			await backend.sendAudio(Buffer.from([1, 2]).toString('base64'));
			partial('one two three.', true, false); // held, inside the cap
			partial('four five six.', true, false);
			partial('seven eight nine.', true, true); // xAI reset: only what followed
			expect(finalTexts()).toEqual(['alpha beta gamma delta epsilon.', 'one two three. four five six.', 'seven eight nine.']);
		});

		it('sends nothing on an owner-driven close', () => {
			partial('alpha beta.', true, false);
			backend.onCompleteTranscription = undefined;
			backend.close();
			expect(finalResults).toHaveLength(0);
		});

		describe('replaying a live xAI turn', () => {
			// test/fixtures/xai-live-turn.json: a real paused monologue. xAI commits each segment
			// with is_final=true and ends the turn with one speech_final carrying the whole turn.
			const fixture = require('../../fixtures/xai-live-turn.json');
			const replay = (events: any[]) => {
				for (const e of events) {
					vi.setSystemTime(e.t);
					partial(e.text, e.is_final, e.speech_final);
				}
			};
			const endOfTurn = fixture.events[fixture.events.length - 1];

			it('reproduces the turn exactly once when the cap splits it', () => {
				(config.xai as any).maxTurnMs = 10000;
				replay(fixture.events);

				// xAI re-punctuates the whole-turn text (segments end "that." / "person."; the turn
				// joins them with commas), so the emitted text is not a literal prefix and the rest is
				// found by word count. Compare words: every word once, in order, none dropped.
				const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
				expect(finalResults.length).toBeGreaterThan(1);
				expect(words(finalTexts().join(' '))).toEqual(words(endOfTurn.text));
			});

			it('still produces finals when xAI never sends speech_final', () => {
				(config.xai as any).maxTurnMs = 10000;
				replay(fixture.events.slice(0, -1));

				expect(finalResults.length).toBeGreaterThan(0);
				expect(finalTexts()[0].startsWith("But it's such a painful process")).toBe(true);
			});

			it('matches the old behaviour (one whole-turn final) with the cap off', () => {
				(config.xai as any).maxTurnMs = 0;
				replay(fixture.events);

				expect(finalTexts()).toEqual([endOfTurn.text]);
			});
		});
	});

	describe('close', () => {
		it('should set status to closed', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			backend.close();
			expect(backend.getStatus()).toBe('closed');
		});

		it('should call onClosed when WebSocket closes remotely', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const closedSpy = vi.fn();
			backend.onClosed = closedSpy;

			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			getMockWs().simulateClose();
			expect(closedSpy).toHaveBeenCalled();
		});

		it('should fire onClosed exactly once across close() and the close event', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const closedSpy = vi.fn();
			backend.onClosed = closedSpy;

			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			backend.close();
			getMockWs().simulateClose();
			expect(closedSpy).toHaveBeenCalledTimes(1);
		});
	});
});
