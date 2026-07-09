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
	return new Promise((resolve, reject) => {
		function attempt() {
			const req = http.get(url, (res) => {
				res.resume();
				if (res.statusCode && res.statusCode < 500) resolve();
				else retry();
			});
			req.on('error', retry);
			req.setTimeout(2000, () => req.destroy());
		}
		function retry() {
			if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${url}`));
			else setTimeout(attempt, 1000);
		}
		attempt();
	});
}

function waitForPort(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		function attempt() {
			const socket = net.connect(port, '127.0.0.1');
			socket.on('connect', () => { socket.end(); resolve(); });
			socket.on('error', () => { socket.destroy(); retry(); });
		}
		function retry() {
			if (Date.now() > deadline) reject(new Error(`Timed out waiting for port ${port}`));
			else setTimeout(attempt, 1000);
		}
		attempt();
	});
}

/** Wait for a spawned process's stdout/stderr to match `pattern`, or reject on early exit/timeout. */
function waitForOutput(proc, pattern, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for /${pattern.source}/ in process output`)), timeoutMs);
		function onData(chunk) {
			process.stdout.write(chunk);
			if (pattern.test(chunk.toString())) {
				clearTimeout(timer);
				proc.stdout.off('data', onData);
				proc.stderr.off('data', onData);
				resolve();
			}
		}
		proc.stdout.on('data', onData);
		proc.stderr.on('data', onData);
		proc.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`Process exited (code ${code}) before matching /${pattern.source}/`));
		});
	});
}

async function startContainer({ port, opusBackend, provider }) {
	const name = `opus-itest-${randomUUID().slice(0, 8)}`;
	const env = ['-e', `OPUS_BACKEND=${opusBackend}`];
	if (provider === 'dummy') {
		env.push('-e', 'ENABLE_DUMMY_PROVIDER=true', '-e', 'PROVIDERS_PRIORITY=dummy');
	} else {
		env.push('-e', `PROVIDERS_PRIORITY=${provider}`, '-e', `${PROVIDER_KEY_ENV[provider]}=${process.env[PROVIDER_KEY_ENV[provider]]}`);
	}
	const dockerArgs = ['run', '-d', '--rm', '-p', `${port}:8080`, '--name', name, ...env, CONTAINER_IMAGE];
	log(`docker ${redact(dockerArgs).join(' ')}`);
	const code = await run('docker', dockerArgs);
	if (code !== 0) throw new Error(`docker run exited with code ${code}`);

	async function stop() {
		log(`Stopping container ${name}`);
		await run('docker', ['stop', name]).catch(() => {});
	}

	try {
		await waitForHttpOk(`http://localhost:${port}/health`, 60_000);
	} catch (err) {
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

	const wranglerArgs = ['dev', '--config', config, '--port', String(port), '--env-file', envFile];
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
	return { stop };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	const requiredKey = args.provider === 'dummy' ? null : (args.provider === 'openai' ? 'OPENAI_API_KEY' : PROVIDER_KEY_ENV[args.provider]);
	if (requiredKey && !process.env[requiredKey]) {
		log(`SKIP: ${requiredKey} not set — skipping ${args.runtime}/${args.opusBackend}/${args.endpoint}/${args.provider}`);
		process.exit(0);
	}

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
			`--connect-timeout=${args.runtime === 'worker' && args.endpoint === 'transcribe' ? 120 : 15}`,
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
