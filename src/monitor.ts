// Monitor mode for the opus-transcriber-proxy image.
//
// Instead of serving as the transcription proxy, this entrypoint periodically checks that a
// running proxy is actually transcribing: it replays a sample Opus dump against a target
// /transcribe URL and exposes a Prometheus /metrics endpoint carrying a "healthy" flag.
//
// It is configured entirely from the environment so the same image can be pointed at any
// deployment:
//   MONITOR_URL                  target wss:// /transcribe URL. If it contains the literal token
//                                __SESSION_ID__ it is replaced per check with a fresh
//                                monitor-<random> id.
//   MONITOR_INTERVAL_SECONDS     how often to run a check (default 300)
//   MONITOR_HEADERS              extra request headers as a JSON object {"Name":"Value",...}
//                                (e.g. access-control headers); optional
//   MONITOR_CONNECT_TIMEOUT      seconds to wait for the websocket to open (default 30). Behind
//                                Cloudflare Containers the worker only completes the WS upgrade
//                                once the container is up, so a cold start (~30s) counts against
//                                this — it must be large enough to cover one.
//   MONITOR_ATTEMPTS             attempts per check (default 3); a check is unhealthy only if all
//                                of them fail. All attempts reuse the SAME sessionId, so retries
//                                land on the container the first attempt warmed rather than
//                                cold-starting a new one. Clamped to at least 1.
//   MONITOR_RETRY_DELAY_SECONDS  wait before each retry after a failed attempt (default 20).
//   MONITOR_DRAIN_SECONDS        after the sample finishes replaying, how long to keep the socket
//                                open for trailing finals before giving up (default 10). This is an
//                                upper bound: the attempt passes as soon as MONITOR_MIN_FINALS finals
//                                arrive, so the full drain elapses only when they never do. Raising it
//                                widens the tolerance for a slow provider finalization.
//   MONITOR_SAMPLE               path to the JSONL Opus dump to replay (default resources/sample.jsonl)
//   MONITOR_REPLAY_SPEED         playback speed for the sample replay (default 1, i.e. real time).
//                                Real-time pacing matches how a real client sends audio (paced 20ms
//                                Opus frames), which is what a provider's silence-based finalization
//                                (e.g. xAI's `endpointing`) is actually calibrated against. A full-speed
//                                blast (0 = no delay) compresses away the inter-utterance silence gaps
//                                and can make finalization land far later than it would for real
//                                traffic, causing false alarms unrelated to backend health.
//   MONITOR_MIN_FINALS           minimum final transcripts required to pass (default 1)
//   MONITOR_COUNT_INTERIMS       when true (default), MONITOR_MIN_FINALS interim transcripts also
//                                satisfy the check, not just finals. A provider that is visibly
//                                transcribing (interims flowing) but hasn't finalized yet is not a
//                                backend failure — set to false to require finals strictly.
//   MONITOR_PORT / PORT          port for the metrics HTTP server (default 8080)

import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const PORT = parseInt(process.env.MONITOR_PORT || process.env.PORT || '8080', 10);
const INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_SECONDS || '300', 10) * 1000;
const RETRY_DELAY_MS = parseInt(process.env.MONITOR_RETRY_DELAY_SECONDS || '20', 10) * 1000;
const CONNECT_TIMEOUT = process.env.MONITOR_CONNECT_TIMEOUT || '30';
const DRAIN = process.env.MONITOR_DRAIN_SECONDS || '10';
const MIN_FINALS = process.env.MONITOR_MIN_FINALS || '1';
const SAMPLE = process.env.MONITOR_SAMPLE || 'resources/sample.jsonl';
const REPLAY_SPEED = process.env.MONITOR_REPLAY_SPEED || '1';
// Default true: an interim shows the backend is actively transcribing, which is what this check
// cares about — see the header comment above for why finals-only is too strict.
const COUNT_INTERIMS = process.env.MONITOR_COUNT_INTERIMS !== 'false';
const URL_TEMPLATE = process.env.MONITOR_URL;
const REPLAY_SCRIPT = 'scripts/replay-dump.cjs';
// Number of attempts per check; the check is unhealthy only if all of them fail. All attempts of a
// check reuse the SAME sessionId, so retries land on the container the first attempt warmed rather
// than cold-starting a new one. Clamped to at least 1.
const ATTEMPTS = Math.max(1, parseInt(process.env.MONITOR_ATTEMPTS || '3', 10) || 3);

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

// Timestamped logging so the monitor's allocation logs read as a clear, ordered timeline.
const log = (msg: string): void => console.log(`${new Date().toISOString()} ${msg}`);

// State exposed via /metrics.
let healthy = 0; // 1 if the last completed check passed, 0 otherwise (0 until the first check)
let lastCheckTs = 0; // unix seconds of the last completed check
let lastHealthyTs = 0; // unix seconds of the last healthy check
let checksTotal = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface AttemptResult {
	ok: boolean;
}

// Run one replay attempt for the given session. Captures the replay's output and logs a single
// concise, timestamped summary line (connected? / result / transcript count) rather than the raw
// progress-bar stream, so the monitor logs stay readable.
function runAttempt(sessionId: string, attemptNo: number): Promise<AttemptResult> {
	return new Promise((resolve) => {
		const url = (URL_TEMPLATE as string).replace('__SESSION_ID__', sessionId);
		const finalsAssertFlag = COUNT_INTERIMS
			? `--assert-min-finals-or-interims=${MIN_FINALS}`
			: `--assert-min-finals=${MIN_FINALS}`;
		const args = [REPLAY_SCRIPT, SAMPLE, url, REPLAY_SPEED, '--ci', `--connect-timeout=${CONNECT_TIMEOUT}`, `--drain=${DRAIN}`, finalsAssertFlag];
		// Headers go to the replay via REPLAY_HEADERS (env), never on the command line, so
		// credential-bearing values stay out of the process argument list.
		const childEnv = { ...process.env };
		if (Object.keys(HEADERS).length > 0) childEnv.REPLAY_HEADERS = JSON.stringify(HEADERS);

		log(`monitor: attempt ${attemptNo}/${ATTEMPTS} starting (sessionId=${sessionId})`);
		const startedAt = Date.now();
		const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });

		let buf = '';
		const collect = (d: Buffer) => {
			buf += d.toString();
		};
		if (child.stdout) child.stdout.on('data', collect);
		if (child.stderr) child.stderr.on('data', collect);

		child.on('error', (err) => {
			log(`monitor: attempt ${attemptNo}/${ATTEMPTS} could not start replay: ${err.message}`);
			resolve({ ok: false });
		});
		child.on('exit', (code) => {
			const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
			const ok = code === 0;
			const connected = /Connected!/.test(buf);
			// The target server's `info` event (build/runtime/version), echoed by replay-dump.cjs as
			// `<info> {...}`. Logged here so the version of OTP this check actually hit is visible in
			// the monitor's own log stream, not just buried in the replay child's captured output.
			const infoMatch = buf.match(/<info> (\{.*\})/);
			if (infoMatch) log(`monitor: attempt ${attemptNo}/${ATTEMPTS} connected to ${infoMatch[1]}`);
			const resultLine = (buf.match(/INTEGRATION_RESULT:[^\n]*/g) || []).pop();
			const finalsMatch = buf.match(/(\d+)\s+final transcript/);
			const finals = finalsMatch ? parseInt(finalsMatch[1], 10) : 0;
			const interimsMatch = buf.match(/(\d+)\s+interim/);
			const interims = interimsMatch ? parseInt(interimsMatch[1], 10) : 0;
			const transcriptMatch = buf.match(/^\[[^\]]+\]\s+\([^)]*\)\s+(.+)$/m);
			const transcript = transcriptMatch ? transcriptMatch[1].trim().slice(0, 80) : '';
			if (ok) {
				log(`monitor: attempt ${attemptNo}/${ATTEMPTS} PASS in ${secs}s (finals=${finals}, interims=${interims}${transcript ? `, "${transcript}"` : ''})`);
			} else {
				const reason = resultLine
					? resultLine.replace('INTEGRATION_RESULT: ', '').replace('FAIL: ', '')
					: `replay exited ${code} with no result line`;
				log(`monitor: attempt ${attemptNo}/${ATTEMPTS} FAIL in ${secs}s (connected=${connected}; ${reason})`);
			}
			resolve({ ok });
		});
	});
}

// One check = an attempt plus one retry on failure, both against the same session id.
async function runCheck(): Promise<void> {
	const sessionId = 'monitor-' + crypto.randomBytes(6).toString('hex');
	const startedAt = Date.now();
	log(`monitor: check starting (sessionId=${sessionId})`);

	let result = await runAttempt(sessionId, 1);
	for (let attempt = 2; !result.ok && attempt <= ATTEMPTS; attempt++) {
		log(`monitor: retrying same session in ${RETRY_DELAY_MS / 1000}s`);
		await sleep(RETRY_DELAY_MS);
		result = await runAttempt(sessionId, attempt);
	}

	healthy = result.ok ? 1 : 0;
	lastCheckTs = Math.floor(Date.now() / 1000);
	if (result.ok) lastHealthyTs = lastCheckTs;
	checksTotal += 1;
	const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
	log(`monitor: check complete: ${result.ok ? 'HEALTHY' : 'UNHEALTHY'} (healthy=${healthy}) in ${secs}s`);
}

async function loop(): Promise<void> {
	for (;;) {
		try {
			await runCheck();
		} catch (err) {
			log(`monitor: check error: ${err instanceof Error ? err.message : String(err)}`);
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
	log(`monitor: metrics server listening on :${PORT}, interval=${INTERVAL_MS / 1000}s, connect-timeout=${CONNECT_TIMEOUT}s`);
	void loop();
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
	process.on(sig, () => {
		log(`monitor: received ${sig}, shutting down`);
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 3000).unref();
	});
}
