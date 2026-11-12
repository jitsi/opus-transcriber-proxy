# Voice agents (/agent)

_Split out of `CLAUDE.md`; see the task table there for which of these documents to read. Keep this file current in the same commit as the code it describes._

The wire contract is in `AGENT_PROTOCOL.md`.

The `/agent` endpoint (Node-only, `ENABLE_AGENT=true` to enable) relays a conference's audio to a
customer's voice-agent WebSocket server and returns the agent's audio to the bridge:

```
Bridge WebSocket (/agent)
    ↓
AgentProxy (agentproxy.ts) - one per connection
    ├─ Dials OUT to the customer endpoint named by the dial config it fetches by conference + agentId
    │  from the provisioning API (agent/ProvisioningClient.ts; ?endpoint= in dev). wss:// enforced
    │  unless AGENT_REQUIRE_WSS=false; endpoint.authorization sent as the Authorization header.
    ├─ Per participant source: OpusDecoder → PCM16 mono 24 kHz → mediajson `start`/`media`
    │  to the customer (start carries mediaFormat + customParameters from the query params)
    └─ Return path: customer `media` (base64 PCM16 24 kHz) → OpusEncoder (DTX) →
       MediaPacer (src/MediaPacer.ts) → RtpTimestamper → tagged `media` + talk boundaries
       to the bridge (the tag is the agent's synthetic source from `sources.requests`)
```

The upgrade is gated by `AGENT_SHARED_SECRET` (the bridge sends it as `X-Agent-Token`); without it `/agent` refuses every
upgrade with 503 unless `AGENT_ALLOW_UNAUTHENTICATED=true` (dev only), and either way this is logged once at startup, not per
upgrade. The dial config is resolved by `agent/dial.ts` into a `DialResolution`: a transient failure (the provisioning API
unreachable, 5xx, or answering without JSON or `endpoint.url`, all the API's problem rather than the agent's) refuses the upgrade
with HTTP 400, which the bridge retries up to its agent reconnect cap; a permanent one (the agent gone, a conference haproxy routing cannot place, an agent config the relay
cannot act on: a non-wss URL, an unknown encoding or fan-in, or the SSRF guard) accepts the upgrade,
reports `failed` once (not for a gone or unroutable agent) and closes with 4002, so the bridge stops redialing instead of retrying for
minutes with nothing reported. The SSRF guard classifies addresses with `ipaddr.js` (private, loopback, link-local, CGNAT,
multicast, reserved, and the NAT64/6to4/Teredo embeddings all count as non-public) and the outbound socket uses a
`request-filtering-agent`, which checks the address actually connected to, closing the DNS-rebinding gap of the pre-dial
lookup; `AGENT_ALLOW_PRIVATE_ENDPOINTS` relaxes both. Logs name the customer endpoint by host only, and the debug header dumps mask credential headers, as does the session-parameters line (`redactCredentials`). Lifecycle reports for one session are chained so they post in order, a
session reports a terminal state (`failed` or `ended`) once, and `AgentProxy` ignores customer messages once closed.
Status reports retry five times with doubling backoff, with a hard deadline and a 64 KiB body cap per request, and count a
give-up in `otp_agent_status_reports_given_up_total`; permanent dial failures count in `otp_agent_dial_failures_total`.

A socket close the proxy did not start is one log line with the close code, the reason (the peer's string, quoted so it
cannot split the line) and `wasClean`: `agent: endpoint WebSocket closed: ...` at warn, because the bridge leg then closes
with no reason and the bridge redials, so nothing else records why; `agent: bridge WebSocket closed: ...` at info. Neither
line is logged for a close the proxy starts: its cause (`end`, a failed dial, a contract violation, an `error` on the endpoint
socket) is logged where it is decided.

An agent invited with `mediaFormat.encoding: "audio/opus"` (dial config `mediaFormat`, `agent/mediaFormat.ts`)
skips both codecs: participant packets go to the customer as exported (the bridge's `chunk`/`timestamp` kept), and the
customer's packets, which must be one 20 ms Opus packet of ≤ 1275 bytes per `media` (TOC-checked), go straight to the
pacer. Only the agent's single stream is decoded: to reject packets that don't decode, to drop silence (≤ 2-byte DTX
packets and anything quieter than level 95) and for the RFC 6464 level the bridge's speaker detection reads. A
contract violation closes the customer socket with 1008 and fails the session (`failed`, bridge close 4002); an
encoding in the dial config the relay doesn't know fails the dial (`failed` reported) rather than falling back to PCM.
The pacer holds at most 60 s of agent audio, and customer messages are capped at 1 MiB (`maxPayload`). Close reasons are
cut by UTF-8 bytes (`agent/closeReason.ts`): `ws` throws above 123 bytes, which would have lost the terminal code on a
non-ASCII error text. A participant decoder that fails to initialise sends the customer a `stop` for that tag, counts
`agent_decoder_failure` and drops the tag's media with one warning. Messages queued while the customer socket opens keep
every control message (`start`, `speakers`, ...) and evict the oldest media when the queue is full, and a new `speakers`
replaces a queued one, since only the latest matters and it fires on every speaker change; media dropped there or
by the per-source and return-path buffers counts `agent_media_dropped` and warns once.

The bridge sends agent connects a `speakers` event (the exported sources in its recent-speaker order, the dominant
speaker first, plus `silence`) whenever the order changes and once on connect; the relay passes it on to the customer
as a hint in every fan-in. An agent invited with `fanIn: "dominant"` (dial config `fanIn`, `agent/fanIn.ts`; default
`per-source`) hears only the first listed source: `AgentProxy.fansIn` drops the other sources' media (PCM and Opus
alike), the frames keep their own tags, and the selection is the bridge's, so the relay measures no levels itself. An
empty order (nobody has spoken) forwards nothing; no order at all (an older bridge) forwards every source with one
warning. `info.fanIn` announces the policy and the protocol version is `1.1` (additive on `1.0`).

Agent-specific control events on the customer leg: `clear` (barge-in — drops the pacer's queued,
not-yet-released audio; only the ≤ AGENT_PACE_LEAD_MS already released can still play out) and
`mark` (playback checkpoint, echoed back when the pacer releases past it — approximates "played",
the proxy has no client playout feedback). A customer-leg failure closes the bridge socket so the
bridge's Exporter reconnect re-dials the endpoint (session-level retry). The pacer is pure and
clock/timer-injectable (`test/unit/MediaPacer.test.ts`); it is shared with `TranslatorConnection`, which paces translated
audio through it for a different reason (the client's jitter buffer, see **TranslatorConnection** in `translate.md`).

The customer-leg wire contract is **frozen at v1.0** (`jitsi-agent-media`): the gateway advertises
`protocol` + `version` in the `info` message, additive changes stay within the major and both sides
ignore unknown events/fields, and the agent may send `end` to request teardown. Full schema and the
locked design decisions (multi-speaker fan-in, teardown, RTVI) are in `AGENT_PROTOCOL.md`.

## Environment variables

- `ENABLE_AGENT` - Enable the /agent voice-agent endpoint (default: **false** — it dials out to arbitrary customer WebSocket endpoints, so enabling is an explicit deployment decision). The CF Worker forwards it and the `AGENT_*` vars below to the container when set
- `AGENT_REQUIRE_WSS` - Require wss:// for the customer agent endpoint (default: true; false allows ws:// for dev)
- `AGENT_PACE_LEAD_MS` - How much agent audio (ms) may be released ahead of real time by the pacer (default: 200); bounds how much audio can still play out after a barge-in `clear`. Read by the same `parsePaceLeadMs` as the translation lead, so a negative or non-integer value is reported and the default used (the pacer refuses a negative lead and `AgentProxy` builds one per session), 1 to 19 is raised to one frame, and over 2 s is accepted with a warning; unlike the translation lead, 0 does not turn the agent pacer off, the pacer raises it to one frame. The agent pacer's timers are unref'd since it became the shared `MediaPacer`: queued agent audio no longer keeps the process alive on its own, the open sockets do
- `AGENT_SHARED_SECRET` - Shared secret gating the /agent WS upgrade; the caller (the bridge, via jicofo's `agent.http-headers`) must send a matching `X-Agent-Token`. Unset, `/agent` refuses every upgrade (503) unless `AGENT_ALLOW_UNAUTHENTICATED=true`
- `AGENT_ALLOW_UNAUTHENTICATED` - Dev opt-in to serve /agent with no shared secret (default: false). An open /agent lets anyone reaching the proxy dial any agent with the customer's credentials and drive its lifecycle reports; never enable it outside a bridge-only network
- `AGENT_ALLOWED_HOSTS` - Comma-separated allowlist of customer endpoint hosts (exact or `.suffix`). Empty = allow any public host (private ranges blocked)
- `AGENT_ALLOW_PRIVATE_ENDPOINTS` - Dev/same-host opt-in that skips the private/internal-address SSRF denylist so the agent endpoint may be on localhost or an internal IP (default: false). Removes SSRF protection — never enable where untrusted callers can reach `/agent`
- `AGENT_ALLOW_ENDPOINT_PARAM` - Honor the dev-only `?endpoint=` query param instead of fetching the dial config from the provisioning API (default: false)
- `AGENT_PROVISIONING_ROUTING` - `direct` (default: `<url>/<route>`) or `haproxy`: the API sits behind a sharded deployment's HAProxy, reached through its signal-api host; the client puts the tenant before the base path and the room in `?room=`, spelled as jitsi-meet spells its own (decoded, lower-cased, form-encoded: HAProxy compares the bytes), which is what HAProxy picks the shard from; a breakout room's JID cannot be placed this way (warned, routed by its own id). A `404` saying the room is unknown then means the call reached a shard without it: logged with the path, a dial counts as the API being unavailable (the bridge retries) and a status report gives up at once (counted as given up; a meeting that has just ended on the right shard answers the same, so the count is approximate); a conference that cannot be routed at all fails the dial permanently, unreported
- `AGENT_PROVISIONING_URL` / `AGENT_PROVISIONING_TOKEN` / `AGENT_PROVISIONING_HOST` - Base URL of the provisioning API's internal routes (prosody's `/voice-agent`, or the JaaS gateway), its bearer, and an optional Host header. The gateway fetches each agent's dial config from `GET dial` by `conference` + `agentId` and reports the media leg to `POST status` (`active` on socket open, `failed` on dial failure, `ended` on the agent's `end`). Unset = only the dev `?endpoint=` path can dial, and agents never advance past jicofo's `connecting`. A value that is not an http(s) URL is dropped with a warning (said again once the server listens) while `ENABLE_AGENT` is on, rather than failing the start
