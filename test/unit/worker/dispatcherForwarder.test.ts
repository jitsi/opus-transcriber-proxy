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
 * Unit tests for worker/dispatcherForwarder.ts: the /translate path's Dispatcher DO socket. The
 * socket is a fake with workerd's close rules (a peer's close leaves it CLOSING until we reply).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDispatcherForwarder } from '../../../worker/dispatcherForwarder';

type Listener = (e: any) => void;

class FakeWs {
	readyState = 1;
	sent: string[] = [];
	closed: { code?: number; reason?: string } | null = null;
	private listeners = new Map<string, Listener[]>();
	accept() {}
	addEventListener(type: string, fn: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close(code?: number, reason?: string) {
		if (this.readyState === 3 || this.closed) throw new Error('close() on a WebSocket that is already closed');
		this.readyState = this.readyState === 2 ? 3 : 2;
		this.closed = { code, reason };
	}
	/** The peer sent a close frame: CLOSING until our handler replies. */
	remoteClose(code: number, reason: string) {
		this.readyState = 2;
		for (const fn of this.listeners.get('close') ?? []) fn({ code, reason });
	}
}

function setup() {
	vi.stubGlobal('WebSocket', { READY_STATE_OPEN: 1, READY_STATE_CLOSING: 2, READY_STATE_CLOSED: 3 });
	const sockets: FakeWs[] = [];
	const env = {
		DISPATCHER_DO: {
			idFromName: vi.fn(() => 'do-id'),
			get: vi.fn(() => ({
				fetch: vi.fn(async () => {
					const ws = new FakeWs();
					sockets.push(ws);
					return { webSocket: ws };
				}),
			})),
		},
	};
	vi.spyOn(console, 'log').mockImplementation(() => {});
	return { forwarder: createDispatcherForwarder(env as any, 's1'), sockets };
}

const message = { sessionId: 's1', endpointId: 'p1', text: 'hello', timestamp: 1 };

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('createDispatcherForwarder: close handshake', () => {
	it('replies to a close frame from the Dispatcher DO instead of leaving the socket CLOSING', async () => {
		const { forwarder, sockets } = setup();
		forwarder.forward(message);
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		sockets[0].remoteClose(1012, 'dispatcher restarting');
		expect(sockets[0].closed).toEqual({ code: 1012, reason: 'dispatcher restarting' });
		expect(sockets[0].readyState).toBe(3);
		// And the next final dials a fresh socket.
		forwarder.forward(message);
		await vi.waitFor(() => expect(sockets).toHaveLength(2));
		expect(sockets[1].sent).toHaveLength(1);
	});

	it('echoes a code workerd cannot send as 1000', async () => {
		const { forwarder, sockets } = setup();
		forwarder.forward(message);
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		sockets[0].remoteClose(1005, '');
		expect(sockets[0].closed).toEqual({ code: 1000, reason: '' });
	});

	it('closes its socket with 1000 at session end, so the DO has a code to echo', async () => {
		const { forwarder, sockets } = setup();
		forwarder.forward(message);
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		forwarder.close();
		expect(sockets[0].closed).toEqual({ code: 1000, reason: 'Session ended' });
	});
});
