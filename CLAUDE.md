# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a real-time WebSocket transcription proxy that routes audio (Opus or other formats) to multiple speech-to-text backends (OpenAI, Deepgram, Google Gemini, xAI). It supports:
- Multi-participant sessions (one WebSocket handles multiple audio streams)
- Provider fallback with configurable priority
- Two deployment modes: Node.js standalone or Cloudflare Workers with Containers
- Session resumption (detach/reattach within grace period)
- Optional dispatcher forwarding and OTLP telemetry

## Build System

### Prerequisites

**Emscripten** must be installed before building. Install it using the official emsdk:

```bash
# Clone the Emscripten SDK
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk

# Install and activate the latest SDK
./emsdk install latest
./emsdk activate latest

# Activate environment variables (needs to be done in each new terminal)
source ./emsdk_env.sh  # On Windows use: emsdk_env.bat
```

For more details, see the [official Emscripten installation guide](https://emscripten.org/docs/getting_started/downloads.html).

### Initial Setup (First Time Only)
```bash
npm install
npm run configure  # Configures libopus with emconfigure (requires Emscripten)
npm run build:wasm # Compiles Opus decoder to WebAssembly
```

### Regular Build
```bash
npm run build      # Builds WASM + TypeScript + esbuild bundle
```

This runs three steps:
1. `npm run build:wasm` - Compiles C code to WASM using Emscripten (via Makefile)
2. `npm run build:ts` - Compiles TypeScript to dist/
3. `npm run build:bundle` - Bundles with esbuild for production (dist/bundle/server.js)

The WASM build uses a Makefile that:
- Configures libopus with emconfigure
- Compiles libopus.a with emmake
- Links opus_frame_decoder.c with emcc to create opus-decoder.wasm

### Development
```bash
npm run dev        # Builds WASM once, then runs tsx with watch mode
npm run typecheck  # Type check without emitting files
```

### Testing
```bash
npm test                    # Run all tests with vitest
npm run test -- <pattern>   # Run specific test file
npm run test -- --coverage  # Generate coverage report
```

Tests are in `test/` with helpers in `test/helpers/`. The test setup uses vitest with mocking for WebSocket, Opus decoder, and backend connections.

### Docker
```bash
npm run docker:build       # Build + create Docker image
npm run docker:run         # Run container with .env
npm run docker:stop        # Stop running containers
```

### Cloudflare Deployment
```bash
npm run cf:deploy          # Deploy to Cloudflare Workers
npm run cf:tail            # Tail logs
```

The worker code is in `worker/` and uses `@cloudflare/containers` to run the Node.js server in a container.

## Architecture

### Data Flow

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
    │   ├─ OpusAudioDecoder - Decodes Opus frames to PCM (WASM-backed)
    │   ├─ L16Decoder - Resamples or passes through raw PCM l16
    │   └─ PassThroughDecoder - Forwards raw Opus/Ogg frames unchanged
    └─ TranscriptionBackend - Sends audio to provider
        ↓
    Backend (OpenAIBackend, DeepgramBackend, GeminiBackend)
        ↓
    Provider API (WebSocket or HTTP stream)
```

### Key Components

**TranscriberProxy** (`src/transcriberproxy.ts`)
- Manages a single client WebSocket connection
- Creates `OutgoingConnection` instances per participant tag
- Handles ping/pong keepalive
- Optional dispatcher forwarding (sends transcriptions to external service)
- Optional WebSocket message dumping for debugging
- Tracks `failedStartTags`: if a `start` event has an invalid `mediaFormat`, subsequent `media` events for that tag are dropped (not auto-connected with defaults) until a valid `start` event arrives

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

**AudioDecoder** (`src/AudioDecoder.ts`)
- Interface for format-agnostic audio decoding with chunk-sequence tracking
- `decodeChunk()` returns `DecodedAudio[]` (with `audioData: Uint8Array`) or `null` for out-of-order packets
- `DecodedAudio.kind` distinguishes `'normal'` from `'concealment'` frames (for metrics)
- `DecodedAudio.samplesDecoded` is 0 for non-PCM pass-through (`PassThroughDecoder`)
- Implementations: `OpusAudioDecoder`, `L16Decoder`, `PassThroughDecoder`

**AudioDecoderFactory** (`src/AudioDecoderFactory.ts`)
- `createAudioDecoder(inputFormat, outputFormat)` selects the right decoder
- Returns `PassThroughDecoder` when output is raw Opus or Ogg (no decoding needed)
- Returns `L16Decoder` when input is already l16 and output is l16 (resample or pass-through)
- Returns `OpusAudioDecoder` when input is Opus and PCM output is required

**OpusAudioDecoder** (`src/OpusDecoder/OpusAudioDecoder.ts`)
- Implements `AudioDecoder` with packet-loss concealment logic
- Wraps the low-level WASM `OpusDecoder`; handles gap detection and concealment frames
- Decodes Opus frames at 48kHz to PCM at 24kHz mono

**L16Decoder** (`src/L16Decoder.ts`)
- Implements `AudioDecoder` for raw PCM l16 input
- If input and output sample rates match, frames are forwarded unchanged; otherwise resampled via linear interpolation
- Still performs out-of-order packet detection; validates even byte length before resampling

**PassThroughDecoder** (`src/PassThroughDecoder.ts`)
- Implements `AudioDecoder` without actual decoding
- Forwards raw Opus or Ogg frames unchanged; still performs out-of-order packet detection
- `samplesDecoded` is always 0 (no PCM to count)

**OpusDecoder** (`src/OpusDecoder/OpusDecoder.ts`)
- Low-level TypeScript wrapper around the WASM Opus decoder
- Used by `OpusAudioDecoder`; not used directly by `OutgoingConnection`

**TranscriptionBackend** (`src/backends/TranscriptionBackend.ts`)
- Abstract interface for transcription providers
- Implementations: `OpenAIBackend`, `DeepgramBackend`, `GeminiBackend`, `DummyBackend`
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

### Backend-Specific Behavior

**OpenAI**
- Uses Server VAD (Voice Activity Detection)
- Sends PCM audio
- Supports confidence scores
- Real-time streaming transcription

**Deepgram**
- Passes raw Opus/Ogg through by default (`DEEPGRAM_ENCODING=opus`); set `DEEPGRAM_ENCODING=linear16` to decode to PCM first
- Supports punctuation, diarization, language detection
- Streaming results with interim and final transcripts
- When `DEEPGRAM_DIARIZE=true` and word-level `speaker` indices are present, results are split per speaker segment; each message carries a `speaker: number` field
- `DEEPGRAM_MIP_OPT_OUT=true` adds `mip_opt_out=true` to the WS URL (opts out of Deepgram's Model Improvement Program; default false). Overridable per-connection via the `deepgram_mip_opt_out` URL query param, which flows `ISessionParameters` → `TranscriberProxyOptions` → `BackendConfig.deepgramMipOptOut`; `DeepgramBackend` resolves `backendConfig.deepgramMipOptOut ?? config.deepgram.mipOptOut`. The CF Worker forwards `DEEPGRAM_MIP_OPT_OUT` to the container via `buildContainerEnvVars`
- When Deepgram provides `alternative.languages`, the first entry is always set as the `language` property on the `TranscriptionMessage` (both standard and diarized paths), unconditionally. `DEEPGRAM_INCLUDE_LANGUAGE=true` additionally appends the language as a text suffix (e.g. `[en]`) — these are independent behaviours

**Gemini**
- Multimodal model (primarily used for audio here)
- Real-time API with WebSocket
- Sends PCM audio

**xAI**
- Uses xAI's WebSocket STT API (`wss://api.x.ai/v1/stt`); config entirely via URL query params (no session message)
- Auth via `Authorization: Bearer` header — passed using Node.js/CF Workers-specific third argument to `WebSocket` constructor (cast via `as any`)
- Sends raw binary PCM frames (signed 16-bit LE, 24kHz); always requests `{ encoding: 'l16', sampleRate: 24000 }` from `getDesiredAudioFormat()`
- `forceCommit()` sends `{"type": "audio.done"}` to flush and finalize the last pending utterance when the audio stream goes idle (no multiplexing — one WS per stream). xAI closes the WS after `audio.done` (observed code 1006); the connection is recreated on the next media event. #94 had made this a no-op; even with #95's `endpointing`-based finalization (see below) the trailing utterance before a pause/mute was left unfinalized once audio stopped, so the explicit idle commit was restored. xAI's own `"ASR stream timed out"` on a long idle is still handled by the recoverable-reconnect path above
- xAI closes the ASR stream after a stretch of silence with `{type:error, message:"ASR stream timed out"}`. `handleMessage` detects this (message matches `/timed out/i`) and calls `onError('api_error', message, /* recoverable */ true)` (metric `errorType: 'stream_timeout'`); other `type:error` messages are non-recoverable (`errorType: 'api_error'`, `recoverable === false`). Either way the dead WS is still `close()`d — the in-place reconnect happens on the `OutgoingConnection` side (JIT-15901)
- `transcript.partial` with `speech_final=false` → interim; `transcript.partial` with `speech_final=true` → final (true utterance end); multiple `is_final=true` partials may arrive for a single utterance with accumulating text — only `speech_final=true` is the definitive end; `transcript.done` fires at stream end with empty text and is ignored
- Detected `language` is a BCP-47 code (e.g. `"en"`) and is present on `transcript.partial` events. It is passed through verbatim from xAI (no transformation)
- When `XAI_DIARIZE=true` and words carry `speaker` indices, results are split per speaker segment (same pattern as Deepgram)
- `XAI_INCLUDE_LANGUAGE=true` appends language suffix (e.g. `[en]`) to final transcript text; `language` field is always set on final messages when detected
- **Segmentation = `endpointing` (silence), not `smart_turn`.** `endpointing` (silence ms before a final) is **always sent**, default **850ms** (`XAI_ENDPOINTING`; xAI's own default of 10ms is far too choppy). `smart_turn` is end-of-turn detection for a *multi-speaker single stream*; we run one WS per participant (no turns), and enabling it holds finals across mid-sentence pauses → very long chunks. So `smart_turn`/`smart_turn_timeout` are **opt-in**: sent only when `XAI_SMART_TURN` is explicitly set (`config.xai.smartTurn` defaults to `undefined`). `smart_turn_timeout` (default 500) is only sent alongside `smart_turn`.
- All three segmentation knobs are **per-connection overridable** via URL query params — `endpointing`, `smart_turn`, `smart_turn_timeout` — flowing `ISessionParameters` (`xaiEndpointing`/`xaiSmartTurn`/`xaiSmartTurnTimeout`) → `TranscriberProxyOptions` → `BackendConfig`; `XAIBackend` resolves `backendConfig.xaiX ?? config.xai.X` (same pattern as `language`/`deepgram_mip_opt_out`)
- The CF Worker forwards `XAI_API_KEY` (as `''` when unset → provider disabled) plus any set `XAI_STT_URL`/`XAI_LANGUAGE`/`XAI_DIARIZE`/`XAI_INCLUDE_LANGUAGE`/`XAI_ENDPOINTING`/`XAI_SMART_TURN`/`XAI_SMART_TURN_TIMEOUT` to the container via `buildContainerEnvVars`

### Configuration System (`src/config.ts`)

All configuration is loaded from environment variables or `.env` file using dotenv.

Provider priority: `PROVIDERS_PRIORITY=openai,deepgram,gemini`
- First available provider (with API key) becomes default
- Can be overridden per-connection via `?provider=deepgram`

See README.md for complete configuration reference.

### Observability

**Metrics** (`src/metrics.ts`, `src/telemetry/instruments.ts`)
- Prometheus metrics exported to OTLP HTTP endpoint
- Tracks: active sessions, audio bytes, transcription latency, backend errors
- Only enabled when `OTLP_ENDPOINT` is set
- Each container instance is differentiated via `CLOUDFLARE_DURABLE_OBJECT_ID` (falls back to random UUID for local dev). Metrics use `service.instance.id` (standard OTEL, Mimir-friendly). Logs use `runId` (custom name to avoid Loki auto-indexing it as a high-cardinality label).
- Container location is tagged via `city` (from `CLOUDFLARE_LOCATION`) and `country` (from `CLOUDFLARE_COUNTRY_A2`)

**Logging** (`src/logger.ts`)
- Uses Winston with OTLP logs transport
- Levels: error, warn, info, debug
- Set `LOG_LEVEL=debug` or `DEBUG=true` for verbose output

### Cloudflare Workers Integration

The `worker/` directory contains:
- `index.ts` - Cloudflare Worker entry point
- `ContainerCoordinator.ts` - Manages container routing (pool vs session mode)
- Uses `@cloudflare/containers` to run the Node.js server

Two routing modes:
1. **Session mode** (`ROUTING_MODE=session`): One container per session
2. **Pool mode** (`ROUTING_MODE=pool`): Round-robin across container pool

## Common Patterns

### Adding a New Backend

1. Create `src/backends/YourBackend.ts` implementing `TranscriptionBackend`
2. Add configuration to `src/config.ts`
3. Update `src/backends/BackendFactory.ts` to register the backend
4. Add tests in `test/unit/backends/YourBackend.test.ts`

See `src/backends/DummyBackend.ts` for a minimal example.

### Audio Encoding Notes

- Client sends Opus frames (raw or Ogg-Opus container)
- `OutgoingConnection` calls `backend.getDesiredAudioFormat(inputFormat)` to determine what the backend wants
- `AudioDecoderFactory.createAudioDecoder(inputFormat, outputFormat)` then creates the right decoder:
  - `PassThroughDecoder` when output encoding is `'opus'` or `'ogg'` (no decode/re-encode)
  - `L16Decoder` when input encoding is `'l16'` and output encoding is `'l16'` (resample or identity)
  - `OpusAudioDecoder` when input is Opus and output encoding is `'l16'` (decode to PCM)
- PCM format: 24kHz, 16-bit, mono (`audioData` is a `Uint8Array` of raw PCM bytes)
- Deepgram can accept raw Opus to avoid decode/re-encode
- `OutgoingConnection.updateInputFormat()` calls `reinitializeDecoder()` when the format changes. If `backend.getDesiredAudioFormat(newInputFormat)` returns a different encoding than the one the backend was connected with, `reinitializeDecoder` closes the old backend and opens a fresh one (`reconnectBackend`) before creating the decoder. The generation counter (`reinitGeneration`) ensures concurrent calls are safe: `activeDesiredFormat` is set synchronously so concurrent calls immediately see the new target format.

### Session Resumption

When `SESSION_RESUME_ENABLED=true` (default):
1. Client disconnects → `TranscriberProxy` detaches from WebSocket
2. Session stays alive for `SESSION_RESUME_GRACE_PERIOD` seconds (default 15)
3. Client reconnects with same `sessionId` → reattaches to existing session
4. Audio streams and transcription continue without interruption

### Force Commit Timeout

When audio stops flowing, `OutgoingConnection` waits `FORCE_COMMIT_TIMEOUT` seconds (default 2) then calls `backend.forceCommit()` to finalize pending audio and generate transcription.

## File Organization

```
src/
├── server.ts                  # HTTP/WS server entry (Node.js)
├── transcriberproxy.ts        # Main proxy orchestration
├── OutgoingConnection.ts      # Per-participant handler
├── AudioDecoder.ts            # AudioDecoder interface + DecodedAudio types
├── AudioDecoderFactory.ts     # Selects decoder based on format negotiation
├── L16Decoder.ts              # PCM l16 decoder (resample or identity)
├── PassThroughDecoder.ts      # Raw-audio pass-through (no decode)
├── SessionManager.ts          # Session lifecycle management
├── config.ts                  # Configuration
├── dispatcher.ts              # Dispatcher WebSocket forwarding
├── logger.ts                  # Winston logger setup
├── metrics.ts                 # Metric writing utilities
├── telemetry.ts               # OTLP setup
├── telemetry/instruments.ts   # Prometheus instruments
├── utils.ts                   # Shared utilities
├── MetricCache.ts             # Metric aggregation
├── backends/
│   ├── TranscriptionBackend.ts   # Abstract interface (incl. getDesiredAudioFormat)
│   ├── BackendFactory.ts         # Provider factory
│   ├── OpenAIBackend.ts          # OpenAI implementation
│   ├── DeepgramBackend.ts        # Deepgram implementation
│   ├── GeminiBackend.ts          # Gemini implementation
│   ├── XAIBackend.ts             # xAI implementation
│   └── DummyBackend.ts           # Test/stats backend
└── OpusDecoder/
    ├── OpusAudioDecoder.ts       # High-level AudioDecoder (gap detection + concealment)
    ├── OpusDecoder.ts            # Low-level WASM wrapper
    ├── opus_frame_decoder.c/h    # C code for WASM
    └── opus/                     # libopus source (submodule)

worker/
├── index.ts                   # Cloudflare Worker entry
└── ContainerCoordinator.ts    # Container routing logic

test/
├── setup.ts                   # Vitest setup
├── helpers/                   # Test utilities
└── unit/                      # Unit tests
```

## Debugging Tools

### WebSocket Message Dumping
```bash
DUMP_WEBSOCKET_MESSAGES=true npm run dev
# Messages saved to /tmp/{sessionId}/media.jsonl
```

### Replay Recorded Session
```bash
node scripts/replay-dump.cjs /tmp/session123/media.jsonl "ws://localhost:8080/transcribe?sendBack=true"
```

### Mix Audio from Session
```bash
npm run mix-audio /tmp/session123/media.jsonl output.wav
# Mixes all participant audio streams into a single WAV file
```

## WebSocket Protocol

### Client → Server

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

### Server → Client (when sendBack=true)

**Transcription result:**
```json
{
  "type": "transcription-result",
  "is_interim": false,
  "transcript": [{"text": "hello", "confidence": 0.98}],
  "participant": {"id": "participant-id"},
  "timestamp": 1768341932000,
  "language": "en"
}
```

**Pong:**
```json
{"event": "pong", "id": 123}
```

## Environment Variables Reference

See README.md for complete list. Key ones:

- `PROVIDERS_PRIORITY` - Provider priority order (default: openai,deepgram,gemini)
- `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY` - API keys
- `ENABLE_OPENAI_CUSTOM_PROVIDER` - Enable the openai_custom provider (default: false)
- `OPENAI_CUSTOM_REQUIRE_WSS` - Require wss:// for openaiCustomUrl (default: true; set false to allow ws://)
- `PORT`, `HOST` - Server listen config
- `FORCE_COMMIT_TIMEOUT` - Seconds before finalizing pending audio (default: 2)
- `SESSION_RESUME_ENABLED` - Enable session resumption (default: true)
- `SESSION_RESUME_GRACE_PERIOD` - Resume grace period in seconds (default: 15)
- `DUMP_WEBSOCKET_MESSAGES` - Enable message dumping for debugging
- `USE_DISPATCHER` - Enable dispatcher forwarding
- `OTLP_ENDPOINT` - OTLP HTTP endpoint for metrics/logs (disabled if empty)

## Keeping Documentation Current

When making code changes, update `CLAUDE.md` and `BACKENDS.md` in the same commit:

- **CLAUDE.md** — update the relevant Key Components description, Common Patterns section, or Notes for Claude whenever behaviour, interfaces, or invariants change.
- **BACKENDS.md** — update whenever the `TranscriptionBackend` interface changes, audio format negotiation behaviour changes, or backend-specific behaviour changes.

Do not leave stale descriptions. If a note says "only X happens" and you change it so Y also happens, fix the note.

## Notes for Claude

- The WASM build requires Emscripten to be installed and activated (see Prerequisites section). If build fails, check that Emscripten is installed and that `npm run configure` was run.
- When modifying backends, ensure they handle connection lifecycle correctly (pending → connected → failed/closed).
- Session resumption means a `TranscriberProxy` may exist without an active WebSocket connection.
- Each participant creates its own `OutgoingConnection` and backend connection to the provider.
- The `tag` field identifies a participant within a session. Format can be `{id}-{ssrc}` or just `{id}`.
- Deepgram is the only backend that supports raw Opus/Ogg pass-through (controlled by `DEEPGRAM_ENCODING`, default `opus`). It returns the input encoding unchanged from `getDesiredAudioFormat()` when pass-through is active. The old `wantsRawOpus()` method has been replaced by `getDesiredAudioFormat()`.
- `openai_custom` is a provider that reuses `OpenAIBackend` but with a per-request WebSocket URL (from the `openaiCustomUrl` URL query parameter) and API key (from the `X-Custom-Openai-Api-Key` HTTP header). It is gated by `ENABLE_OPENAI_CUSTOM_PROVIDER=true` (similar to `ENABLE_DUMMY_PROVIDER`). The URL and key are stored in `TranscriberProxyOptions` (`openaiCustomUrl`, `openaiCustomApiKey`) and passed to `BackendFactory.createBackend` via `OpenAICustomOptions`. `BackendFactory` instantiates `OpenAIBackend(tag, participantInfo, wsUrl, apiKey)` for this provider.
- `DecodedAudio.audioData` is a `Uint8Array` of raw bytes (PCM for decoded audio, raw frames for pass-through). The old `pcmData: Int16Array` field no longer exists.
- When adding a new backend, implement `getDesiredAudioFormat(inputFormat): AudioFormat`. Return `{ encoding: 'l16', sampleRate: 24000 }` for PCM or `{ ...inputFormat }` (shallow copy) for raw pass-through. Do not return the `inputFormat` reference directly. This method is called on every `reinitializeDecoder` call (not just once at construction), so it must be a pure function of `inputFormat` for a given backend configuration. If the method has connect-time side effects (like `DeepgramBackend` storing `negotiatedFormat`), it will also be called on any new backend instance before `connect()`, so those side effects will be applied correctly.
- `AudioFormat.encoding` is a lowercase union type: `'opus' | 'ogg' | 'l16'`. The client-facing `'ogg-opus'` value is normalised to `'ogg'` by `validateAudioFormat()`, and all incoming encodings are lowercased before validation so case-insensitive client values are accepted.
- `OggOpusDecapsulator` only requires an `OpusHead` packet when its first page is a beginning-of-stream page (Ogg `header_type & 0x02`). If the first page seen is a non-BOS page — which happens when a client reconnects and resumes an existing Ogg stream mid-way after a server/container restart, without replaying the headers — it logs a warning and decodes from that point instead of throwing. This matters for any backend that requests `l16` from `ogg` input (e.g. xAI always, Deepgram with `DEEPGRAM_ENCODING=linear16`), which routes audio through `CascadedDecoder(OggOpusDecapsulator → OpusAudioDecoder)`. Backends on the pass-through path (`PassThroughDecoder`) never hit this validation.
- `doClose()` is idempotent. Do not call it more than once expecting repeated side effects — the `isClosed` guard makes subsequent calls no-ops. Backend callbacks (`onClosed`, `onError`, etc.) are nulled before `close()` is called, so async backend events arriving after teardown are silently dropped.
