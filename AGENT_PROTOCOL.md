# Jitsi Agent Media Protocol — v1.1 (frozen at v1.0, additive since)

Status: **frozen at v1.0; v1.1 adds only optional fields and events**. The `/agent` customer leg
speaks this contract. It is the surface an upstream Pipecat `JitsiFrameSerializer` (and any other
third-party voice-agent framework) targets, so it must not change in a breaking way once published —
see **Versioning** below.

`protocol` identifier: `jitsi-agent-media`. Current `version`: `1.1` (adds `info.fanIn` and the
`speakers` event; a v1.0 consumer ignores both).

## Roles and transport

- The **gateway** is the opus proxy `/agent` endpoint. It dials **out** to the **agent** server
  (the customer's WebSocket), exactly as Twilio Media Streams dials a customer's route.
- Transport is a single **WebSocket**. Every message is one **JSON text frame** (`event`-tagged).
- Audio is **L16 PCM, signed 16-bit little-endian, mono**, base64-encoded in `payload`. The sample
  rate is announced per stream in `mediaFormat.sampleRate` (default **24000**); consumers read it
  rather than assuming it. `encoding` is `audio/l16`.
- An agent invited with `mediaFormat.encoding: "audio/opus"` gets **Opus** instead, in both
  directions (see **Opus** below). The encoding in effect is the one `info.mediaFormat` announces;
  an agent reads it rather than assuming the one it asked for.
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
  "fanIn": "per-source",
  "sessionId": "5f1c7e0a-…", "agentId": "agent-support",
  "conference": "acme/room1", "meetingId": "9b3d2c41-…",
  "customParameters": { "...": "..." },
  "sequenceNumber": 0 }
```
| field | type | req | meaning |
|---|---|---|---|
| `protocol` | string | yes | Always `jitsi-agent-media`. |
| `version` | string | yes | `MAJOR.MINOR` of this contract. |
| `application` | string | yes | Gateway build identifier (informational). |
| `mediaFormat` | object | yes | Default audio format for the connection (per-stream `start` may restate it). |
| `fanIn` | string | no (v1.1) | Which participants' audio arrives: `per-source` (every exported source, the default) or `dominant` (only the dominant speaker's; see **Multi-speaker**). Absent from a v1.0 gateway, meaning `per-source`. |
| `sessionId` | string | yes | Unique per dial, so a redial after a bridge reconnect is distinguishable from a new session. |
| `agentId` | string | no | The agent being dialed, as provisioned. Lets one server host many bots. Absent only on the dev `?endpoint=` path. |
| `conference` | string | no | The room the agent was invited to, spelled as in the meeting URL (lower-case, percent-encoded): `<room>`, or `<tenant>/<room>` on a multi-tenant deployment. Never an internal XMPP address. |
| `meetingId` | string | no | The meeting id of that conference. |
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
| `media.payload` | string | yes | base64 PCM16 at the stream's `sampleRate`, or one Opus packet with `audio/opus`. |

### Multi-speaker

The gateway never mixes. Each participant source the agent may hear arrives as its own stream: a
`start` with a `tag`, then `media` frames carrying that `tag`. Frames of different tags are
interleaved on the one socket in arrival order, 20 ms of audio each, so several people talking at
once produce several concurrent streams.

**An agent must demultiplex by `tag`.** It can feed each tag to its own recognizer, or mix or select
the tags itself before a single-stream model. Treating every `media` frame as one stream garbles
overlapping speech and plays it at a multiple of real time.

Which tags arrive is decided by the meeting, not the agent: only participants who consented (when the
deployment asks for consent), and, when the bridge routes only the loudest speakers, only the loudest
few at any moment. A tag can go silent (mute, or no longer among the loudest) and resume without a new
`start`. A `tag` is a source name (`<endpointId>-a0`); it does not identify the person, and v1 carries
no display names.

**Fan-in** (v1.1). An agent invited with `fanIn: "dominant"` hears one person at a time: the gateway
forwards only the audio of the first `tag` in the bridge's speaker order (below), and switches tags as
the order changes. The frames still carry each speaker's own `tag`, so a serializer that demultiplexes
by `tag` needs no change; it simply never sees two tags active at once. Selection is the bridge's
dominant-speaker ranking, the one the meeting UI highlights, so the first few hundred milliseconds of
a new speaker are not forwarded until the bridge promotes them. The default, `per-source`, forwards
every exported tag.

### `speakers` (v1.1, speaker order)
```json
{ "event": "speakers", "speakers": ["3f2a9c-a0", "b71e04-a0"], "silence": false, "sequenceNumber": 57 }
```
The exported sources in the bridge's recent-speaker order, the dominant speaker first; sent whenever
the order changes and once after the connection opens, in every fan-in. Empty until someone has
spoken. `silence` is true while nobody is speaking (the order then still holds who spoke last). A hint
for turn taking and speaker labels; with `fanIn: "dominant"` it also names the one `tag` whose audio
currently arrives. Older gateways never send it.

### Opus

With `"mediaFormat": { "encoding": "audio/opus", "sampleRate": 48000, "channels": 1 }` the gateway
transcodes nothing:

- **To the agent**, each `media.payload` is one Opus packet exactly as the participant's browser
  sent it (RFC 6716; usually 20 ms, mono-coded, and any Opus decoder opened at the channel count it
  wants accepts it). `chunk` is the bridge's per-source packet index, so a gap in it is a lost packet
  the agent's decoder can conceal; `timestamp` places the packet on the meeting's 48 kHz timeline.
- **From the agent**, each `media.payload` must be **one 20 ms Opus packet** at 48 kHz, at most 1275
  bytes, one packet per message. The gateway paces and returns it unchanged.
- **Silence.** Packets of at most 2 bytes (DTX) and packets that decode quieter than −95 dBov
  (encoded digital silence, comfort-noise refreshes) are dropped, which ends the agent's talk as on
  the PCM path. Silence is judged by level alone, so agent output with an audible noise floor keeps
  the talk open; send digital silence between utterances.
- **Contract violations end the session.** A packet of another duration, an oversized packet, or one
  that does not decode closes the agent's socket with 1008 and the reason, and the agent is reported
  `failed`; a redial would only repeat it.

The gateway decodes the agent's stream only to validate it and measure its audio level, so clients
show the agent speaking exactly as on the PCM path. PCM16 at 24 kHz remains the default.

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
| `media.payload` | string | yes | base64 PCM16 at the announced `sampleRate`, any chunking; with `audio/opus`, exactly one 20 ms Opus packet. |
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
socket normally (1000) and ends the bridge leg with application close code 4001 (`agent ended`),
which the bridge treats as terminal: no redial.

### Bridge-leg close codes (gateway internal)

| Code | Meaning | Bridge behaviour |
| --- | --- | --- |
| 4001 | `agent ended`: the agent sent `end` | terminal, no redial |
| 4002 | `endpoint unreachable` / `endpoint refused: HTTP <status>`: the dial to the agent endpoint failed; or the agent broke the media contract (see **Opus**); or the dial config could not be acted on at all (the agent no longer exists, an unsupported format or fan-in, a non-`wss` or private endpoint), in which case the gateway accepts the bridge's upgrade only to close it with this code | terminal, no redial |
| other | transport loss mid-session | the bridge redials; the agent sees a fresh `info`/`start` |

A refused upgrade (HTTP 400) is reserved for transient failures on the gateway's side (its provisioning API
unavailable), which the bridge retries. Close reasons are cut to 123 bytes of UTF-8.

The gateway also reports these transitions to the provisioning API (see `AGENT_REST_API.md`): `active` when
the agent socket opens, `failed` with the reason above when the dial fails or the agent breaks the contract,
`ended` on `end`.

### `ping` / `pong` (keepalive, either direction)
```json
{ "event": "ping", "id": 123 }
{ "event": "pong", "id": 123 }
```
`id` is optional and echoed when present.

## Locked design decisions (forward-compatible)

1. **No mixing on the gateway; the agent demultiplexes.** Inbound audio is *always* per-source,
   keyed by `tag` (see **Multi-speaker**). An agent that wants a single stream mixes or selects in
   its own code or serializer, or asks for the `dominant` fan-in (v1.1), which selects rather than
   mixes and still delivers per-`tag` `media`, one tag at a time. If a gateway-side mixed stream is
   ever offered, it will be a further `fanIn` value whose audio arrives as one more `tag` in the same
   envelope, so a serializer that handles per-`tag` `media` needs no change.

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
- `mediaFormat.encoding` / `sampleRate` — chosen per agent at invite; `audio/opus` (passthrough)
  is the first addition, and further encodings are additive the same way.
- `customParameters` — free-form provisioning passthrough.
- `fanIn` — chosen per agent at invite; `per-source` and `dominant` exist, further policies (e.g. a
  gateway-side mix) are additive the same way.

## Conformance

A serializer is conformant if it round-trips the canonical envelopes above. The reference fixtures
live in `voice-agent-local/pipecat-agent/` (`mock_gateway.py` drives gateway→agent + asserts the
return leg; `try_full.py` exercises a full speech turn). Those double as the upstream serializer's
protocol tests.
