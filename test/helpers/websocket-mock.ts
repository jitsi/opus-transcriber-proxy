/**
 * WebSocket mock for testing
 * Mocks both ws library (server-side) and global WebSocket (client-side)
 */

import { EventEmitter } from 'node:events';

export interface MockWebSocketOptions {
	readyState?: number;
	url?: string;
	protocol?: string;
	autoConnect?: boolean;
}

export class MockWebSocket extends EventEmitter {
	public readyState: number;
	public url: string;
	public protocol: string;
	private sentMessages: any[] = [];
	private eventListeners: Map<string, Set<Function>> = new Map();

	// WebSocket ready states
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	constructor(options: MockWebSocketOptions = {}) {
		super();
		this.readyState = options.autoConnect !== false ? MockWebSocket.OPEN : MockWebSocket.CONNECTING;
		this.url = options.url || 'ws://localhost:3000';
		this.protocol = options.protocol || '';

		// Auto-trigger open event if autoConnect is true
		if (options.autoConnect !== false) {
			// Use setImmediate to simulate async connection
			setImmediate(() => {
				if (this.readyState === MockWebSocket.OPEN) {
					this.triggerEvent('open', {});
				}
			});
		}
	}

	/**
	 * Mock WebSocket.send()
	 */
	send(data: any): void {
		if (this.readyState !== MockWebSocket.OPEN) {
			throw new Error('WebSocket is not open');
		}
		this.sentMessages.push(data);
	}

	/**
	 * Mock WebSocket.close()
	 */
	close(code?: number, reason?: string): void {
		this.readyState = MockWebSocket.CLOSING;
		setImmediate(() => {
			this.readyState = MockWebSocket.CLOSED;
			this.triggerEvent('close', { code: code || 1000, reason: reason || '', wasClean: true });
		});
	}

	/**
	 * Mock WebSocket.addEventListener()
	 */
	addEventListener(event: string, handler: Function): void {
		if (!this.eventListeners.has(event)) {
			this.eventListeners.set(event, new Set());
		}
		this.eventListeners.get(event)!.add(handler);

		// Also use EventEmitter's on() for compatibility
		this.on(event, handler as any);
	}

	/**
	 * Mock WebSocket.removeEventListener()
	 */
	removeEventListener(event: string, handler: Function): void {
		const listeners = this.eventListeners.get(event);
		if (listeners) {
			listeners.delete(handler);
		}

		// Also use EventEmitter's off() for compatibility
		this.off(event, handler as any);
	}

	// Test helper methods

	/**
	 * Simulate receiving a message
	 */
	simulateMessage(data: any): void {
		if (this.readyState !== MockWebSocket.OPEN) {
			throw new Error('Cannot simulate message: WebSocket is not open');
		}
		this.triggerEvent('message', { data });
	}

	/**
	 * Simulate an error
	 */
	simulateError(error: Error | string): void {
		const errorMessage = error instanceof Error ? error.message : error;
		const errorEvent = Object.assign(new Error(errorMessage), { type: 'error' });
		this.triggerEvent('error', errorEvent);
	}

	/**
	 * Simulate WebSocket close
	 */
	simulateClose(code: number = 1000, reason: string = '', wasClean: boolean = true): void {
		this.readyState = MockWebSocket.CLOSED;
		this.triggerEvent('close', { code, reason, wasClean });
	}

	/**
	 * Simulate WebSocket open (for delayed connections)
	 */
	simulateOpen(): void {
		this.readyState = MockWebSocket.OPEN;
		this.triggerEvent('open', {});
	}

	/**
	 * Get all sent messages
	 */
	getSentMessages(): any[] {
		return [...this.sentMessages];
	}

	/**
	 * Get the last sent message
	 */
	getLastSentMessage(): any {
		return this.sentMessages[this.sentMessages.length - 1];
	}

	/**
	 * Clear sent messages history
	 */
	clearSentMessages(): void {
		this.sentMessages = [];
	}

	/**
	 * Get count of sent messages
	 */
	getSentMessageCount(): number {
		return this.sentMessages.length;
	}

	/**
	 * Check if a specific message was sent
	 */
	wasSent(data: any): boolean {
		return this.sentMessages.some((msg) => {
			if (typeof msg === 'string' && typeof data === 'string') {
				return msg === data;
			}
			// For objects, do deep comparison
			return JSON.stringify(msg) === JSON.stringify(data);
		});
	}

	/**
	 * Helper to trigger events on all listeners
	 */
	private triggerEvent(event: string, data: any): void {
		// Trigger EventEmitter listeners
		this.emit(event, data);

		// Trigger addEventListener listeners
		const listeners = this.eventListeners.get(event);
		if (listeners) {
			listeners.forEach((listener) => listener(data));
		}
	}
}

/**
 * Factory function to create a MockWebSocket
 */
export function createMockWebSocket(options: MockWebSocketOptions = {}): MockWebSocket {
	return new MockWebSocket(options);
}

/**
 * Mock the global WebSocket constructor for backend tests
 */
export function mockGlobalWebSocket(): typeof MockWebSocket {
	(global as any).WebSocket = MockWebSocket;
	return MockWebSocket;
}

/**
 * Restore the original WebSocket (cleanup)
 */
export function restoreGlobalWebSocket(): void {
	delete (global as any).WebSocket;
}
