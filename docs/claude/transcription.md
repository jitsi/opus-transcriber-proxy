# Transcription path (/transcribe)

_Split out of `CLAUDE.md`; see the task table there for which of these documents to read. Keep this file current in the same commit as the code it describes._

## Data flow

```
Client WebSocket
    ↓
TranscriberProxy (transcriberproxy.ts)
    ├─ One per WebSocket connection
    ├─ Manages session lifecycle
    └─ Routes to multiple OutgoingConnections
        ↓
OutgoingConnection (OutgoingConnection.ts) - One per participant (audio stream)
    ├─ AudioDecoder (via AudioDecoderFactory)
    │   ├─ OpusAudioDecoder - Decodes Opus frames to PCM (native libopus)
    │   ├─ L16Decoder - Resamples or passes through raw PCM l16
    │   └─ PassThroughDecoder - Forwards raw Opus/Ogg frames unchanged
    └─ TranscriptionBackend - Sends audio to provider
        ↓
    Backend (OpenAIBackend, DeepgramBackend, GeminiBackend)
        ↓
    Provider API (WebSocket or HTTP stream)
```

## Key components

**TranscriberProxy** (`src/transcriberproxy.ts`)
- Manages a single client WebSocket connection
- Creates `OutgoingConnection` instances per participant tag
- Handles ping/pong keepalive
- Optional dispatcher forwarding (sends transcriptions to external service)
- Optional WebSocket message dumping for debugging
- Tracks `failedStartTags`: if a `start` event has an invalid `mediaFormat`, subsequent `media` events for that tag are dropped (not auto-connected with defaults) until a valid `start` event arrives
- **A participant's connection failure is contained to that participant.** `OutgoingConnection.onError` reports that ONE stream has failed terminally and closed itself; the proxy logs it and does **not** re-emit it as a session-level `error`. It used to: the session `error` handler in `server.ts` unregisters the session and closes the **client** WebSocket with 1011, so a single participant's backend failure dropped captions for everyone else in the conference and the Worker relayed `1011 Container connection error` to the JVB. That is what turned the 2026-09-22 xAI 404 outage into a total per-meeting caption outage (JIT-16493). The session `error` event still exists and still closes the socket, but nothing per-participant emits it any more
- **Recovery in place, paced per tag.** A closed connection is removed from `outgoingConnections`, so the tag's next `media` frame simply opens a new one — which is how a participant recovers once the provider does. Because frames arrive every ~20ms, `connectionRetries` holds a per-tag exponential backoff (`CONNECTION_RETRY_BASE_MS` 1000ms, doubling, capped at `CONNECTION_RETRY_MAX_MS` 15s) so a fast-rejecting provider isn't hammered; media arriving inside the window is dropped. The backoff is cleared by `OutgoingConnection.onBackendConnected` (fired on a first connect *and* on a reconnect in place) and by an explicit `start` event, which is the client asking for the stream now. The backoff is armed only by `onError`, i.e. a terminal failure. A teardown driven purely by the provider closing its socket (`backend.onClosed` → `doClose(true)`, no `onError`) is **not** paced: it is also the muted-participant path (a provider's idle close), where a delay would clip the first second of speech after unmute. (xAI's give-up after `MAX_CONSECUTIVE_RECOVERIES` does go through `onError` and arms the 1s base backoff, which only costs anything if the participant unmutes within that second.) The cost is that a provider which accepts the handshake and then closes every connection is re-dialled at one connect per round trip per participant; the handshake-level retry and the xAI cooldown do not cover that case
- `mediaFormats` remembers each tag's last negotiated `AudioFormat`, so a connection recreated after a failure reuses the format its `start` event established instead of falling back to the URL-parameter default — the client does not replay `start` for a mid-session reopen. Only a tag never seen in a `start` event takes the default (and logs the "no prior start event" warning)
- **Text translation**: handles the `sources` control event, whose `requests` list carries the conference's aggregated target languages as bare language codes (jicofo puts them on the colibri2 `<connect type='transcriber'>`'s `<requests>`; the bridge forwards them verbatim). `requests` is the authoritative full set, so it replaces the current one — an empty list stops all translation. Each **final** transcription is then translated into every requested language and emitted as a separate `translation` event (see `src/textTranslate/` and `text-translation.md`). Gated on `ENABLE_TEXT_TRANSLATION`; requested languages are ignored (and logged) while it is off. Note the same `requests` field means `<source>.<language>` synthetic source names on a `translator` connect — the two are told apart by connect type, i.e. by which endpoint the socket is on

**OutgoingConnection** (`src/OutgoingConnection.ts`)
- Manages one participant's audio stream
- Buffers audio frames until decoder is ready
- Creates an `AudioDecoder` via `AudioDecoderFactory` based on input/output format negotiation
- Sends decoded (or raw) audio to transcription backend
- Implements idle commit timeout (forces transcription when audio stops)
- Maintains transcript history for context injection
- On every `reinitializeDecoder` call, compares the new desired format against `activeDesiredFormat`; if they differ, closes the old backend and opens a fresh connection (via `reconnectBackend`) before creating the decoder
- The backend `onError` handler distinguishes **recoverable** errors (third callback arg `recoverable === true`) from fatal ones. Recoverable errors (e.g. xAI `"ASR stream timed out"` on silence) trigger `recoverBackend()`, which reopens the backend in place via `reconnectBackend` (preserving the decoder, transcript history and negotiated format) instead of tearing down the connection. Fatal errors call `doClose(true)` as before. `recoverBackend` bumps `reinitGeneration` so it shares the same staleness guard as format-change reconnects (JIT-15901). The reconnect loop is bounded by `MAX_CONSECUTIVE_RECOVERIES` (3): a muted participant sends no audio so the fresh stream just times out again, so after that many recoveries with no audio in between it gives up and tears down (the next media event on unmute recreates the connection cleanly). `consecutiveRecoveries` resets on every audio send, so an active participant reconnects without limit
- `doClose()` is idempotent (guarded by `isClosed`); it increments `reinitGeneration` to make in-flight async operations detect they are stale, and detaches backend callbacks before calling `close()` to prevent stale events from firing after teardown
- `initializeBackend` keeps its own reference to the backend it created and, after each `await` (decoder init, `connect()`) and at the top of its `catch`, checks that it is still `this.backend`. A format change that lands during either wait runs `reconnectBackend`, which closes that backend and connects a replacement itself; without the check the first path would connect the replacement a second time (two sockets, a double-counted active connection) or, when the closed backend's pending `connect()` throws (xAI's "connect abandoned"), tear the participant down for a backend that was already gone. Reachable for xAI since `XAI_ENCODING=opus` made its desired format depend on the input (ogg vs opus)
- `onError` is the **terminal, per-participant** failure channel: it is always preceded by `doClose(true)`, so by the time it fires the connection has already closed and deregistered itself. It means "this participant's stream is gone", never "this session is broken" — see the containment note under `TranscriberProxy`. `onBackendConnected` is its counterpart, fired whenever a backend connects (initial or reconnect in place), and is what lets the owner clear a retry backoff

**TranscriptionBackend** (`src/backends/TranscriptionBackend.ts`)
- Abstract interface for transcription providers
- Implementations: `OpenAIBackend`, `DeepgramBackend`, `GeminiBackend`, `MistralBackend`, `DummyBackend`
- Each backend handles provider-specific WebSocket protocol
- `getDesiredAudioFormat(inputFormat)` returns the `AudioFormat` the backend wants to receive (replaces the old `wantsRawOpus()`)

**BackendFactory** (`src/backends/BackendFactory.ts`)
- Creates backend instances based on provider name
- Returns backend-specific configuration

**SessionManager** (`src/SessionManager.ts`)
- Singleton that tracks active and detached sessions
- Enables session resumption: client can disconnect/reconnect within grace period
- Detached sessions maintain their `OutgoingConnection` instances
- Metrics tracking for active sessions

## Configuration system (`src/config.ts`)

All configuration is loaded from environment variables or `.env` file using dotenv.

Provider priority: `PROVIDERS_PRIORITY=openai,deepgram,gemini`
- First available provider (with API key) becomes default
- Can be overridden per-connection via `?provider=deepgram`

See README.md for complete configuration reference.

## Session resumption

When `SESSION_RESUME_ENABLED=true` (default):
1. Client disconnects → `TranscriberProxy` detaches from WebSocket
2. Session stays alive for `SESSION_RESUME_GRACE_PERIOD` seconds (default 15)
3. Client reconnects with same `sessionId` → reattaches to existing session
4. Audio streams and transcription continue without interruption

## Force commit timeout

When audio stops flowing, `OutgoingConnection` waits `FORCE_COMMIT_TIMEOUT` seconds (default 2) then calls `backend.forceCommit()` to finalize pending audio and generate transcription. A final from the backend clears the timer (the provider has finalized the audio) unless the backend reports it with `midUtterance = true` — a final that commits only part of an utterance still in progress (xAI's long-turn cap and granular finals), after which the force-commit is still needed.

## Invariants

- When modifying backends, ensure they handle connection lifecycle correctly (pending → connected → failed/closed).
- Session resumption means a `TranscriberProxy` may exist without an active WebSocket connection.
- Each participant creates its own `OutgoingConnection` and backend connection to the provider.
- The `tag` field identifies a participant's media source within a session. Format is a sourceId — `{id}-{mediaType}` (e.g. `abc123-a0`, where the suffix encodes media type: `a`=audio, `v`=video) or just `{id}`. The hex `{id}` prefix is parsed out (via `/^([0-9a-fA-F]+)-/`) as the participant id, while the full tag is retained on `participant.tag`. Tags whose prefix isn't hex fall back to `id === tag === <whole tag>`.
- `openai_custom` is a provider that reuses `OpenAIBackend` but with a per-request WebSocket URL (from the `openaiCustomUrl` URL query parameter) and API key (from the `X-Custom-Openai-Api-Key` HTTP header). It is gated by `ENABLE_OPENAI_CUSTOM_PROVIDER=true` (similar to `ENABLE_DUMMY_PROVIDER`). The URL and key are stored in `TranscriberProxyOptions` (`openaiCustomUrl`, `openaiCustomApiKey`) and passed to `BackendFactory.createBackend` via `OpenAICustomOptions`. `BackendFactory` instantiates `OpenAIBackend(tag, participantInfo, wsUrl, apiKey)` for this provider.
- `doClose()` is idempotent. Do not call it more than once expecting repeated side effects — the `isClosed` guard makes subsequent calls no-ops. Backend callbacks (`onClosed`, `onError`, etc.) are nulled before `close()` is called, so async backend events arriving after teardown are silently dropped.

## Key environment variables

See README.md for the complete list.

- `PROVIDERS_PRIORITY` - Provider priority order (default: openai,deepgram,gemini)
- `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY` - API keys
- `MISTRAL_MODEL` - Mistral Voxtral realtime model (default: `voxtral-mini-transcribe-realtime-3`)
- `ENABLE_OPENAI_CUSTOM_PROVIDER` - Enable the openai_custom provider (default: false)
- `OPENAI_CUSTOM_REQUIRE_WSS` - Require wss:// for openaiCustomUrl (default: true; set false to allow ws://)
- `PORT`, `HOST` - Server listen config
- `FORCE_COMMIT_TIMEOUT` - Seconds before finalizing pending audio (default: 2)
- `SESSION_RESUME_ENABLED` - Enable session resumption (default: true)
- `SESSION_RESUME_GRACE_PERIOD` - Resume grace period in seconds (default: 15)
- `USE_DISPATCHER` - Enable dispatcher forwarding
- `ENABLE_TRANSCRIBE` / `ENABLE_TRANSLATE` - Per-endpoint enablement (default: true each); a disabled endpoint's WS upgrade is rejected with 404
