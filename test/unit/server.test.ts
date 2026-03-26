/**
 * Tests for openai_custom provider validation in handleWebSocketConnection.
 *
 * server.ts has module-level side effects (server.listen, telemetry init) so
 * all of its dependencies are mocked to prevent network activity in tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ISessionParameters } from '../../src/utils';

// ── Mock all server.ts dependencies before the module loads ──────────────────
// Note: vi.mock() factories are hoisted – no references to outer variables allowed.

vi.mock('http', () => {
	const mockServer = { on: vi.fn(), listen: vi.fn(), close: vi.fn() }; // listen does NOT call its callback
	return { default: { createServer: vi.fn(() => mockServer) } };
});

vi.mock('ws', () => ({
	WebSocketServer: vi.fn(() => ({ on: vi.fn() })),
	WebSocket: vi.fn(),
}));

vi.mock('../../src/telemetry', () => ({
	initTelemetry: vi.fn(),
	initTelemetryLogs: vi.fn(),
	shutdownTelemetry: vi.fn().mockResolvedValue(undefined),
	shutdownTelemetryLogs: vi.fn().mockResolvedValue(undefined),
	isTelemetryEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/logger', () => ({
	default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	addOtlpTransport: vi.fn(),
}));

vi.mock('../../src/metrics', () => ({
	setMetricDebug: vi.fn(),
	writeMetric: vi.fn(),
}));

vi.mock('../../src/telemetry/instruments', () => ({
	getInstruments: vi.fn().mockReturnValue({
		clientWebsocketCloseTotal: { add: vi.fn() },
		transcriptionsDeliveredTotal: { add: vi.fn() },
	}),
}));

vi.mock('../../src/SessionManager', () => ({
	sessionManager: {
		hasSession: vi.fn().mockReturnValue(false),
		hasActiveSession: vi.fn().mockReturnValue(false),
		registerSession: vi.fn(),
		unregisterSession: vi.fn(),
		detachSession: vi.fn(),
		shutdown: vi.fn(),
	},
}));

vi.mock('../../src/config', () => ({
	config: {
		sessionResumeEnabled: false,
		debug: false,
		broadcastTranscripts: false,
		dumpWebSocketMessages: false,
		dumpTranscripts: false,
		dumpBasePath: '/tmp',
		useDispatcher: false,
		openaiCustomRequireWss: true,
		dispatcher: { wsUrl: '', headers: {} },
		server: { port: 8080, host: '0.0.0.0' },
	},
	// Plain functions (not vi.fn) so mockReset doesn't clear their implementations
	getAvailableProviders: () => ['openai', 'openai_custom'],
	getDefaultProvider: () => 'openai',
	isValidProvider: (p: string) => ['openai', 'openai_custom', 'deepgram', 'gemini', 'dummy'].includes(p),
	isProviderAvailable: () => true,
}));

vi.mock('../../src/transcriberproxy', () => ({
	TranscriberProxy: vi.fn().mockImplementation(() => ({
		on: vi.fn(),
		getOptions: vi.fn().mockReturnValue({ sendBack: false, sendBackInterim: false }),
		getWebSocket: vi.fn(),
		close: vi.fn(),
	})),
}));

// ── Import the function under test and mocked config ─────────────────────────

import { handleWebSocketConnection } from '../../src/server';
import { config as mockedConfig } from '../../src/config';
import { TranscriberProxy } from '../../src/transcriberproxy';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockWs() {
	return { close: vi.fn(), addEventListener: vi.fn(), readyState: 1 };
}

const openaiCustomParams: ISessionParameters = {
	url: new URL('ws://localhost/transcribe'),
	sessionId: undefined,
	useDispatcher: false,
	sendBack: true,
	sendBackInterim: false,
	encoding: 'opus',
	tags: [],
	provider: 'openai_custom',
	openaiCustomUrl: undefined,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleWebSocketConnection – openai_custom validation', () => {
	let mockWs: ReturnType<typeof makeMockWs>;

	beforeEach(() => {
		mockWs = makeMockWs();
		(mockedConfig as any).openaiCustomRequireWss = true; // reset to default before each test

		// mockReset (vitest config) clears vi.fn() implementations before each test – re-apply.
		vi.mocked(TranscriberProxy as any).mockReturnValue({
			on: vi.fn(),
			getOptions: () => ({ sendBack: false, sendBackInterim: false }),
			getWebSocket: vi.fn(),
			close: vi.fn(),
		});
	});

	it('closes with 1002 when X-Custom-Openai-Api-Key header is missing', () => {
		handleWebSocketConnection(
			mockWs as any,
			{ ...openaiCustomParams, openaiCustomUrl: 'wss://api.example.com/v1/realtime' },
			undefined, // no API key
		);

		expect(mockWs.close).toHaveBeenCalledOnce();
		expect(mockWs.close).toHaveBeenCalledWith(1002, expect.stringContaining('X-Custom-Openai-Api-Key'));
	});

	it('closes with 1002 when openaiCustomUrl parameter is missing', () => {
		handleWebSocketConnection(
			mockWs as any,
			{ ...openaiCustomParams, openaiCustomUrl: undefined },
			'sk-test-key',
		);

		expect(mockWs.close).toHaveBeenCalledOnce();
		expect(mockWs.close).toHaveBeenCalledWith(1002, expect.stringContaining('openaiCustomUrl'));
	});

	it('closes with 1002 when openaiCustomUrl is not a valid URL', () => {
		handleWebSocketConnection(
			mockWs as any,
			{ ...openaiCustomParams, openaiCustomUrl: 'not-a-url' },
			'sk-test-key',
		);

		expect(mockWs.close).toHaveBeenCalledOnce();
		expect(mockWs.close).toHaveBeenCalledWith(1002, expect.stringContaining('not a valid URL'));
	});

	it('closes with 1002 when openaiCustomUrl uses ws:// and requireWss is true', () => {
		handleWebSocketConnection(
			mockWs as any,
			{ ...openaiCustomParams, openaiCustomUrl: 'ws://api.example.com/v1/realtime' },
			'sk-test-key',
		);

		expect(mockWs.close).toHaveBeenCalledOnce();
		expect(mockWs.close).toHaveBeenCalledWith(1002, expect.stringContaining('wss://'));
	});

	it('does not close with 1002 when openaiCustomUrl uses ws:// and requireWss is false', () => {
		(mockedConfig as any).openaiCustomRequireWss = false;

		handleWebSocketConnection(
			mockWs as any,
			{ ...openaiCustomParams, openaiCustomUrl: 'ws://api.example.com/v1/realtime' },
			'sk-test-key',
		);

		expect(mockWs.close).not.toHaveBeenCalledWith(1002, expect.anything());
	});

	it('does not close with error when both key and valid wss:// URL are provided', () => {
		handleWebSocketConnection(
			mockWs as any,
			{ ...openaiCustomParams, openaiCustomUrl: 'wss://api.example.com/v1/realtime' },
			'sk-test-key',
		);

		expect(mockWs.close).not.toHaveBeenCalledWith(1002, expect.anything());
	});
});
