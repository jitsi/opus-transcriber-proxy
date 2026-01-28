/**
 * Global test setup file
 * Runs before all tests
 */

import { afterEach, beforeEach, vi } from 'vitest';

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
