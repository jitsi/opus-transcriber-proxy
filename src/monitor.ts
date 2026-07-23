// Monitor mode for the opus-transcriber-proxy image.
//
// Instead of serving as the transcription proxy, this entrypoint periodically checks that a
// running proxy is actually transcribing: it replays a sample Opus dump against a target
// /transcribe URL and exposes a Prometheus /metrics endpoint carrying a "healthy" flag.
//
// It is configured entirely from the environment so the same image can be pointed at any
// deployment:
//   MONITOR_URL                  target wss:// /transcribe URL. If it contains the literal token
//                                __SESSION_ID__ it is replaced per run with a fresh
//                                monitor-<random> id so consecutive checks never clash.
//   MONITOR_INTERVAL_SECONDS     how often to run a check (default 300)
//   MONITOR_HEADERS              extra request headers as a JSON object {"Name":"Value",...}
//                                (e.g. access-control headers); optional
//   MONITOR_RETRY_DELAY_SECONDS  wait before the single retry after a failed attempt (default 20);
//                                a check is unhealthy only if both attempts fail
//   MONITOR_SAMPLE               path to the JSONL Opus dump to replay (default resources/sample.jsonl)
//   MONITOR_CONNECT_TIMEOUT      seconds to wait for the websocket to connect (default 15)
//   MONITOR_MIN_FINALS           minimum final transcripts required to pass (default 1)
//   MONITOR_PORT / PORT          port for the metrics HTTP server (default 8080)

import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const PORT = parseInt(process.env.MONITOR_PORT || process.env.PORT || '8080', 10);
const INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_SECONDS || '300', 10) * 1000;
const RETRY_DELAY_MS = parseInt(process.env.MONITOR_RETRY_DELAY_SECONDS || '20', 10) * 1000;
const CONNECT_TIMEOUT = process.env.MONITOR_CONNECT_TIMEOUT || '15';
const MIN_FINALS = process.env.MONITOR_MIN_FINALS || '1';
const SAMPLE = process.env.MONITOR_SAMPLE || 'resources/sample.jsonl';
const URL_TEMPLATE = process.env.MONITOR_URL;
const REPLAY_SCRIPT = 'scripts/replay-dump.cjs';

if (!URL_TEMPLATE) {
	console.error('monitor: MONITOR_URL is required');
	process.exit(2);
}

function parseHeaders(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.error('monitor: MONITOR_HEADERS is not valid JSON, ignoring it');
		return {};
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		console.error('monitor: MONITOR_HEADERS must be a JSON object of name -> value, ignoring it');
		return {};
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
		out[k] = String(v);
	}
	return out;
}

const HEADERS = parseHeaders(process.env.MONITOR_HEADERS);

// State exposed via /metrics.
let healthy = 0; // 1 if the last completed check passed, 0 otherwise (0 until the first check)
let lastCheckTs = 0; // unix seconds of the last completed check
let lastHealthyTs = 0; // unix seconds of the last healthy check
let checksTotal = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Run one replay attempt against a fresh session. Resolves true on success (replay exit 0).
function runReplayOnce(): Promise<boolean> {
	return new Promise((resolve) => {
		const sessionId = 'monitor-' + crypto.randomBytes(6).toString('hex');
		const url = (URL_TEMPLATE as string).replace('__SESSION_ID__', sessionId);
		const args = [REPLAY_SCRIPT, SAMPLE, url, '0', '--ci', `--connect-timeout=${CONNECT_TIMEOUT}`, `--assert-min-finals=${MIN_FINALS}`];
		for (const [name, value] of Object.entries(HEADERS)) {
			args.push('-H', `${name}: ${value}`);
		}
		console.log(`monitor: starting check sessionId=${sessionId}`);
		const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		// Forward the replay's output line by line, but never echo its "Custom headers:" line:
		// the configured headers may carry credentials and must not reach the logs.
		const forward = (stream: NodeJS.ReadableStream, out: NodeJS.WritableStream) => {
			let buf = '';
			stream.on('data', (chunk) => {
				buf += chunk.toString();
				let nl: number;
				while ((nl = buf.indexOf('\n')) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (!line.startsWith('Custom headers:')) out.write(line + '\n');
				}
			});
			stream.on('end', () => {
				if (buf && !buf.startsWith('Custom headers:')) out.write(buf + '\n');
			});
		};
		if (child.stdout) forward(child.stdout, process.stdout);
		if (child.stderr) forward(child.stderr, process.stderr);
		child.on('exit', (code) => resolve(code === 0));
		child.on('error', (err) => {
			console.error(`monitor: failed to spawn replay: ${err.message}`);
			resolve(false);
		});
	});
}

// One check = an attempt plus one retry on failure. Updates the exposed state.
async function runCheck(): Promise<void> {
	let ok = await runReplayOnce();
	if (!ok) {
		console.log(`monitor: first attempt failed, retrying in ${RETRY_DELAY_MS / 1000}s`);
		await sleep(RETRY_DELAY_MS);
		ok = await runReplayOnce();
	}
	healthy = ok ? 1 : 0;
	lastCheckTs = Math.floor(Date.now() / 1000);
	if (ok) lastHealthyTs = lastCheckTs;
	checksTotal += 1;
	console.log(`monitor: check complete healthy=${healthy}`);
}

async function loop(): Promise<void> {
	for (;;) {
		try {
			await runCheck();
		} catch (err) {
			console.error(`monitor: check error: ${err instanceof Error ? err.message : String(err)}`);
			healthy = 0;
			lastCheckTs = Math.floor(Date.now() / 1000);
		}
		await sleep(INTERVAL_MS);
	}
}

function renderMetrics(): string {
	return [
		'# HELP opus_transcriber_proxy_monitor_healthy 1 if the last check transcribed the sample successfully, else 0',
		'# TYPE opus_transcriber_proxy_monitor_healthy gauge',
		`opus_transcriber_proxy_monitor_healthy ${healthy}`,
		'# HELP opus_transcriber_proxy_monitor_last_check_timestamp_seconds Unix time of the last completed check',
		'# TYPE opus_transcriber_proxy_monitor_last_check_timestamp_seconds gauge',
		`opus_transcriber_proxy_monitor_last_check_timestamp_seconds ${lastCheckTs}`,
		'# HELP opus_transcriber_proxy_monitor_last_healthy_timestamp_seconds Unix time of the last healthy check',
		'# TYPE opus_transcriber_proxy_monitor_last_healthy_timestamp_seconds gauge',
		`opus_transcriber_proxy_monitor_last_healthy_timestamp_seconds ${lastHealthyTs}`,
		'# HELP opus_transcriber_proxy_monitor_checks_total Number of completed checks since start',
		'# TYPE opus_transcriber_proxy_monitor_checks_total counter',
		`opus_transcriber_proxy_monitor_checks_total ${checksTotal}`,
		'',
	].join('\n');
}

const server = http.createServer((req, res) => {
	const path = (req.url || '').split('?')[0];
	if (path === '/health') {
		// Liveness only: healthy while the process is up, independent of the check result.
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('ok\n');
		return;
	}
	if (path === '/metrics') {
		res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
		res.end(renderMetrics());
		return;
	}
	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('not found\n');
});

server.listen(PORT, () => {
	console.log(`monitor: metrics server listening on :${PORT}, interval=${INTERVAL_MS / 1000}s`);
	void loop();
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
	process.on(sig, () => {
		console.log(`monitor: received ${sig}, shutting down`);
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 3000).unref();
	});
}
