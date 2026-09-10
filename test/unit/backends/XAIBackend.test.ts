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
		 * Yields via setImmediate rather than a fixed sleep, so it doesn't depend on the
		 * backoff timing (connectBackoffMs is 0 in these tests); the generous iteration
		 * count keeps it robust on a loaded runner.
		 */
		async function waitForWsInstances(count: number): Promise<any> {
			for (let i = 0; i < 200 && wsInstances.length < count; i++) {
				await new Promise((resolve) => setImmediate(resolve));
			}
			if (wsInstances.length < count) {
				throw new Error(`expected ${count} ws instance(s), saw ${wsInstances.length}`);
			}
			return wsInstances[count - 1];
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

		it('does not retry a non-retryable status (401)', async () => {
			(config.xai as any).connectAttempts = 4;
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);

			wsInstances[0].simulateUnexpectedResponse(401, { 'x-request-id': 'req-auth' }, '{"error":"invalid api key"}');

			await expect(connectPromise).rejects.toThrow(/HTTP 401/);
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
