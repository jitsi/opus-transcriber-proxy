# Jitsi Agent Media Protocol — v1.0 (frozen)

Status: **frozen, v1.0**. The `/agent` customer leg speaks this contract. It is the surface an
upstream Pipecat `JitsiFrameSerializer` (and any other third-party voice-agent framework) targets,
so it must not change in a breaking way once published — see **Versioning** below.

`protocol` identifier: `jitsi-agent-media`. Current `version`: `1.0`.

## Roles and transport

- The **gateway** is the opus proxy `/agent` endpoint. It dials **out** to the **agent** server
  (the customer's WebSocket), exactly as Twilio Media Streams dials a customer's route.
- Transport is a single **WebSocket**. Every message is one **JSON text frame** (`event`-tagged).
- Audio is **L16 PCM, signed 16-bit little-endian, mono**, base64-encoded in `payload`. The sample
  rate is announced per stream in `mediaFormat.sampleRate` (default **24000**); consumers read it
  rather than assuming it. `encoding` is `audio/l16`.
- `sequenceNumber` is a monotonic per-message counter the **gateway** stamps on its outbound
  envelopes. Agent→gateway messages do not need it.

## Versioning and compatibility (the anti-churn contract)

- The gateway advertises `protocol` and `version` in the `info` handshake (first message).
- `version` is `MAJOR.MINOR`. A consumer keys behavior on **MAJOR** only.
- **Additive changes stay within a MAJOR**: new optional fields and new `event` types are minor.
  **Both sides MUST ignore unknown `event` types and unknown object fields.** This rule is what
  lets the protocol evolve without breaking a shipped serializer.
- A **breaking change bumps MAJOR** (e.g. renaming a field, changing `payload` encoding, changing
  the meaning of `tag`). A serializer may then branch on MAJOR or refuse an unknown MAJOR.
- Anything marked *reserved* here is defined but not yet emitted; using it later is additive, not
  breaking.

## Gateway → agent

### `info` (first message)
```json
{ "event": "info", "protocol": "jitsi-agent-media", "version": "1.0",
  "application": "opus-transcriber-proxy",
  "mediaFormat": { "encoding": "audio/l16", "sampleRate": 24000, "channels": 1 },
  "customParameters": { "...": "..." },
  "sequenceNumber": 0 }
```
| field | type | req | meaning |
|---|---|---|---|
| `protocol` | string | yes | Always `jitsi-agent-media`. |
| `version` | string | yes | `MAJOR.MINOR` of this contract. |
| `application` | string | yes | Gateway build identifier (informational). |
| `mediaFormat` | object | yes | Default audio format for the connection (per-stream `start` may restate it). |
| `customParameters` | object | no | Opaque provisioning metadata from the invite (string→string). The gateway's own query parameters are never echoed. |

### `start` (one per participant source, before its first `media`)
```json
{ "event": "start",
  "start": { "tag": "<sourceId>", "mediaFormat": { "encoding": "audio/l16", "sampleRate": 24000, "channels": 1 },
             "customParameters": { "...": "..." } },
  "sequenceNumber": 1 }
```
| field | type | req | meaning |
|---|---|---|---|
| `start.tag` | string | yes | Stream identity for the source (see **Multi-speaker**). |
| `start.mediaFormat` | object | yes | Audio format for this stream; consumers honor its `sampleRate`. |
| `start.customParameters` | object | no | Per-stream provisioning metadata. |

### `media`
```json
{ "event": "media",
  "media": { "tag": "<sourceId>", "chunk": 0, "timestamp": 0, "payload": "<base64 pcm16>" },
  "sequenceNumber": 2 }
```
| field | type | req | meaning |
|---|---|---|---|
| `media.tag` | string | yes | Which source this audio belongs to. |
| `media.chunk` | number | yes | Per-source monotonic frame counter. |
| `media.timestamp` | number | yes | Source RTP timestamp, passed through (for alignment). |
| `media.payload` | string | yes | base64 PCM16 at the stream's `sampleRate`. |

### `mark` (echoed playback checkpoint)
```json
{ "event": "mark", "mark": { "name": "<name>" }, "sequenceNumber": 3 }
```
Sent back to the agent once the gateway pacer has released audio past a `mark` the agent queued.
It approximates "played" — the gateway has no true client-playout feedback.

## Agent → gateway

### `media` (the agent's speech)
```json
{ "event": "media", "media": { "payload": "<base64 pcm16>" } }
```
| field | type | req | meaning |
|---|---|---|---|
| `media.payload` | string | yes | base64 PCM16 at the announced `sampleRate`; any chunking. |
| `media.tag` | string | no | *Reserved* — ignored in v1. The gateway attaches the agent's own synthetic source tag; the agent does not choose it. |

### `clear` (barge-in)
```json
{ "event": "clear" }
```
Drops the gateway pacer's queued, not-yet-released agent audio. Only the ≤ pace-lead already
released can still play out.

### `mark` (playback checkpoint)
```json
{ "event": "mark", "mark": { "name": "<name>" } }
```
Queued in order with `media`; echoed back (gateway→agent `mark`) when the pacer releases past it.

### `end` (agent-initiated teardown)
```json
{ "event": "end" }
```
The agent signals its session is complete. The gateway sends nothing further, closes the agent's
socket normally (1000) and ends the bridge leg with application close code 4001 (`agent ended`), so
the leg can be treated as terminal rather than redialed.

### `ping` / `pong` (keepalive, either direction)
```json
{ "event": "ping", "id": 123 }
{ "event": "pong", "id": 123 }
```
`id` is optional and echoed when present.

## Locked design decisions (forward-compatible)

1. **Multi-speaker fan-in lives off the wire.** Inbound audio is *always* per-source, keyed by
   `tag`. Which tags (and how many) the gateway sends is a **gateway policy chosen at invite time**
   — `per-participant` (each speaker its own `tag`), `mixed` (one pre-mixed `tag`), or
   `active-speaker` (only the dominant `tag`). All three produce the same envelope shape, so a
   serializer that handles per-`tag` `media` uniformly needs no change when the policy changes. A
   mixed or active-speaker stream simply arrives as a single `tag`.

2. **Teardown is the `end` event** (above), reserved/defined now so the contract never has to grow
   a breaking teardown path later.

3. **RTVI does not ride this socket.** Bot events for the human client (transcripts, bot-speaking
   state, function-call UI) travel a **separate** channel (the Jitsi bridge data channel /
   voice-agents feature), never these media envelopes. A serializer sets
   `ignore_rtvi_messages = true`. This keeps the media contract stable regardless of how RTVI
   evolves.

## Reserved extension points

- Unknown `event` types and unknown object fields — MUST be ignored (enables additive growth).
- `media.tag` on the agent→gateway leg — reserved for future multi-agent targeting.
- `mediaFormat.encoding` / `sampleRate` — negotiable per stream via `start`; a new `encoding`
  (e.g. Opus passthrough) is additive.
- `customParameters` — free-form provisioning passthrough.

## Conformance

A serializer is conformant if it round-trips the canonical envelopes above. The reference fixtures
live in `voice-agent-local/pipecat-agent/` (`mock_gateway.py` drives gateway→agent + asserts the
return leg; `try_full.py` exercises a full speech turn). Those double as the upstream serializer's
protocol tests.
