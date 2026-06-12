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
	// The native Opus addon (build/Release/opus_native.node) is loaded at runtime
	// via a dynamic require in src/OpusDecoder/nativeOpus.ts, so esbuild leaves it
	// alone — nothing extra to mark external here.
});

console.log('✅ Bundle created successfully');
