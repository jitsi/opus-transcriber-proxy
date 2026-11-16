# Cloudflare Worker and Containers

_Split out of `CLAUDE.md`; see the task table there for which of these documents to read. Keep this file current in the same commit as the code it describes._

## Deployment

```bash
npm run cf:deploy          # Deploy to Cloudflare Workers
npm run cf:tail            # Tail logs
```

The worker code is in `worker/` and uses `@cloudflare/containers` to run the Node.js server in a container.

Five things to know about the Worker's use of the SDK:

- **How it is really deployed, and which lockfile that uses.** Production, staging and dev are
  deployed by the Jenkins job `deploy-cloudflare-opus-transcriber-proxy`, which runs
  `cloudflare/opus-transcriber-proxy/deploy.sh` from `jitsi/infra-customizations-private`. That script
  checks out this repo's **`main`**, runs `npm ci` at the **root**, and runs `wrangler deploy` from the
  root with the wrapper `wrangler.jsonc` kept in that repo (its `main` points at `worker/index.ts`
  here). `worker/node_modules` is never installed there, so the bundle resolves `@cloudflare/containers`
  from the root `node_modules`: **the root lockfile is what production runs**, and the package must
  stay installable by plain `npm ci` (it is a root devDependency; the server bundle never imports it).
  `worker/package.json` + `worker/package-lock.json` apply only to this repo's own `cf:deploy` and
  `wrangler dev`; keep the two pins at the same version. The wrapper config carries its own
  `compatibility_date`/`compatibility_flags`, `containers` and `vars`, so a change to any of those in
  this repo's `wrangler.jsonc` must be mirrored there to reach a deployment.
- **WebSocket upgrades bypass the SDK's relay.** Since 0.2.1 the SDK's `Container.fetch()` accepts
  the container's WebSocket inside the Durable Object and relays every message through a second
  `WebSocketPair` in JS, renewing the activity timer per message. `TranscriberContainer` overrides
  `fetch()` to return the container port's response directly for upgrades, as the SDK did before
  0.2.1. The reasons, in order of weight: every 20 ms audio frame of every participant would run a
  JS handler in the DO isolate (a 20-participant meeting is ~1000 messages/s on one single-threaded
  object); the relay remaps a 1006 abnormal close from the container to a clean 1000, hiding a
  container crash from the bridge and from our logs; and incoming frames would be billed as DO
  requests, though at 20 messages per billable request that is a minor cost. The consequence is that
  the SDK's activity timer never sees audio, so keeping a live call's container awake is done by the
  Worker's renewal loop and the `/status` probe in `onActivityExpired`. The probe counts the
  container's transcription sessions (`active`, `detached`) and its `/agent` sessions (`agents`),
  which the session manager does not track. Do not remove those on the assumption that the SDK
  renews on WebSocket traffic.
- **`ContainerProxy` is exported and `enable_ctx_exports` is on** although outbound interception is
  not used: since 0.2 the SDK's Container constructor looks up `ctx.exports.ContainerProxy` whenever
  the Durable Object is rebuilt around an already-running container, and logs an unhandled rejection
  if either is missing. Keep both when touching `worker/index.ts` or `wrangler.jsonc`.
- **A failed container start is retried once or twice before the 503.** `worker/startRetry.ts`
  retries `startAndWaitForPorts` through a fresh stub (a stub can be broken after it throws) only for
  the platform's transient failures: the stub error's `retryable` flag, or as a fallback the messages
  for an object no longer active, storage unreachable, "internal error; reference", a code-update
  reset or a storage failure that "caused object to be reset". It adds about a second of jittered
  waits (250 + 750 ms) on top of the attempts, and starts no retry whose wait would end more than
  5 s after the first attempt began, so that the one-to-few-second platform recoveries are absorbed
  in the request instead of each costing the bridge a round of exponential backoff. Never retried:
  overloaded objects (per Cloudflare's guidance), capacity and rate-limit failures, a container that
  crashed or never listened, and anything unrecognised. The Worker logs each retry ("Container start
  attempt N failed transiently, retrying"), and both outcomes carry the attempt count and elapsed time
  ("Container started and ready: <id> after N attempt(s) in Xms" / "Container failed to start after N
  attempt(s) in Xms: <error>, container=<id>"). So each rescued start is exactly one ready line with
  N > 1 (count those, not the retry warnings, of which a rescue writes N - 1), and each 503 for a start
  failure is one failed-to-start line (the Worker also answers 503 when the container cannot be
  reached after a successful start, which these lines do not cover, but the unreachable counter
  below does). The ready line is written on
  every request, including those that find the container already running, so its elapsed time
  mixes cold starts with near-instant checks. Each start is also counted, from the Worker itself
  (`worker/metrics.ts`): `otp_worker_container_starts{result, colo}` (`result` = `ok`, `rescued`,
  `gave_up` for a failure after retrying or a transient one with no retry left, `failed` for one
  the retry never touched; `ok` includes the warm-container checks) and
  `otp_worker_container_start_retries{colo}`, the retries the start took. Every push carries a zero
  for the other results and the retries: the collector makes a stream's first delta its first
  running total, which `rate()` cannot count, and forgets a stream idle for a day, so a rare
  failure would otherwise usually be invisible; the frequent `ok` pushes keep each colo's streams
  alive at zero. The limit: in a colo with no starts for a day, the first failure after the gap is
  still unseen (its push recreates the streams, so later ones count). Only WebSocket upgrades are
  counted (they are the sessions; a health check is not a start). A container that started but
  could not then take the upgrade is counted separately, as `otp_worker_container_unreachable{path,
  reason, colo}`: `path` = `direct` or `dispatcher`; `reason` = `stub_failed` when the call to the
  Durable Object threw, or the reason `TranscriberContainer.fetch` marks its own failure responses
  with in `X-Container-Failure` (`start_failed` when it had to start the container again and could
  not, `disconnected` when the port could not be reached). The container server's own refusals,
  such as an `/agent` upgrade answered 400 or 503, carry no mark and are not counted. Its series are
  kept alive at zero by the start pushes; those requests count as `ok` starts too. Metric code goes
  through `countLater`, which cannot throw into the request. They are OTLP
  **delta** counters, pushed one POST per start (and per unreachable container) inside
  `ctx.waitUntil` with the `OTLP_*` settings the Worker forwards to the container, and hand-built
  because the OpenTelemetry SDK does not run in a Worker. Every isolate sends the same series, with no instance identity: isolates are
  short-lived, and a series per isolate would lose each one's first count, which `rate()` cannot
  see. The collector (`nomad/alloy-cloudflare.hcl` in infra-customizations-private) restamps delta
  points with their arrival time so concurrent pushes stay in order, converts them to running
  totals per replica, and tags each replica `collector_replica`; it stores them as `..._total`. So a
  query **sums** across replicas (`sum by (result) (rate(otp_worker_container_starts_total[5m]))`),
  unlike the container's cumulative `otp_*` counters, which take the max. The payload sets
  `cloudflare.source` to `cloudflare-workers` over the deployment's `OTLP_RESOURCE_ATTRIBUTES`
  (which names the container). With no `OTLP_ENDPOINT` nothing is pushed; a failed push (a missing
  token answers 401) only logs `Metrics push failed`. Alert rules on them do not live in this repo.
- **Two SDK details the DO class depends on.** `TranscriberContainer.envVars` carries
  `CONTAINER_INSTANCE_NAME` (from `ctx.id.name`) so every start path, including the SDK's
  start-on-fetch, gives the container the same identity. And any `containerFetch` response body must
  be consumed or cancelled: since 0.2.1 an unread body keeps the request counted as in flight, and
  `isActivityExpired()` is false while anything is in flight, so the container would never sleep.

## Worker modules and routing modes

The `worker/` directory contains:
- `index.ts` - Cloudflare Worker entry point: the fetch router, plus the Durable Object class re-exports wrangler needs
- `TranscriberContainer.ts` - the container Durable Object (passthrough `fetch` override, which marks its own failure responses with `X-Container-Failure`; `/status` idle probe; `startAndWaitForPorts` adopts the `SLEEP_AFTER` the Worker starts it with, so a KV config override reaches it)
- `routing.ts` - `selectContainerInstance` (session / pool / shared / autoscale)
- `sessionProxy.ts` - `handleWebSocketWithDispatcher`: the client<->container pipe with dispatcher forwarding and the keepalive loop. Every socket it holds (client, container, Dispatcher DO) gets a reply to a received close frame, since our compatibility date has no automatic reply; a close from a dispatcher socket that has already been replaced does not start another reconnect. A socket left CLOSING is not free: workerd runs every accepted socket's read loop as a `waitUntil` task, so one whose peer never replies is cancelled 30 s after the invocation ends with the "waitUntil() tasks did not complete" warning — that warning once per session means a peer (the Dispatcher DO is the candidate) is not answering our close. The dispatcher socket's close is logged at `info` only when it is the DO's 1000 reply to a close we sent (`dispatcherCloseSent`); every other close is an `error` (mid-session the DO dropping us, which the backoff reconnect recovers from; after our close a DO that vanished instead of replying). A dispatcher socket dialled after the session ended (the flush-on-close reconnect) gets no listeners, so its close is not logged at all. `closeCode.ts` holds `sendableCloseCode`, shared with `dispatcherForwarder.ts`, the `/translate` path's dispatcher socket, which replies to a received close frame the same way. Only `/transcribe` takes the `sessionProxy.ts` path. The gate is in `worker/index.ts`. This path runs a handler on every frame in both directions, and that costs Worker CPU. So `/agent` and every other upgrade that goes to the container are a plain pass-through. `USE_DISPATCHER` and `useDispatcher` do not change this. A pass-through upgrade gets no `worker` block in the `info` message and no Worker keepalive loop. The idle probe in `TranscriberContainer.onActivityExpired` keeps its container awake
- `vars.ts` - **every Worker variable, defined once**: how it is forwarded to the container and whether (and with which value type) it can be overridden from KV. `Env` takes its variable fields from this table
- `containerEnv.ts` - container env vars (a loop over `vars.ts`), instance name, the `worker` info block
- `startRetry.ts` / `metrics.ts` - the container start retry, and the OTLP counters the Worker pushes for each start
- `ContainerCoordinator.ts` - Manages container routing (pool vs session mode)
- `handleTranslate.ts` - Worker-hosted `/translate` (no container; see the runtime abstraction in `translate.md`)
- `dispatcherForwarder.ts` - the `/translate` path's Dispatcher DO socket: bounded queue while (re)connecting, reopened on the next forward, replies to a received close frame
- `closeCode.ts` - `sendableCloseCode`, the close codes workerd will put in a close frame, shared by `sessionProxy.ts` and `dispatcherForwarder.ts`
- `translationRuntime.ts` / `outboundWebSocket.ts` / `opusWasmSource.ts` - the Worker `TranslationRuntime`
- `providerOverride.ts` - the KV-backed provider overrides: transcription, speech-to-speech translation, text translation (see below)
- `configOverride.ts` - the KV-backed config overrides of the variables `vars.ts` marks overridable (see below); `kvEntry.ts` holds the entry parsing and `until` check both kinds share
- Uses `@cloudflare/containers` to run the Node.js server for `/transcribe`

Two routing modes:
1. **Session mode** (`ROUTING_MODE=session`): One container per session
2. **Pool mode** (`ROUTING_MODE=pool`): Round-robin across container pool

### Provider overrides (`worker/providerOverride.ts`)

An operator lever to move a service to a secondary provider during a provider outage, **without a
Worker release**. Each service picks its default provider from a deploy-time variable
(`PROVIDERS_PRIORITY`, `TRANSLATION_PROVIDER`, `TEXT_TRANSLATION_PROVIDERS_PRIORITY`), and for the
container that variable is baked into its environment at container start — so a change needs a
release *and* would not reach an already-running container anyway. Instead the Worker rewrites the
service's provider URL parameter per connection, which the server already parses, so **nothing
server-side changes** (no image rebuild; this is a Worker-only deploy).

**Every service with more than one backend has a slot** (`ProviderOverrideSlot`): its KV key, the
URL parameter, the providers an override may name, and the credential check for one. Adding a
backend to a service means adding it to that slot's list and `isConfigured`; adding a service with
several backends means adding a slot and applying it where its requests are routed.

| Slot | KV key | Parameter | Targets | Where applied |
|---|---|---|---|---|
| `transcribe` | `transcribe:provider-override` | `provider` (also pinned by `xai_stt_endpoint`) | `openai`, `deepgram`, `gemini`, `xai` | `/transcribe` upgrades, before the container is selected |
| `translate` | `translate:provider-override` | `provider` | `openai`, `xai` | `/translate` upgrades, before `handleTranslate` |
| `text-translation` | `text-translation:provider-override` | `text_translation_provider` | `openai`, `xai`, `gemini`, `google` | `/transcribe` upgrades, only when `ENABLE_TEXT_TRANSLATION=true` (the container ignores the parameter otherwise, so the read would be wasted) |

`/agent` has no slot: its one endpoint is the customer's, chosen per agent. `openai_custom`,
`dummy` and `stub` are not valid override *targets* (the first needs the caller's own URL and key;
the other two produce nothing real). `/transcribe` and `/translate` both take `provider`, so the two
slots are told apart by KV key, not by parameter; each key is prefixed by its slot.

Armed by writing the slot's KV key in the `CONFIG_KV` namespace; the entry shape is the same for
every slot:

```bash
# CLOUDFLARE_ACCOUNT_ID must be set: the deploy tokens reach several accounts, and wrangler
# otherwise stops and asks which one to use (in a script it just fails).
export CLOUDFLARE_ACCOUNT_ID=<account id for this environment>
# `until` is computed, never pasted: a literal from an older runbook is already in the past, and an
# expired entry is ignored (at info level), so the override silently does nothing.
wrangler kv key put transcribe:provider-override \
  "{\"provider\":\"deepgram\",\"until\":$(( $(date +%s) * 1000 + 7200000 )),\"reason\":\"xAI 503s\"}" \
  --namespace-id=<id> --ttl 7200 --remote
# Speech-to-speech: the same, under translate:provider-override with provider openai or xai.
# Text translation: under text-translation:provider-override.
```

The flag is `--ttl` (seconds), not `--expiration-ttl`, and `--remote` is required — without it
wrangler writes to the local simulator and the deployed Worker never sees the key.

**`until` is the effective deadline; `--ttl` is only a safety net.** `until` is in **milliseconds**
and is what the Worker enforces, at read time. `--ttl` is in seconds and merely deletes the key
later. When they disagree the shorter one wins in practice: `until` stops the override being
applied, `--ttl` stops the key existing. Set them to the same window. A `until` given in *seconds*
is rejected as malformed (at `error`), rather than being read as an override that expired in 1970 —
that mistake would otherwise look like a quietly armed override while traffic stayed on the failing
provider.

Three properties are load-bearing, for every slot:

- **An explicit parameter is never overridden** — checked before the KV read, so an explicitly
  pinned connection costs nothing and cannot be redirected. This protects `openai_custom`, which
  carries the caller's own endpoint and API key: overriding it would send that customer's audio to
  a provider they did not choose. Production's jicofo URL templates carry no provider parameters,
  so the overrides still cover ordinary traffic. The slots are independent: a `/transcribe` request
  naming `provider` pins only the transcription slot, and its text-translation slot is still read.
  The `transcribe` slot is also pinned by `xai_stt_endpoint` (`ProviderOverrideSlot.pinParams`): that parameter only works with the xAI
  provider, so moving such a request to another provider would end in a 1002 on every redial for the whole override window. Production's URL
  templates that pin an endpoint carry no `provider` parameter, so this is the case that matters. Unlike an explicit `provider`, this check needs
  the KV read, so that an operator who armed an override is told: the skip is logged at `warn` (`request pins the provider with
  xai_stt_endpoint, so the override to <provider> is not applied to it`), and only when an override would have applied. The pinned connection
  stays on xAI and fails there, where the backend errors are counted.
- **Every rejection degrades to "no override"**, never to a broken session. The container closes
  the socket with 1002 when handed an invalid or unavailable transcription provider, and the Worker
  refuses a `/translate` upgrade with 400/503 for one, so an unparseable entry, an unknown provider,
  a provider whose API key is unset, or a KV read failure must all fall back to the configured
  default. They log (`error` for operator mistakes) and change nothing. (The container does not fail
  a session over an unusable text-translation provider; it falls back and logs. The checks guard
  that slot against an override that silently does nothing.)
  A request that pins the provider with `xai_stt_endpoint` is left alone too (rule 1), so no override can turn it into a 1002 loop. What can
  still close such a request is a change that the Worker does not make: a `PROVIDERS_PRIORITY` change, or an xAI key that is unset. The
  container then closes it with 1002, at `error`, and does not move the audio to another provider.
- **`until` is mandatory and checked here at read time**, not left to KV's own expiration, which the
  edge cache can lag. Capped at `MAX_OVERRIDE_WINDOW_MS` (24h), and a longer window is *refused*
  rather than clamped — the cap exists to force a re-arm, and silently shortening it would look
  like acceptance. When an override lapses, new sessions return to the default, which re-tests the
  primary provider automatically rather than relying on anyone remembering to switch back.

The KV read is cached at the edge for `OVERRIDE_CACHE_TTL_SECONDS` (60), so arming an override
takes up to a minute to propagate. A `/transcribe` upgrade with text translation on reads two keys,
in parallel (`applyProviderOverrides`).

**Scope limits worth knowing:**
- **New connections only.** The provider is fixed when `TranscriberProxy` / `TranslatorProxy` is
  constructed, and session resume reuses the original parameters, so a conference already in
  progress stays on the provider it started with until it ends. A `/translate` direction the proxy
  reopens (idle close, provider close) reuses the connection's provider too.
- The monitor's URL carries no `provider` parameter, so it is overridden too and tracks what users
  actually get. To probe whether the primary has recovered, pin a check explicitly with
  `?provider=<primary>` (rule 1 makes that immune to the override).
- A standalone container deployment with no Worker in front gets no override.
- **A connection that names an xAI STT endpoint stays on xAI.** `xai_stt_endpoint` pins the
  `transcribe` slot (rule 1), so the override does not reach conferences whose jicofo URL template
  names an endpoint, for example to keep audio in a region. During an xAI outage those conferences
  do not fail over to the override provider. They fail on xAI, where the backend errors are
  counted, and the skipped override is logged at `warn` for as long as it is armed. The other
  conferences still move. Tell the operator who arms the override that this is the cost of pinning.
- **Only WebSocket upgrades on `/transcribe` and `/translate` are considered.** Health and status
  probes, `/agent` upgrades and plain GETs are forwarded untouched, so they cost no provider-override
  KV read and cannot log an override decision. (The config overrides below are read on every
  request, since any request can start a container.)
- **For the two `/transcribe` slots, the target provider's key must already have been set when the
  running containers started.** The Worker checks its own current env, but a container validates
  against the env it was started with (`buildContainerEnvVars`). Adding a provider's secret and
  arming the override in the same breath is therefore unsafe: a container started before the secret
  existed still has the empty value and closes its new sessions with 1002, which is exactly what
  the fall-back-to-default rule is meant to prevent. Set the key, let the containers cycle, then
  arm. The `translate` slot has no such lag: the Worker serves `/translate` itself, so the env it
  checks is the env the session runs with.
- The `translate` slot's credential check uses the same fallbacks as the runtime
  (`OPENAI_TRANSLATION_API_KEY` ?? `OPENAI_API_KEY`, `XAI_TRANSLATION_API_KEY` ?? `XAI_API_KEY`), and
  the `text-translation` slot's the container's (`TEXT_TRANSLATION_<P>_API_KEY` ?? the provider's
  transcription key; `google` takes its API key or credentials JSON and has no fallback).

An applied override is logged in the Worker and recorded in the `info` message, since the server
cannot tell an override apart from a client-supplied parameter: `worker.providerOverride` for the
`transcribe` slot and `worker.textTranslationProviderOverride` for the `text-translation` slot, on
the `worker` block `sessionProxy.ts` adds, which exists only on the dispatcher path
(`USE_DISPATCHER`) — with pass-through routing those two are visible in the Worker log but not in
`info`; and `worker.providerOverride` for the `translate` slot, in the `info` the Worker-hosted
`/translate` builds itself (`worker/translationRuntime.ts`), on every routing mode.

### Config overrides (`worker/configOverride.ts`)

An operator lever to change a Worker variable at runtime, **without a release**. A KV entry under
`config:<NAME>` in `CONFIG_KV` takes precedence over the Worker variable `<NAME>`. Only the
variables `worker/vars.ts` declares with a `kv` type are read; the key is always derived from the
name.

```bash
export CLOUDFLARE_ACCOUNT_ID=<account id for this environment>
# Until a computed time (milliseconds):
wrangler kv key put config:XAI_ENDPOINTING \
  "{\"value\":1200,\"until\":$(( $(date +%s) * 1000 + 7200000 )),\"reason\":\"tuning\"}" \
  --namespace-id=<id> --remote
# With no expiry:
wrangler kv key put config:LOG_LEVEL '{"value":"debug","until":-1}' --namespace-id=<id> --remote
# Remove the override (the Worker variable applies again):
wrangler kv key delete config:LOG_LEVEL --namespace-id=<id> --remote
```

Entry shape: `{"value": <value>, "until": <ms since epoch | -1>, "reason": "<optional>"}`.
- `value` must have the variable's type: `bool` (`true`/`false`), `int` (with a lower bound where
  one makes sense; `TRANSLATION_TALK_SILENCE_TIMEOUT_MS` above the 100 ms RTP gap threshold),
  `float`, an enum (`XAI_ENCODING`, `LOG_LEVEL`, ...), a JSON object (`OPENAI_TURN_DETECTION`), a
  `wss` URL on `x.ai` or a subdomain, on the default port, with no credentials, query or fragment
  (`XAI_STT_URL`, `XAI_TRANSLATION_URL`, and each URL in `XAI_STT_ENDPOINTS`: all carry the xAI key as a bearer and every conference's
  audio, and the value is logged and reported in `info`), a duration (`SLEEP_AFTER`: the SDK's `"7m"` format,
  from 4 minutes to 24 hours, because the SDK throws on any other form, the keepalive renews every
  180 s, and an idle container is billed), or a string. `null` unsets the variable, so its default
  applies. Two types check the value against the Worker's own env (the `env` argument of
  `KvType.normalize`): `ROUTING_MODE=autoscale` is refused when the Worker has no
  `CONTAINER_COORDINATOR` binding, since every upgrade would then fail; and `AGENT_ALLOWED_HOSTS`
  (an empty allowlist allows any public host) must hold at least one host, cannot be `null`, is
  written back normalized as the container reads it, and may only narrow a non-empty Worker list:
  each entry must be a host or subdomain of a Worker entry. Delete the key to restore the Worker
  value.
- `until` is **mandatory** and in **milliseconds**; `-1` means no expiry. There is **no cap**,
  unlike the provider overrides (whose 24 h cap forces a re-test of the primary). A `until` in
  seconds (below `MIN_PLAUSIBLE_UNTIL_MS`) or in microseconds or nanoseconds (above
  `MAX_PLAUSIBLE_UNTIL_MS`, the year 2286) is refused as malformed, for both kinds of override. Log
  messages format a time with `isoTime`, which cannot throw.

**How it works.** `index.ts` calls `resolveConfigOverrides(env)` first, on every request, and
assigns the result to `env`: the Worker's env with the applied overrides overlaid. Everything after
it reads that **effective env** — the `ENABLE_TRANSLATE` gate, the provider-override slots, routing,
the dispatcher choice, the Worker-hosted `/translate`, and `buildContainerEnvVars` for a container it
starts. All keys are read in one bulk KV read (split at `KV_BULK_GET_MAX_KEYS`, 100), edge-cached
for 60 s like the provider overrides. **KV bills a bulk read per key read**, so the isolate also
keeps the stored strings for `CONFIG_CACHE_TTL_MS` (30 s) and reads KV at most once per period;
each request still decides the entries afresh, so an `until` takes effect on time. A change can
therefore take up to 90 s to reach every request. The cache has one slot per KV binding object, and
requests that miss it at the same time share one read. Decisions are logged on upgrades only
(applied and expired at info, with `console.log`; mistakes at error), so health probes do not repeat
them. The resolve and the log run inside a try in `index.ts`, so a bug in them cannot fail a
request either: the request then goes ahead with the Worker's own env.

**Every rejection degrades to the Worker variable**, for that one variable: malformed JSON, no
`value`, a value of the wrong type (reported even on an expired entry), a bad `until`, or a KV read
failure. A typo in KV cannot take the service down. After a failed read the isolate keeps the
entries it last read, if any (their `until` is still checked per request), and reads KV again only
after `KV_FAILURE_RETRY_MS` (5 s), so a KV outage does not make every request wait for a failing
read. It keeps them until KV answers again, however long that takes: the overrides are incident
levers (an endpoint turned off, a narrowed allowlist), and an outage must not silently drop them.
The error decision names their age ("keeping the entries read N s ago"). The cost is that an
override deleted during an outage stays in effect until the first good read drops it.

**When an override takes effect** depends on who reads the variable:
- **The Worker** (`ROUTING_MODE`, `CONTAINER_POOL_SIZE`, `USE_DISPATCHER`, `ENABLE_TRANSLATE`) and
  **the Worker-hosted `/translate`** (`OPENAI_TRANSLATION_MODEL`, `XAI_TRANSLATION_*`,
  `TRANSLATION_*`, `DEBUG`): the next request, after the edge cache.
- **The container** (most variables): its **next start**. A container reads its env once, so a
  running one keeps what it started with. With `ROUTING_MODE=session` that is the next conference;
  in the other routing modes, and for a session that reconnects to its container, a running
  container keeps serving with its old values. This includes the endpoint gates other than
  `ENABLE_TRANSLATE`: `ENABLE_TRANSCRIBE`, `ENABLE_AGENT` and `ENABLE_TEXT_TRANSLATION` are enforced
  inside the container, so an override of them is not an immediate kill switch. A container started
  by the SDK's own start-on-fetch path (`TranscriberContainer.envVars`, a safety net) gets the plain
  Worker env.
- **`SLEEP_AFTER`** is read by the container Durable Object, whose own env never sees KV. The
  Worker passes the effective value in the start call's env, and
  `TranscriberContainer.startAndWaitForPorts` adopts it; the Worker calls that on every request it
  routes to that object, so a running container picks up a change at its next activity-timer
  renewal. A start env with no
  `SLEEP_AFTER` restores the object's own value, so an override does not outlive its KV entry.
- **The autoscale coordinator** (`MAX_CONNECTIONS_PER_CONTAINER`, `MIN_CONTAINERS`,
  `SCALE_DOWN_IDLE_TIME`) resolves the same KV entries itself at the start of each request. An
  override of `MIN_CONTAINERS` affects only scale-down: the coordinator creates its initial
  containers in its constructor, from its own env, which never sees KV.
- Changing `ROUTING_MODE` or `CONTAINER_POOL_SIZE` moves new sessions to other containers; a session
  that reconnects after the change may land on a container that does not hold its detached state.

**Visibility.** The container is started with `CONFIG_OVERRIDES`, a JSON record of the overrides
it got; it logs it at start (`Config overrides from KV at start`) and reports it as
`configOverrides` in its `info` message (`src/serverInfo.ts`). Those are what that container runs
with. The Worker reports the overrides in effect for the current request as
`worker.configOverrides`: on the dispatcher path's `worker` block and in the Worker-hosted
`/translate` info. The two differ when an entry changed after the container started.

**Write access to `CONFIG_KV` is the same trust as editing the Worker variables.** An override can
move xAI traffic to another `x.ai` host (`XAI_STT_URL`, `XAI_STT_ENDPOINTS`, `XAI_TRANSLATION_URL`), enable `/agent`,
narrow the agent host allowlist, and turn off an endpoint. Give write access to the
namespace only to the people who may deploy the Worker.

**What is not overridable, and why** (each is a `vars.ts` entry with no `kv`):
- Secrets (`*_API_KEY`, `*_CREDENTIALS_JSON`, `AGENT_SHARED_SECRET`, `AGENT_PROVISIONING_TOKEN`,
  `OTLP_HEADERS`): KV is not a secret store, and a container validates provider keys against the env
  it started with.
- Provider selection (`PROVIDERS_PRIORITY`, `TRANSLATION_PROVIDER`,
  `TEXT_TRANSLATION_PROVIDERS_PRIORITY`): the provider overrides do it with a credential check and
  per-connection pinning; two mechanisms would conflict.
- Endpoints other than the xAI URLs (`TEXT_TRANSLATION_*_URL`, `AGENT_PROVISIONING_*`,
  `TRANSLATION_USAGE_URL`, `OTLP_ENDPOINT`): they carry credentials or customer data. The xAI
  URLs (`XAI_STT_URL`, `XAI_TRANSLATION_URL` and each URL in `XAI_STT_ENDPOINTS`) carry them too, which is why their override may name only an `x.ai` host: it can move xAI
  traffic to another xAI endpoint (a region, a new path) but cannot send it anywhere else.
- The security posture of `openai_custom` and `/agent` (`ENABLE_OPENAI_CUSTOM_PROVIDER`,
  `OPENAI_CUSTOM_REQUIRE_WSS`, `AGENT_REQUIRE_WSS`, `AGENT_ALLOW_PRIVATE_ENDPOINTS`,
  `AGENT_ALLOW_UNAUTHENTICATED`): loosening it must be a reviewed release. `AGENT_ALLOWED_HOSTS` is
  overridable, as an incident lever to tighten the allowlist.
- The debug dumps (`DUMP_WEBSOCKET_MESSAGES`, `DUMP_TRANSCRIPTS`, `DUMP_BASE_PATH`): they record
  every conference's audio and transcripts. `DEEPGRAM_MIP_OPT_OUT` is overridable, but only to
  `true` and never to `null`: an override may opt out of Deepgram's model improvement programme,
  not back in.
- `DEEPGRAM_TAGS` (the container refuses to start on a bad tag), `ENABLE_TEXT_TRANSLATION_STUB`,
  `OTLP_ENV`, `OTLP_RESOURCE_ATTRIBUTES`, `OTLP_STALE_MARKER_SENDS`, `SOURCE_IMAGE_TAG` (set by the
  translate deploy to the codec's image tag). `PORT`/`HOST` are not variables: the container must listen
  where `TranscriberContainer.defaultPort` expects it.

**Adding a Worker variable**: add one entry to `WORKER_VARS` in `worker/vars.ts` — `container:
'if-set'` (forwarded when set) or `{ default }` (always forwarded), and a `kv` type if it may be
overridden. Do not add it to `env.d.ts` or to `buildContainerEnvVars`; both follow the table.
