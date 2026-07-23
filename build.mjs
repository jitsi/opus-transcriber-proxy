import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';

// Resolve the git commit this build is made from and bake it into the bundle (see src/buildInfo.ts).
// Falls back to the GIT_HASH env var (e.g. if .git is unavailable in the build context) then 'unknown'.
let gitHash = process.env.GIT_HASH || 'unknown';
try {
	gitHash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
		.toString()
		.trim();
} catch {
	// Not a git checkout (or git unavailable) — keep the env/'unknown' fallback.
}

await esbuild.build({
	// server.ts is the proxy (default image CMD); monitor.ts is the monitor mode, run via a
	// command override (node dist/bundle/monitor.js). Both ship in the one image.
	entryPoints: ['src/server.ts', 'src/monitor.ts'],
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	outdir: 'dist/bundle',
	sourcemap: true,
	packages: 'external', // Keep all node_modules external
	// The native Opus addon (build/Release/opus_native.node) is loaded at runtime via a dynamic
	// require in src/OpusDecoder/nativeOpus.ts. The WASM backend's Emscripten glue (dist/opus-*.cjs)
	// is kept external so esbuild doesn't try to bundle it. Which backend loads is chosen at runtime
	// (OPUS_BACKEND) via dynamic import; the other is never evaluated.
	external: ['./dist/opus-decoder.cjs', './dist/opus-encoder.cjs'],
	define: {
		__GIT_HASH__: JSON.stringify(gitHash),
	},
});

console.log(`✅ Bundle created successfully (gitHash=${gitHash})`);
