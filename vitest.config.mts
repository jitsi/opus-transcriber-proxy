import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html', 'lcov'],
			include: ['src/**/*.ts'],
			exclude: [
				'src/**/*.d.ts',
				'src/OpusDecoder/opus-decoder.d.ts',
				'src/server.ts', // Entry point, tested via integration
				'src/index.ts', // Cloudflare worker entry
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
