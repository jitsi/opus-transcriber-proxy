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
	define: {
		__GIT_HASH__: JSON.stringify(gitHash),
	},
});

console.log(`✅ Bundle created successfully (gitHash=${gitHash})`);
