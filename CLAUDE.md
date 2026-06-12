# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a real-time WebSocket transcription proxy that routes audio (Opus or other formats) to multiple speech-to-text backends (OpenAI, Deepgram, Google Gemini). It supports:
- Multi-participant sessions (one WebSocket handles multiple audio streams)
- Provider fallback with configurable priority
- Two deployment modes: Node.js standalone or Cloudflare Workers with Containers
- Session resumption (detach/reattach within grace period)
- Optional dispatcher forwarding and OTLP telemetry

## Build System

### Prerequisites

Opus is compiled **natively** (not WebAssembly) via a node-gyp N-API addon, so a
C/C++ toolchain is required:

- A C/C++ compiler (`clang`/`gcc` + `g++`), `make`, and `python3` (for node-gyp).
  - macOS: install the Xcode Command Line Tools (`xcode-select --install`).
  - Debian/Ubuntu: `apt-get install build-essential python3`.
  - Alpine (container): `apk add python3 make g++` (handled by the Dockerfile).
- The libopus source submodule must be checked out:
  `git submodule update --init src/OpusDecoder/opus`.

No Emscripten is needed. libopus is built from the submodule entirely by node-gyp.

### Initial Setup (First Time Only)
```bash
npm install
git submodule update --init src/OpusDecoder/opus
npm run build:native  # Compiles libopus + the N-API addon (build/Release/opus_native.node)
```

### Regular Build
```bash
npm run build      # Builds the native addon + esbuild bundle
```

This runs two steps:
1. `npm run build:native` - `node-gyp rebuild`: compiles libopus (from the
   submodule) and the N-API addon into `build/Release/opus_native.node`
2. `npm run build:bundle` - Bundles with esbuild for production (dist/bundle/server.js)

The native build (`binding.gyp`) compiles a portable C float build of libopus and
selects SIMD at **runtime** via libopus' RTCD: on x86 it probes the CPU (cpuid) and
uses SSE/SSE2/SSE4.1/AVX2 only when present; on aarch64 NEON is part of the base ISA
and used directly. Nothing is presumed on x86, so the binary runs on any CPU. Each
ISA's intrinsic files are compiled into their own static_library (with the matching
`-msse4.1`/`-mavx2` flags) so the addon never executes an instruction the CPU lacks.
`native/opus_addon.cc` is the N-API wrapper; `native/opus-config/config.h` is the
hand-written libopus build config.

### Development
```bash
npm run dev        # Builds the native addon once, then runs tsx with watch mode
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
npm run docker:build       # Build the Docker image (self-contained)
npm run docker:run         # Run container with .env
npm run docker:stop        # Stop running containers
```

The Dockerfile is multi-stage and **self-contained**: the builder stage compiles
the native Opus addon (libopus + N-API) and bundles the server inside the image; the
runtime stage copies only `build/Release/opus_native.node`, `dist/bundle`, and
production dependencies. A host-built `.node` cannot be reused because it is
platform-specific, so `docker:build` no longer depends on a host `npm run build`.

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
    │   ├─ OpusAudioDecoder - Decodes Opus frames to PCM (native libopus)
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
- Wraps the low-level `OpusDecoder`; handles gap detection and concealment frames
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
- Low-level TypeScript wrapper around the native libopus addon (via `nativeOpus.ts`)
- Supports `decodeFrame`, FEC/PLC `conceal`, `reset`, and `free`
- Used by `OpusAudioDecoder` and `TranslatorConnection`; not used directly by `OutgoingConnection`

**OpusEncoder** (`src/OpusEncoder/OpusEncoder.ts`)
- Low-level TypeScript wrapper around the native libopus encoder (via `nativeOpus.ts`)
- Accumulates PCM and emits one Opus packet per 20 ms frame (`encodeFrame`)
- Used by `TranslatorConnection` to re-encode translated PCM back to Opus

**nativeOpus** (`src/OpusDecoder/nativeOpus.ts`)
- Loads the compiled N-API addon `build/Release/opus_native.node` (via `createRequire`,
  probing a few known locations so it works under tsx and the esbuild bundle)
- Exports typed `NativeOpusDecoder` / `NativeOpusEncoder` interfaces and `OPUS_APPLICATION`

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
- When Deepgram provides `alternative.languages`, the first entry is always set as the `language` property on the `TranscriptionMessage` (both standard and diarized paths), unconditionally. `DEEPGRAM_INCLUDE_LANGUAGE=true` additionally appends the language as a text suffix (e.g. `[en]`) — these are independent behaviours

**Gemini**
- Multimodal model (primarily used for audio here)
- Real-time API with WebSocket
- Sends PCM audio

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
│   └── DummyBackend.ts           # Test/stats backend
├── OpusDecoder/
│   ├── OpusAudioDecoder.ts       # High-level AudioDecoder (gap detection + concealment)
│   ├── OpusDecoder.ts            # Low-level decoder wrapper (native libopus)
│   ├── nativeOpus.ts             # Loader + typed interface for the N-API addon
│   └── opus/                     # libopus source (submodule)
└── OpusEncoder/
    └── OpusEncoder.ts            # Low-level encoder wrapper (native libopus)

native/                        # Native Opus addon (compiled by node-gyp)
├── opus_addon.cc              # N-API wrapper (OpusDecoder + OpusEncoder classes)
└── opus-config/config.h       # Hand-written libopus build config
binding.gyp                    # node-gyp build: libopus + per-ISA SIMD + addon

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

- Opus is native (node-gyp N-API addon, `build:native`), not WebAssembly. The build needs a C/C++ toolchain + python3 and the `src/OpusDecoder/opus` submodule checked out. If the addon fails to load at runtime, confirm `build/Release/opus_native.node` exists (run `npm run build:native`) and that `src/OpusDecoder/nativeOpus.ts`'s candidate paths still resolve relative to `process.cwd()` / the module.
- SIMD is selected at runtime (libopus RTCD on x86; NEON baseline on aarch64). Never add `-msse*`/`-mavx*` to the base `libopus` target or to global cflags — those flags must stay confined to their per-ISA static_library targets in `binding.gyp`, or the addon may execute instructions the CPU lacks.
- When modifying backends, ensure they handle connection lifecycle correctly (pending → connected → failed/closed).
- Session resumption means a `TranscriberProxy` may exist without an active WebSocket connection.
- Each participant creates its own `OutgoingConnection` and backend connection to the provider.
- The `tag` field identifies a participant within a session. Format can be `{id}-{ssrc}` or just `{id}`.
- Deepgram is the only backend that supports raw Opus/Ogg pass-through (controlled by `DEEPGRAM_ENCODING`, default `opus`). It returns the input encoding unchanged from `getDesiredAudioFormat()` when pass-through is active. The old `wantsRawOpus()` method has been replaced by `getDesiredAudioFormat()`.
- `openai_custom` is a provider that reuses `OpenAIBackend` but with a per-request WebSocket URL (from the `openaiCustomUrl` URL query parameter) and API key (from the `X-Custom-Openai-Api-Key` HTTP header). It is gated by `ENABLE_OPENAI_CUSTOM_PROVIDER=true` (similar to `ENABLE_DUMMY_PROVIDER`). The URL and key are stored in `TranscriberProxyOptions` (`openaiCustomUrl`, `openaiCustomApiKey`) and passed to `BackendFactory.createBackend` via `OpenAICustomOptions`. `BackendFactory` instantiates `OpenAIBackend(tag, participantInfo, wsUrl, apiKey)` for this provider.
- `DecodedAudio.audioData` is a `Uint8Array` of raw bytes (PCM for decoded audio, raw frames for pass-through). The old `pcmData: Int16Array` field no longer exists.
- When adding a new backend, implement `getDesiredAudioFormat(inputFormat): AudioFormat`. Return `{ encoding: 'l16', sampleRate: 24000 }` for PCM or `{ ...inputFormat }` (shallow copy) for raw pass-through. Do not return the `inputFormat` reference directly. This method is called on every `reinitializeDecoder` call (not just once at construction), so it must be a pure function of `inputFormat` for a given backend configuration. If the method has connect-time side effects (like `DeepgramBackend` storing `negotiatedFormat`), it will also be called on any new backend instance before `connect()`, so those side effects will be applied correctly.
- `AudioFormat.encoding` is a lowercase union type: `'opus' | 'ogg' | 'l16'`. The client-facing `'ogg-opus'` value is normalised to `'ogg'` by `validateAudioFormat()`, and all incoming encodings are lowercased before validation so case-insensitive client values are accepted.
- `doClose()` is idempotent. Do not call it more than once expecting repeated side effects — the `isClosed` guard makes subsequent calls no-ops. Backend callbacks (`onClosed`, `onError`, etc.) are nulled before `close()` is called, so async backend events arriving after teardown are silently dropped.
