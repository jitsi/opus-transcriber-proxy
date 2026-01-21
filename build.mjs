import * as esbuild from 'esbuild';

await esbuild.build({
	entryPoints: ['src/server.ts'],
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	outfile: 'dist/bundle/server.js',
	sourcemap: true,
	packages: 'external', // Keep all node_modules external
	external: ['./dist/opus-decoder.cjs'], // Keep WASM module external
});

console.log('✅ Bundle created successfully');
