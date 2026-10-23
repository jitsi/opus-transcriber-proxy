/*
 * Copyright @ 2025 - Present, 8x8 Inc
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
