# WebSocket protocol

_Split out of `CLAUDE.md`; see the task table there for which of these documents to read. Keep this file current in the same commit as the code it describes._

## Client → Server

**Audio packet:**
```json
{
  "event": "media",
  "media": {
    "tag": "participant-id",
    "chunk": 0,
    "timestamp": 1768341932,
    "payload": "base64-encoded-opus"
  }
}
```

**Ping:**
```json
{"event": "ping", "id": 123}
```
The bridge sends it on a timer. See "Ping and reconnect" below.

**Sources (text-translation target languages):**
```json
{"event": "sources", "exports": [], "requests": ["fr", "de"]}
```
Sent by the bridge on connect and again whenever the set changes. On `/transcribe` the `requests`
entries are bare language codes: the conference's aggregated text-translation target languages,
which jicofo puts on the colibri2 `<connect type='transcriber'>`'s `<requests>` list. The list is the
authoritative full set, so `"requests": []` stops all translation. (On `/translate` the same field
carries `<source>.<language>` synthetic source names instead.)

## Server → Client (when sendBack=true)

**Transcription result:**
```json
{
  "event": "transcription-result",
  "type": "transcription-result",
  "is_interim": false,
  "transcript": [{"text": "hello", "confidence": 0.98}],
  "participant": {"id": "participant-id"},
  "timestamp": 1768341932000,
  "language": "en"
}
```

**Text translation result** (one per requested target language, for each final; `sendBack=true`):
```json
{
  "event": "transcription-result",
  "type": "translation-result",
  "message_id": "<the message_id of the transcription this was translated from>",
  "language": "fr",
  "text": "bonjour",
  "participant": {"id": "participant-id", "tag": "participant-id-a0"},
  "timestamp": 1768341932000
}
```
The inner `type` is `translation-result` — jigasi's long-standing text-translation type, which
jitsi-meet already renders in the CC panel and as on-stage subtitles. The outer `event` stays
`transcription-result`, so no JVB or client protocol change is needed (see "How the bridge forwards
server messages" below). Two shape details are load-bearing:
- `text` is a **plain string**, not the `transcript: [{text}]` array used by `transcription-result` —
  that is what the client reads for this type.
- `message_id` is the **transcription's** id, so the CC panel pairs the two and shows the translation
  in place of the original.

Do not confuse this with `/translate`'s `realtime-translation-result`, which is deliberately a type
the CC panel ignores.

**Pong:**
```json
{"event": "pong", "id": 123}
```

**Info (sent once per connection, independent of `sendBack`):**
```json
{
  "event": "info",
  "application": "opus-transcriber-proxy",
  "gitHash": "c23ab2a",
  "sourceImageTag": "abc1234",
  "runtime": "cloudflare-container",
  "provider": "openai",
  "providersAvailable": ["openai", "deepgram"],
  "config": {"providersPriority": ["openai"], "forceCommitTimeout": 2, "sessionResumeEnabled": true, "useDispatcher": false},
  "sessionId": "...",
  "instanceId": "...",
  "location": {"city": "Vienna", "country": "AT"},
  "worker": {"present": true, "versionId": "...", "routingMode": "session", "colo": "VIE"}
}
```
An informational/observability message describing the running build and effective session config. The block above is a composite showing every field that can appear; several are conditional and never all co-occur — e.g. the `worker` block is added only on the Worker path, and `sourceImageTag` is emitted by any runtime that has `SOURCE_IMAGE_TAG` in its environment, which in practice is only the translate-Worker deploy (the container shown by the `cloudflare-container` runtime here omits it, since code and codec are co-versioned in one image). Built by `src/serverInfo.ts` (`buildServerInfo`) and sent from `TranscriberProxy.sendServerInfo()` at the end of `setupWebSocketListeners()` (so on both initial connect and reattach). `gitHash` comes from `src/buildInfo.ts` — the `__GIT_HASH__` constant baked in at bundle time by `build.mjs` (esbuild `define`), falling back to the `GIT_HASH` env var then `'dev'` under tsx. `sourceImageTag` (emitted by any runtime with `SOURCE_IMAGE_TAG` set — in practice the translate Worker, whose WASM Opus codec is sourced from a Docker image tag chosen independently of the worker-code ref at deploy) reports that codec image tag, so a code/WASM version mismatch is visible against `gitHash`. The CF Worker augments the message **in-place** with a `worker` block (deployed worker version via the `version_metadata`/`CF_VERSION_METADATA` binding, edge `colo`/`country`/`city` from `request.cf`, `routingMode`, and `providerOverride` / `textTranslationProviderOverride` when a KV provider override changed this connection's transcription or text-translation provider — see **Provider overrides** in `cloudflare.md`) before forwarding it to the client. The client (JVB) may send its own `info` message (application/version/region); the proxy just logs it. An old client that doesn't know the `info` event type drops it harmlessly (its polymorphic parse fails and is caught).

Two optional fields report the KV config overrides (see **Config overrides** in `cloudflare.md`): `configOverrides` (top level, from the container) is the record of the overrides that container was started with, and `worker.configOverrides` is the set in effect for the current request. Each is a map of variable name to value, present only when non-empty.

The **Worker-hosted `/translate`** builds its own `info` in `worker/translationRuntime.ts` (`runtime: "cloudflare-worker"`, `gitHash`, the connection's speech-to-speech `provider`, and a `worker` block with version/colo and, when the KV `translate` override chose this connection's provider, `providerOverride` — see **Provider overrides** in `cloudflare.md`). It **intentionally omits** the Node message's `providersAvailable`, `config.*` (providersPriority, forceCommitTimeout, sessionResumeEnabled, useDispatcher) and `instanceId` fields — those describe transcription/container concepts that don't exist on this path. It **does** include `sourceImageTag` when `SOURCE_IMAGE_TAG` is set (the translate-Worker deploy sets it to the codec's source image tag; see above). The message is informational only; the peer logs whatever it receives.

## How the bridge forwards server messages

This section describes the JVB `Exporter` (`org.jitsi.videobridge.export`) and jicoco-mediajson as read from their sources. The bridge pins a jicoco version, so check `MediaJson.kt` there before you rely on the details below.

The JVB parses each message from the proxy with jicoco-mediajson's `Event.parse`. `Event.parse` selects the class by the top-level `event` field. The fixed set is the `@JsonSubTypes` list in `MediaJson.kt`: `media`, `ping`, `pong`, `start`, `stop`, `transcription-result` and `info`. A message with any other `event` fails to parse: the bridge logs a warning, counts a parse failure and drops it, so it never reaches a client. To add a new kind of transcript message, keep `event: "transcription-result"` and add a new inner `type`, as `translation-result` and `realtime-translation-result` do. A new `event` value needs a new subtype in jicoco-mediajson and a new branch in the bridge's `Exporter`, so avoid it.

The bridge sends a `transcription-result` to the clients unchanged, inside an endpoint message from `transcriber` that it broadcasts to every endpoint (`to` is empty):
```json
{"colibriClass": "EndpointMessage", "from": "transcriber", "to": "", "msgPayload": {"event": "transcription-result", "type": "...", ...}}
```
`TranscriptionResultEvent` keeps every field that it does not model, so `type`, `language`, `message_id` and any new field pass through verbatim. jitsi-meet dispatches on `msgPayload.type`, not on `event`.

Audio from `/translate` and `/agent` (`event: "media"`) is not an endpoint message. The bridge looks the `tag` up among the conference's synthetic audio sources (`findSyntheticAudioSource`), builds an Opus RTP packet on that source's SSRC and injects it. So the tag must be the synthetic source name from `sources.requests` verbatim (for example `523834112-a0.en`; see `buildTranslationMediaMessage` in `src/translate/messages.ts`). The bridge drops media for a tag that it does not know. It also drops media when the conference has no negotiated Opus payload type. The talk-boundary `start` and `stop` events use the same tag lookup, and the bridge drops them for an unknown tag.

### Ping and reconnect

The bridge sends `ping` only when its colibri2 connect enables it: every 10 s, with a 3 s pong timeout, unless the connect sets other values. When no matching `pong` arrives in time, or the socket fails or closes, the bridge reconnects. On each new socket it sends `info` again. It sends `sources` again only when its exports or requests are not empty: the bridge does not re-send an empty set.

The proxy never starts a reconnect. The bridge re-opens the socket, and session resume (see `transcription.md`) restores the state of the session. The reconnect stops for good in these cases:
- The peer closes with a terminal close code (4001 or 4002; `agent.md` describes when `/agent` sends 4002).
- The attempt cap is reached. `videobridge.exporter.max-reconnect-attempts` has no value by default. `videobridge.exporter.agent-max-reconnect-attempts` is 10 for agent connects. Both count consecutive failed attempts.
- The connect expires, or the bridge shuts it down.
