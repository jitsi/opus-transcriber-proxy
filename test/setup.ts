/**
 * Global test setup file
 * Runs before all tests
 */

import { afterEach, beforeEach, vi } from 'vitest';

// Define ErrorEvent for Node.js environment (it exists in browsers but not Node)
if (typeof ErrorEvent === 'undefined') {
	(global as any).ErrorEvent = class ErrorEvent extends Event {
		message: string;
		error?: Error;

		constructor(type: string, init?: { message?: string; error?: Error }) {
			super(type);
			this.message = init?.message || '';
			this.error = init?.error;
		}
	};
}

// Reset all mocks between tests
afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

// Suppress console output during tests unless DEBUG is set
if (!process.env.DEBUG) {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'debug').mockImplementation(() => {});
	});
}
