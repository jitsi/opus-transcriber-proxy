# Observability and debugging

_Split out of `CLAUDE.md`; see the task table there for which of these documents to read. Keep this file current in the same commit as the code it describes._

## Metrics and logging

**Metrics** (`src/metrics.ts`, `src/telemetry/instruments.ts`)
- Prometheus metrics exported to OTLP HTTP endpoint
- Tracks: active sessions, audio bytes, transcription latency, backend errors
- Only enabled when `OTLP_ENDPOINT` is set
- Each container instance is differentiated via `CONTAINER_INSTANCE_NAME` (the name the Worker looked the Durable Object up by, so the `sessionId` in session routing), then `CLOUDFLARE_DURABLE_OBJECT_ID`, then a random UUID for local dev. Metrics use `service.instance.id` (standard OTEL, Mimir-friendly). Logs use `runId` (custom name to avoid Loki auto-indexing it as a high-cardinality label). The per-container identity is needed: each container exports cumulative values from its own start, and without a distinct label the containers would write into one series.
- **Stale markers at shutdown** (`src/telemetry/staleMarkers.ts`). The per-container identity means one set of series per meeting. A collector that converts OTLP to Prometheus, such as Grafana Alloy, can keep a series in memory until that series gets a staleness marker (StaleNaN): the global labelstore of Alloy frees a series only after one. Alloy writes a StaleNaN only for a data point with the OTLP `NO_RECORDED_VALUE` flag, and a series that only stops arriving never gets one. So without markers such a collector keeps the series of every container until it restarts. To stop this, `SnapshotRecordingExporter` wraps the OTLP exporter and keeps the last exported snapshot. With cumulative temporality, that snapshot holds every series the process recorded. After the final export in `shutdownTelemetry` (SIGTERM), `buildStaleMarkerRequest` serializes that snapshot with the SDK's own `JsonMetricsSerializer` and sets `flags: 1` on every data point. The JS SDK cannot set data point flags itself. Attributes, values and histogram bounds stay the same, so every series matches, including `_sum`, `_count` and every `le` bucket. Observable gauges are covered too: a cumulative snapshot keeps an attribute set that a later collection did not observe. The timestamp is now, or 1 ms after the latest exported point, because Alloy skips an older point. The request is sent `OTLP_STALE_MARKER_SENDS` times (default 8, `0` disables), in parallel, each on a new connection (`agent: false`). This is a stopgap (see the comment on `sendStaleMarkers`): each collector replica keeps its own series, and a load balancer that picks a replica for each request spreads a container's pushes over several replicas. For example, with 2 replicas and per-request balancing, 8 sends miss one replica with a probability of about 0.8% (4 sends: 12.5%). A replica that never saw the series stores the marker and frees it later. It also forwards the StaleNaN, so the metrics backend can get a short series with one stale sample. With Alloy's `--feature.prometheus.direct-fanout.enabled` there is no labelstore, so the markers no longer free memory and one send is enough. Limits: a container that crashes, or that the platform kills without SIGTERM, sends nothing. `target_info` never goes stale: Alloy writes `target_info=1` for each request, the stale request included. Only the collector can fix that (`include_target_info = false` on `otelcol.exporter.prometheus`). Failures only log (`warn` with each error, and the start of a non-2xx response body), and the shutdown continues. `server.ts` shuts the OTLP logs pipeline down after the metrics, so that the stale-marker result line reaches the log backend.
- Container location is tagged via `city` (from `CLOUDFLARE_LOCATION`) and `country` (from `CLOUDFLARE_COUNTRY_A2`)

**Logging** (`src/logger.ts`)
- Uses Winston with OTLP logs transport
- Levels: error, warn, info, debug
- Set `LOG_LEVEL=debug` or `DEBUG=true` for verbose output

## Debugging tools

### WebSocket Message Dumping
```bash
DUMP_WEBSOCKET_MESSAGES=true npm run dev
# Messages saved to /tmp/{sessionId}/media.jsonl
```

### Replay Recorded Session
```bash
node scripts/replay-dump.cjs /tmp/session123/media.jsonl "ws://localhost:8080/transcribe?sendBack=true"
```

`replay-dump.cjs` reads extra request headers from the `REPLAY_HEADERS` environment variable, a JSON object. For example: `REPLAY_HEADERS='{"X-Tenant":"foo"}' node scripts/replay-dump.cjs ...`. It does not take headers as arguments, so credential values do not show in the process list.

To test a change to `replay-dump.cjs` itself, no provider is needed. Write a throwaway script, not a committed spec. The script starts a small `ws` server that plays the backend, then runs `replay-dump.cjs` against it. This is fast and deterministic for the CLI behaviour: the `--assert-min-*` thresholds and the drain and early-close timing. Start the child with async `spawn` and collect its output. Do not use `spawnSync`: it blocks the event loop of the process, so a `ws` server in the same process never accepts the connection, and the child always fails with `did not connect within Ns`. A fake server in a separate process also works.

```js
const { spawn } = require('child_process');
const child = spawn('node', ['scripts/replay-dump.cjs', dumpFile, wsUrl, '0',
  '--ci', '--drain=3', '--assert-min-finals=1']);
let out = '', err = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (err += d));
child.on('close', (status) => {
  // status is 0 on PASS. The INTEGRATION_RESULT line is on stdout for PASS, on stderr for FAIL.
});
```

To test the early close, let the fake server send a final N seconds after the replay ends. Check that the script closes at N, not at the end of `--drain`. Run the script from the repository root: `require('ws')` does not resolve outside the repository (`Cannot find module 'ws'`), and the relative script path is wrong. If you commit such a test, it needs the copyright header.

### Mix Audio from Session
```bash
npm run mix-audio -- /tmp/session123/media.jsonl output.wav
# Mixes all participant audio streams into a single WAV file
# Decodes via the OPUS_BACKEND-selected backend (default wasm); prefix OPUS_BACKEND=native to use the addon
```

### Monitor Mode (`src/monitor.ts`)

A second entrypoint bundled into the same image (`node dist/bundle/monitor.js`, vs. the default
`node dist/bundle/server.js`), used as a synthetic-check sidecar in deployment. Instead of serving
transcription, it periodically replays `resources/sample.jsonl` (via `scripts/replay-dump.cjs --ci`)
against a target `/transcribe` URL and exposes a Prometheus `/metrics` endpoint with a
`opus_transcriber_proxy_monitor_healthy` gauge, plus `/health` for liveness.

A check is unhealthy only if all `MONITOR_ATTEMPTS` attempts fail; all attempts reuse the same
`sessionId` so a retry lands on the container/session the first attempt warmed. After the sample
finishes replaying, `replay-dump.cjs` keeps the socket open — but in `--ci` mode closes as soon as
the finals/interims threshold is met rather than waiting out the full `--drain` window, so a
slow-but-successful transcription doesn't get scored as a failure (see PR #119: this was the root
cause of at least two production false-positive alerts — the fixed-length drain that preceded it
closed the socket just before the provider's trailing final arrived, even though the backend had
transcribed correctly).

The sample replays at real-time pace by default (`MONITOR_REPLAY_SPEED=1`), not blasted at full
speed: a provider's silence-based finalization (e.g. xAI's `endpointing`) is calibrated against audio
arriving paced like a real client's 20ms frames, and a full-speed blast compresses away the
inter-utterance silence gaps it depends on — this was a second, distinct source of false alarms
(finals landing far later than they would for real traffic, well after `MONITOR_MIN_FINALS` gave up).
Separately, `MONITOR_COUNT_INTERIMS` (default true) lets `MONITOR_MIN_FINALS` interim transcripts
satisfy the check on their own — a provider that's visibly transcribing (interims flowing) just
hasn't finalized yet is not a backend failure. Passed to `replay-dump.cjs` as
`--assert-min-finals-or-interims=<N>` instead of `--assert-min-finals=<N>`; set to `false` to require
finals strictly.

The target server's `info` message (`gitHash`, `runtime`, `provider`, `instanceId`, etc. — see
"Info" in `protocol.md`) is logged on every attempt: `replay-dump.cjs` echoes it verbatim as
`<info> {...}`, and `runAttempt` re-logs that line through the monitor's own timestamped `log()`, so
which OTP build/version a check actually connected to is visible in the monitor's log stream, not
just buried in the replay child's captured output.

```bash
MONITOR_URL="wss://host/transcribe?sessionId=__SESSION_ID__&sendBack=true" node dist/bundle/monitor.js
```

Configured entirely from the environment:
- `MONITOR_URL` — target `/transcribe` URL; `__SESSION_ID__` is replaced per check with a fresh `monitor-<random>` id
- `MONITOR_INTERVAL_SECONDS` — seconds between checks (default 300)
- `MONITOR_ATTEMPTS` — attempts per check (default 3, clamped to at least 1)
- `MONITOR_RETRY_DELAY_SECONDS` — wait before each retry after a failed attempt (default 20)
- `MONITOR_CONNECT_TIMEOUT` — seconds to wait for the WebSocket to open (default 30; must cover a Cloudflare Container cold start)
- `MONITOR_DRAIN_SECONDS` — after the sample finishes replaying, how long to keep the socket open for trailing finals before giving up (default 10); an upper bound only — see above
- `MONITOR_MIN_FINALS` — minimum final (or, with `MONITOR_COUNT_INTERIMS`, interim) transcripts required to pass (default 1)
- `MONITOR_COUNT_INTERIMS` — interim transcripts also satisfy `MONITOR_MIN_FINALS`, not just finals (default true; see above)
- `MONITOR_SAMPLE` — path to the JSONL Opus dump to replay (default `resources/sample.jsonl`)
- `MONITOR_REPLAY_SPEED` — sample playback speed (default 1, real time; 0 = no delay/full speed — see above)
- `MONITOR_HEADERS` — extra request headers as a JSON object (e.g. CF Access service-token headers). The monitor passes them to `replay-dump.cjs` in the `REPLAY_HEADERS` environment variable, never as arguments, so credential values do not show in the process list.
- `MONITOR_PORT` / `PORT` — port for the metrics HTTP server (default 8080)

Note: the monitor process does not self-report its own build (`gitHash`) anywhere — `monitor.ts`
doesn't import `src/buildInfo.ts`, so it emits no log line, no `/metrics` label, and sends no `info`
message of its own. To identify which commit a running monitor sidecar is from, check the `server.js`
bundle shipped in the same image (same build) instead. This is separate from the *target* server's
`info` message, which the monitor does log per attempt — see above.

#### Triage a monitor FAIL

- **Connected, but no transcripts.** With the default `MONITOR_COUNT_INTERIMS=true`, the FAIL line is `connected=true; expected >= 1 final or interim transcript(s), got 0 final(s) and 0 interim(s)`. With `MONITOR_COUNT_INTERIMS=false` it is `connected=true; expected >= 1 final transcript(s), got 0`. Neither is a WebSocket failure. Find the container's `Session ended: sessionId=<id> ... finals=N` line for the same `sessionId`. Do not use the time of that line: `TranscriberProxy.close()` logs it, and with session resume on (the default) that runs after the grace period (`SESSION_RESUME_GRACE_PERIOD`, default 15 s), so it is always later than the client close. What matters is that the container counted finals while the replay reported 0. Then the backend transcribed correctly and the provider finalized after the replay closed. That is a drain-timing failure, not an outage. With session resume on, attempts that share a `sessionId` can share the count, so `finals` above 0 can come from a different attempt.
- **Check the monitor build, not the target build.** The early close is `finishEarly()` in `scripts/replay-dump.cjs`. The monitor spawns that script from its own image, so the `gitHash` of the target says nothing about it. The monitor does not report its own build (see above): check the `server.js` bundle in the same image. The early close only shortens a run that passes. A final that arrives after the drain still fails. Raise `MONITOR_DRAIN_SECONDS` for that case.
- **More attempts do not fix a timing failure.** Every attempt replays the same sample with the same timing, so the same race can fail all `MONITOR_ATTEMPTS`. Do not raise `MONITOR_ATTEMPTS` to fix a connected-but-no-transcripts failure. Raise `MONITOR_DRAIN_SECONDS` when the provider finalizes later than the drain, and make sure the monitor image has the early close.
- **Log lines that do not explain a connected-but-no-transcripts FAIL.** A Durable Object storage reset (`Internal error in Durable Object storage caused object to be reset; reference = ...`) is a real, transient Cloudflare platform fault. It can cause a FAIL at the connect stage, when `worker/startRetry.ts` gives up on a container start (see `cloudflare.md`). It does not explain a check that connected and got no transcripts. The `cpuTimeMs` field is a field of the Cloudflare Worker invocation logs, not of this repository's code. It is on every invocation, `outcome=ok` included. It is not a CPU-limit error, so ignore it when you search the logs for "cpu".
- **`WebSocket error:` names the connect failure.** Node's dual-stack connect (`net`) reports a failure as an `AggregateError` with an empty `.message` when the host resolves to more than one address. The reason for each address is only in `.errors[]`, and the order of the addresses depends on the resolver. For example, `ws://localhost:PORT` gives the `AggregateError`, and `ws://127.0.0.1:PORT` gives a plain `connect ECONNREFUSED 127.0.0.1:PORT code=...`. `describeError` in `replay-dump.cjs` (added in #125) prints `.code`, `.errno`, `.syscall`, `.address`, `.port`, `.cause` and `.errors[]`, so the FAIL line names the cause: `ECONNREFUSED`, `ENOTFOUND` (DNS). In `--ci` mode a slow connect more often shows as `did not connect within Ns` than as `ETIMEDOUT`. A bare `WebSocket error: ` with nothing after it comes from a replay script that predates `describeError`.
- **Every attempt fails in well under a second.** If no matching request appears in the Worker or Durable Object logs, the connection failed before the request left the monitor host. Look at the monitor's network and DNS, not at the proxy. Against a closed local port the line reads `WebSocket error: AggregateError: (no message) code=ECONNREFUSED errors=[connect ECONNREFUSED ::1:PORT ...; connect ECONNREFUSED 127.0.0.1:PORT ...]`.

## Environment variables

- `DUMP_WEBSOCKET_MESSAGES` - Enable message dumping for debugging
- `OTLP_ENDPOINT` - OTLP HTTP endpoint for metrics/logs (disabled if empty)
- `OTLP_STALE_MARKER_SENDS` - How many times the container sends the stale-marker export at SIGTERM, each on a new connection (default: 8; `0` disables). See "Stale markers at shutdown" above. The CF Worker forwards it when set

`MONITOR_*` vars configure the separate monitor entrypoint (`src/monitor.ts`), not the proxy server — see "Monitor Mode" above.
