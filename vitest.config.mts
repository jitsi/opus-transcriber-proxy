/*
 * Copyright @ 2025 - present 8x8, Inc.
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

import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			// worker/ has its own node_modules (that is what cf:deploy installs), so a worker module and
			// a test file would otherwise resolve '@cloudflare/containers' to two different copies and a
			// vi.mock() in the test would not reach the worker's import. Pin both to the root copy,
			// resolved through the package's own entry so an SDK layout change cannot break the alias;
			// the two pins are kept at the same version (see CLAUDE.md). The alias exists only so
			// mocking works: tests never exercise the SDK's real code.
			'@cloudflare/containers': createRequire(import.meta.url).resolve('@cloudflare/containers'),
		},
	},
	test: {
		globals: true,
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html', 'lcov'],
			include: ['src/**/*.ts', 'worker/**/*.ts'],
			exclude: [
				'src/**/*.d.ts',
				'worker/**/*.d.ts',
				'src/server.ts', // Entry point, tested via integration
				'src/index.ts', // Cloudflare worker entry
				'worker/index.ts', // Worker entry: the fetch router, exercised by integration only
				'worker/handleTranslate.ts', // Worker /translate, covered by the worker integration cell
				'worker/translationRuntime.ts',
				'worker/opusWasmSource.ts', // imports .wasm; not loadable under vitest
				'worker/ContainerCoordinator.ts', // autoscale DO, not used in production
			],
			thresholds: {
				lines: 80,
				functions: 80,
				branches: 75,
				statements: 80,
			},
		},
		setupFiles: ['./test/setup.ts'],
		testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**', '**/test/index.spec.ts'],
		mockReset: true,
		restoreMocks: true,
		clearMocks: true,
	},
});
