#!/usr/bin/env node
/**
 * Integration test orchestrator: starts one cell of the container/worker x opus-backend x
 * endpoint x provider matrix (see test/integration/MATRIX.md), replays resources/sample.jsonl
 * against it via scripts/replay-dump.cjs --ci, and exits non-zero on failure.
 *
 * Usage:
 *   node scripts/integration-test.mjs --runtime=container|worker --opus-backend=wasm|native \
 *     --endpoint=transcribe|translate --provider=openai|deepgram|xai|dummy [--translate-lang=es]
 *
 * Requires the relevant provider API key in the environment (e.g. OPENAI_API_KEY). If it's
 * missing, the run is soft-skipped (exit 0, logged) rather than failed — this lets the same
 * matrix run locally with a partial set of keys and in CI where not every secret may be set.
 *
 * runtime=container expects a prebuilt image (default tag "opus-transcriber-proxy", both Opus
 * backends baked in per the Dockerfile — override with INTEGRATION_TEST_IMAGE). Build it first:
 *   npm run docker:build
 *
 * runtime=worker shells out to `wrangler dev`; --opus-backend=native is rejected there because
 * worker/index.ts's buildContainerEnvVars() does not forward OPUS_BACKEND to the container, so a
 * Worker-routed session always runs the image's default (wasm) backend.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAMPLE_DUMP = path.join(REPO_ROOT, 'resources', 'sample.jsonl');
const CONTAINER_IMAGE = process.env.INTEGRATION_TEST_IMAGE || 'opus-transcriber-proxy';
// worker/package.json pins the wrangler version this repo is tested against — prefer it over
// whatever (if anything) is on PATH.
const LOCAL_WRANGLER = path.join(REPO_ROOT, 'worker', 'node_modules', '.bin', 'wrangler');
const WRANGLER_BIN = existsSync(LOCAL_WRANGLER) ? LOCAL_WRANGLER : 'wrangler';

const PROVIDER_KEY_ENV = {
	openai: 'OPENAI_API_KEY',
	deepgram: 'DEEPGRAM_API_KEY',
	xai: 'XAI_API_KEY',
	dummy: null,
};

function parseArgs(argv) {
	const args = { translateLang: 'es' };
	for (const arg of argv) {
		const [key, value] = arg.replace(/^--/, '').split(/=(.*)/s);
		if (key === 'runtime') args.runtime = value;
		else if (key === 'opus-backend') args.opusBackend = value;
		else if (key === 'endpoint') args.endpoint = value;
		else if (key === 'provider') args.provider = value;
		else if (key === 'translate-lang') args.translateLang = value;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!['container', 'worker'].includes(args.runtime)) {
		throw new Error(`--runtime must be "container" or "worker" (got ${args.runtime})`);
	}
	if (!['wasm', 'native'].includes(args.opusBackend)) {
		throw new Error(`--opus-backend must be "wasm" or "native" (got ${args.opusBackend})`);
	}
	if (!['transcribe', 'translate'].includes(args.endpoint)) {
		throw new Error(`--endpoint must be "transcribe" or "translate" (got ${args.endpoint})`);
	}
	if (!(args.provider in PROVIDER_KEY_ENV)) {
		throw new Error(`--provider must be one of ${Object.keys(PROVIDER_KEY_ENV).join(', ')} (got ${args.provider})`);
	}
	if (args.runtime === 'worker' && args.opusBackend === 'native') {
		throw new Error(
			'--runtime=worker only supports --opus-backend=wasm: worker/index.ts does not forward ' +
			'OPUS_BACKEND to the container, so a Worker-routed session always uses the image default (wasm).'
		);
	}
	if (args.runtime === 'worker' && args.endpoint === 'transcribe') {
		throw new Error(
			'--runtime=worker + --endpoint=transcribe is not a supported cell: production never routes ' +
			'/transcribe through the Worker (see test/integration/MATRIX.md).'
		);
	}
	if (args.endpoint === 'translate' && args.provider !== 'openai') {
		throw new Error('--endpoint=translate only supports --provider=openai (the only translation model configured).');
	}
	return args;
}

function log(msg) {
	console.log(`[integration-test] ${msg}`);
}

const SECRET_VALUES = new Set(Object.values(PROVIDER_KEY_ENV).filter(Boolean).map((k) => process.env[k]).filter(Boolean));

/** Redact known secret values before logging a command line (docker/wrangler args echo them raw). */
function redact(argsArray) {
	return argsArray.map((a) => {
		let out = a;
		for (const secret of SECRET_VALUES) out = out.split(secret).join('***REDACTED***');
		return out;
	});
}

function run(cmd, cmdArgs, opts = {}) {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, cmdArgs, { stdio: 'inherit', ...opts });
		proc.on('error', reject);
		proc.on('exit', (code) => resolve(code));
	});
}

function waitForHttpOk(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let settled = false;
	return new Promise((resolve, reject) => {
		function attempt() {
			if (settled) return; // a previous attempt already resolved/rejected the promise
			const req = http.get(url, (res) => {
				res.resume();
				if (res.statusCode && res.statusCode < 500) { settled = true; resolve(); }
				else retry();
			});
			req.on('error', retry);
			req.setTimeout(2000, () => req.destroy());
		}
		function retry() {
			if (settled) return;
			if (Date.now() > deadline) { settled = true; reject(new Error(`Timed out waiting for ${url}`)); }
			else setTimeout(attempt, 1000);
		}
		attempt();
	});
}

function waitForPort(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let settled = false;
	return new Promise((resolve, reject) => {
		function attempt() {
			if (settled) return;
			const socket = net.connect(port, '127.0.0.1');
			socket.on('connect', () => { settled = true; socket.end(); resolve(); });
			socket.on('error', () => { socket.destroy(); retry(); });
		}
		function retry() {
			if (settled) return;
			if (Date.now() > deadline) { settled = true; reject(new Error(`Timed out waiting for port ${port}`)); }
			else setTimeout(attempt, 1000);
		}
		attempt();
	});
}

/** Wait for a spawned process's stdout/stderr to match `pattern`, or reject on early exit/timeout. */
function waitForOutput(proc, pattern, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for /${pattern.source}/ in process output`)), timeoutMs);
		function onExit(code) {
			clearTimeout(timer);
			proc.stdout.off('data', onData);
			proc.stderr.off('data', onData);
			reject(new Error(`Process exited (code ${code}) before matching /${pattern.source}/`));
		}
		function onData(chunk) {
			process.stdout.write(chunk);
			if (pattern.test(chunk.toString())) {
				clearTimeout(timer);
				proc.off('exit', onExit); // otherwise stop()'s later kill fires this after we've settled
				proc.stdout.off('data', onData);
				proc.stderr.off('data', onData);
				resolve();
			}
		}
		proc.stdout.on('data', onData);
		proc.stderr.on('data', onData);
		proc.once('exit', onExit);
	});
}

async function startContainer({ port, opusBackend, provider }) {
	const name = `opus-itest-${randomUUID().slice(0, 8)}`;
	const env = ['-e', `OPUS_BACKEND=${opusBackend}`];
	// The API key goes through --env-file, not -e KEY=VALUE: -e args are visible in plaintext via
	// `/proc/<pid>/cmdline` of the invoking `docker` process (e.g. to `ps aux` on a shared host)
	// while `docker run` executes, which redact() (log-only) doesn't protect against. Note this does
	// NOT hide the value from `docker inspect` once the container is running — Docker resolves -e
	// and --env-file into the same `.Config.Env`, indistinguishable by source. Not a concern for a
	// single-tenant, ephemeral CI runner; the fix's actual value is scoped to the process-argv exposure.
	const varsDir = mkdtempSync(path.join(os.tmpdir(), 'opus-itest-'));
	const envFile = path.join(varsDir, 'itest.env');
	if (provider === 'dummy') {
		env.push('-e', 'ENABLE_DUMMY_PROVIDER=true', '-e', 'PROVIDERS_PRIORITY=dummy');
		writeFileSync(envFile, '');
	} else {
		env.push('-e', `PROVIDERS_PRIORITY=${provider}`);
		writeFileSync(envFile, `${PROVIDER_KEY_ENV[provider]}=${process.env[PROVIDER_KEY_ENV[provider]]}\n`);
	}
	const dockerArgs = ['run', '-d', '--rm', '-p', `${port}:8080`, '--name', name, '--env-file', envFile, ...env, CONTAINER_IMAGE];
	log(`docker ${redact(dockerArgs).join(' ')}`);
	const code = await run('docker', dockerArgs);
	if (code !== 0) throw new Error(`docker run exited with code ${code}`);

	async function stop() {
		log(`Stopping container ${name}`);
		await run('docker', ['stop', name]).catch(() => {});
		rmSync(varsDir, { recursive: true, force: true });
	}

	try {
		await waitForHttpOk(`http://localhost:${port}/health`, 60_000);
	} catch (err) {
		log(`Container failed to become healthy — dumping logs for ${name}:`);
		await run('docker', ['logs', name]).catch(() => {});
		await stop();
		throw err;
	}
	return { stop };
}

async function startWorker({ port, endpoint, provider, translateLang }) {
	const config = endpoint === 'translate' ? 'wrangler.translate.jsonc' : 'wrangler.jsonc';
	const varsDir = mkdtempSync(path.join(os.tmpdir(), 'opus-itest-'));
	const envFile = path.join(varsDir, 'itest.env');
	const lines = [];
	if (provider === 'dummy') {
		lines.push('ENABLE_DUMMY_PROVIDER=true', 'PROVIDERS_PRIORITY=dummy');
	} else if (endpoint === 'transcribe') {
		lines.push(`PROVIDERS_PRIORITY=${provider}`, `${PROVIDER_KEY_ENV[provider]}=${process.env[PROVIDER_KEY_ENV[provider]]}`);
	} else {
		lines.push(`OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`);
	}
	writeFileSync(envFile, lines.join('\n') + '\n');

	// --inspector-port=0: let the OS pick a free port for the devtools inspector instead of
	// wrangler's fixed default (9229), which could collide with something else on the runner.
	const wranglerArgs = ['dev', '--config', config, '--port', String(port), '--inspector-port', '0', '--env-file', envFile];
	log(`${WRANGLER_BIN} ${wranglerArgs.join(' ')} (config=${config})`);
	const proc = spawn(WRANGLER_BIN, wranglerArgs, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

	async function stop() {
		log('Stopping wrangler dev');
		proc.kill('SIGTERM');
		await new Promise((resolve) => proc.once('exit', resolve));
		rmSync(varsDir, { recursive: true, force: true });
	}

	try {
		// wrangler dev builds the container image (via Docker) as part of its own startup when the
		// config declares a `containers` block, so "Ready on" itself can be slow on a cache miss
		// (observed: node-gyp native compile alone takes ~50s inside the builder stage). The
		// container-free /translate config has no such step and is fast.
		await waitForOutput(proc, /Ready on /i, endpoint === 'transcribe' ? 240_000 : 30_000);
		await waitForPort(port, 30_000);
	} catch (err) {
		await stop();
		throw err;
	}
	// waitForOutput detached its own listeners once "Ready on" matched — reattach so wrangler's
	// output during the actual replay (errors, request logs) is visible instead of silently
	// dropped, and so its stdout/stderr pipes keep draining instead of risking backpressure.
	proc.stdout.on('data', (chunk) => process.stdout.write(chunk));
	proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
	return { stop };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	const requiredKey = PROVIDER_KEY_ENV[args.provider]; // null for 'dummy', key env var name otherwise
	if (requiredKey && !process.env[requiredKey]) {
		log(`SKIP: ${requiredKey} not set — skipping ${args.runtime}/${args.opusBackend}/${args.endpoint}/${args.provider}`);
		process.exit(0);
	}

	// Fixed ports: each CI matrix cell is its own isolated job/VM, so there's no conflict there.
	// Running two cells of the same runtime locally at once would collide on these — not a problem
	// this harness has hit in practice (cells are run one at a time), so not worth a dynamic-port
	// allocator until it actually is.
	const port = args.runtime === 'container' ? 18080 : 18787;
	log(`Starting ${args.runtime} (opus-backend=${args.opusBackend}, endpoint=${args.endpoint}, provider=${args.provider})`);

	const handle = args.runtime === 'container'
		? await startContainer({ port, opusBackend: args.opusBackend, provider: args.provider })
		: await startWorker({ port, endpoint: args.endpoint, provider: args.provider, translateLang: args.translateLang });

	try {
		const wsBase = `ws://localhost:${port}/${args.endpoint}`;
		const wsUrl = args.endpoint === 'translate' ? `${wsBase}?sendBack=true` : `${wsBase}?provider=${args.provider}&sendBack=true`;

		const replayArgs = [
			path.join(REPO_ROOT, 'scripts', 'replay-dump.cjs'),
			SAMPLE_DUMP,
			wsUrl,
			'0', // no delay — replay as fast as possible
			'--ci',
			// worker+transcribe (the only cell that would need a longer connect timeout, for the
			// container cold-start) is rejected in parseArgs — every remaining cell connects fast.
			'--connect-timeout=15',
		];
		if (args.endpoint === 'translate') {
			replayArgs.push(`--translate=${args.translateLang}`, '--assert-min-media=1');
		} else if (args.provider !== 'dummy') {
			// The dummy backend never emits transcripts (see src/backends/DummyBackend.ts) — its run
			// only proves the decode/wiring path survives cleanly, so it asserts nothing beyond --ci's
			// baseline (clean connect + clean close, enforced by replay-dump.cjs itself).
			replayArgs.push('--assert-min-finals=1');
		}

		log(`node scripts/replay-dump.cjs ... ${wsUrl}`);
		const code = await run('node', replayArgs, { cwd: REPO_ROOT });
		if (code !== 0) {
			log(`FAIL: replay exited with code ${code}`);
			process.exitCode = 1;
		} else {
			log('PASS');
		}
	} finally {
		await handle.stop();
	}
}

main().catch((err) => {
	console.error(`[integration-test] ERROR: ${err.message}`);
	process.exit(1);
});
