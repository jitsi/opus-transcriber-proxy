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

### Opus backends

There are **two** interchangeable low-level Opus codec backends, selected at runtime via
`OPUS_BACKEND` (`config.opus.backend`):

- **`wasm`** (default) — Emscripten/WebAssembly build. Required when running in a Cloudflare
  Worker (no native addons); needs Emscripten to build the `.wasm` artifacts.
- **`native`** — libopus N-API addon (`build/Release/opus_native.node`). Container-only, faster;
  needs a C/C++ toolchain. Opt in with `OPUS_BACKEND=native`.

`OpusDecoder`/`OpusEncoder` are facades that dynamically import only the selected backend, so a
native deployment never loads the WASM files and a WASM deployment never requires the addon.

### Prerequisites

- **WASM backend**: Emscripten (emsdk) + autotools (`autoconf`/`automake`/`libtool`/`make`) to
  build libopus, plus the `src/OpusDecoder/opus` submodule.
- **Native backend**: a C/C++ compiler (`clang`/`gcc` + `g++`), `make`, `python3` (node-gyp), plus
  the submodule.
  - macOS: `xcode-select --install`; Debian/Ubuntu: `apt-get install build-essential python3`;
    Alpine (container): `apk add python3 make g++`.
- Submodule: `git submodule update --init src/OpusDecoder/opus`.

### Initial Setup (First Time Only)
```bash
npm install
git submodule update --init src/OpusDecoder/opus
npm run configure     # emconfigure libopus for the WASM build (Emscripten)
npm run build         # builds WASM + native + esbuild bundle (see below)
```

### Regular Build
```bash
npm run build         # build:wasm + build:native + build:bundle
```

This runs three steps:
1. `npm run build:wasm` - compiles the Emscripten decoder/encoder into `dist/opus-*.{cjs,wasm}`
2. `npm run build:native` - `node-gyp rebuild`: compiles libopus + the N-API addon into `build/Release/opus_native.node`
3. `npm run build:bundle` - Bundles with esbuild for production (dist/bundle/server.js)

(Build only the backend you need — `build:wasm` or `build:native` — when not running both.)

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
npm run dev        # Builds the WASM artifacts once, then runs tsx (src/server.ts) with watch mode
npm run typecheck  # Type check without emitting files
```

### Testing
```bash
npm test                    # Run all tests with vitest
npm run test -- <pattern>   # Run specific test file
npm run test -- --coverage  # Generate coverage report
```

Tests are in `test/` with helpers in `test/helpers/`. The test setup uses vitest with mocking for WebSocket, Opus decoder, and backend connections.

### Integration tests

`npm run test:integration -- --runtime=container|worker --opus-backend=wasm|native --endpoint=transcribe|translate --provider=...`
runs one cell of the container/worker x opus-backend x endpoint x provider matrix against the real
server/worker process — no mocks — replaying `resources/sample.jsonl` via `scripts/replay-dump.cjs
--ci` and asserting on the transcripts/media received. See `test/integration/MATRIX.md` for the
full 11-cell list and required API keys — `runtime=worker` only covers `/translate` (production
never routes `/transcribe` through the Worker), and Gemini is excluded to keep the per-PR matrix
smaller. Runs in CI via `.github/workflows/integration-test.yml` on every PR into `main` and on
`workflow_dispatch` — cells without their provider's API key secret set are soft-skipped, not failed.

### Docker
```bash
npm run docker:build       # build:wasm (host) + docker build
npm run docker:run         # Run container with .env
npm run docker:stop        # Stop running containers
```

The image ships **both** Opus backends (default `wasm`; `OPUS_BACKEND=native` opts in). The
Dockerfile is multi-stage:
- The **builder** stage compiles the native addon (`build/Release/opus_native.node`) and bundles
  the server in-container — the native addon is platform-specific, so it must be built per target
  arch (a host `.node` can't be reused).
- The **WASM** artifacts (`dist/opus-*.{cjs,wasm}`) are architecture-independent and are built on
  the host/CI by `npm run build:wasm`, then copied into the runtime stage. They are deliberately
  **not** built in-image: `emscripten/emsdk` is amd64-only, so building WASM in a multi-arch image
  would run under QEMU emulation on arm64 and be far too slow. Hence `docker:build` runs `build:wasm`
  first, and `dh.yml` builds WASM on the runner before `docker build`.

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

The `/translate` endpoint runs a parallel pipeline for speech-to-speech translation:

```
Bridge WebSocket (/translate)
    ↓
TranslatorProxy (translatorproxy.ts)
    ├─ One per WebSocket connection
    ├─ Reconciles `sources` control events into per-(source, language) connections
    └─ Routes media by tag to multiple TranslatorConnections
        ↓
TranslatorConnection (TranslatorConnection.ts) - One per (source, language)
    ├─ OpusDecoder - Decodes the speaker's Opus to PCM
    ├─ OpenAI Realtime translations session - PCM in, translated PCM + transcript out
    └─ OpusEncoder - Re-encodes the translated PCM to Opus for the return path
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
- Wraps the low-level `OpusDecoder`; handles gap detection and concealment frames
- Decodes Opus frames to mono PCM at a configurable output rate (default 24kHz; 16kHz when requested by the xAI backend). Supported rates: 8/12/16/24/48kHz

**L16Decoder** (`src/L16Decoder.ts`)
- Implements `AudioDecoder` for raw PCM l16 input
- If input and output sample rates match, frames are forwarded unchanged; otherwise resampled via linear interpolation
- Still performs out-of-order packet detection; validates even byte length before resampling

**PassThroughDecoder** (`src/PassThroughDecoder.ts`)
- Implements `AudioDecoder` without actual decoding
- Forwards raw Opus or Ogg frames unchanged; still performs out-of-order packet detection
- `samplesDecoded` is always 0 (no PCM to count)

**OpusDecoder** (`src/OpusDecoder/OpusDecoder.ts`)
- Low-level decoder **facade**: picks the native or WASM backend at runtime (`config.opus.backend` / `OPUS_BACKEND`) and dynamically imports only that one, so the other backend's module is never evaluated (no stray native-addon require or WASM file-read)
- Public API unchanged: `new OpusDecoder({ sampleRate, channels })`, `ready`, `decodeFrame`, FEC/PLC `conceal`, `reset`, `free`. Init is async (behind `ready`) because the backend is dynamically imported
- Backends: `OpusDecoderNative.ts` (libopus N-API addon via `nativeOpus.ts`) and `OpusDecoderWasm.ts` (Emscripten); both implement `IOpusDecoder` (`opusTypes.ts`)
- Used by `OpusAudioDecoder` and `TranslatorConnection`; not used directly by `OutgoingConnection`

**OpusEncoder** (`src/OpusEncoder/OpusEncoder.ts`)
- Low-level encoder **facade**, symmetric to `OpusDecoder`: selects `OpusEncoderNative.ts` or `OpusEncoderWasm.ts` (both implement `IOpusEncoder`, `opusEncoderTypes.ts`) via `OPUS_BACKEND`, dynamic-importing only the chosen one
- Public API unchanged: `new OpusEncoder(config)`, `ready`, `encodeFrame` (one Opus packet per 20 ms frame), `getFrameSize`, `getFrameSizeBytes`, `free`
- Used by `TranslatorConnection` to re-encode translated PCM back to Opus

**nativeOpus** (`src/OpusDecoder/nativeOpus.ts`)
- Loads the compiled N-API addon `build/Release/opus_native.node` (via `createRequire`,
  probing a few known locations so it works under tsx and the esbuild bundle). Only imported when `OPUS_BACKEND=native`
- Exports typed `NativeOpusDecoder` / `NativeOpusEncoder` interfaces and `OPUS_APPLICATION`

**TranslatorProxy** (`src/translatorproxy.ts`)
- Manages a single `/translate` WebSocket connection (the bridge side)
- Reconciles `sources` control events (`exports` = sender source names, `requests` = synthetic `<source>.<language>` names) into one `TranslatorConnection` per (source, language)
- Routes incoming `media` events to the matching connection by tag; closes connections dropped from `requests`
- Also supports a dev `?lang=` path that seeds the initial target languages
- Sends the server `info` message on connect (via `buildServerInfo`, provider fixed to `openai`) and logs any inbound client `info` event, mirroring `TranscriberProxy`
- Owns the monotonic mediajson wire-envelope `sequenceNumber` for outbound `media` (per-proxy = per-WebSocket, which carries all synthetic sources); the per-source RTP sequence number is the separate `chunk` field from each connection's `RtpTimestamper`
- `emitTranscripts` (`runtime.config.emitTranscripts`; Node resolves it from `config.translation.transcripts`, default true) controls whether target-language transcripts are emitted

**TranslatorConnection** (`src/TranslatorConnection.ts`)
- Manages one (source, language) translation stream
- Decodes the speaker's Opus to PCM (`OpusDecoder`), forwards it to an OpenAI Realtime translations session (model `config.translation.model` / `OPENAI_TRANSLATION_MODEL`; key `config.translation.apiKey` = `OPENAI_TRANSLATION_API_KEY` ?? `OPENAI_API_KEY`), and re-encodes the returned translated PCM to Opus (`OpusEncoder`) for the return path
- Emits translated Opus frames (`onAudioFrame(tag, chunk, timestamp, payload)`) and the translated (target-language) transcript (`onTranscription(transcript, targetLanguage, isInterim)`) — transcript **deltas** are `isInterim: true`, the transcript-**done** event is final. Both suppressed when `emitTranscripts === false`
- RTP timing comes from `RtpTimestamper` (one continuous, monotonic timeline; see below) — there is no per-response timestamp reset
- Latency instrumentation (the per-frame speech-RMS gate `pcmContainsSpeech` and the TTFA log) is debug-only (`measureLatency = config.debug`)
- `doClose()` is idempotent (guarded by `isClosed`) and detaches callbacks before teardown, mirroring `OutgoingConnection`. The OpenAI WebSocket init is deferred to a microtask so the proxy's `onError`/`onClosed` are wired before a synchronous `new WebSocket` failure can fire; that path notifies `onError` and tears down
- Reports translated-audio usage **incrementally** via the optional `onUsageReport(durationSeconds, targetLanguage)` callback: a `setInterval` timer (period `runtime.config.usageReportIntervalMs`, `unref`'d so it never keeps the process/isolate alive) fires the audio duration translated **since the previous report** (`reportUsageDelta` = `(sentSamples − reportedSamples) / 24000`, where `sentSamples` is audio actually appended to OpenAI), and `doClose()` clears the timer and flushes the final remaining delta. The deltas sum to the direction's total. Incremental reporting (vs one cumulative report at close) means an abrupt kill — e.g. a Worker hitting its CPU limit — loses only the last partial interval, not the whole direction; it's billing-equivalent because billing is linear in duration and the usage endpoint sums each report's `duration_seconds`. The timer is started only when `onUsageReport` is set **and** the interval is `> 0`, so dev/replay sessions (no callback) start no timer

**RtpTimestamper** (`src/RtpTimestamper.ts`)
- Pure, clock-injectable generator of the RTP timestamp + uint16 sequence number for the 20ms translated-audio frames; used by `TranslatorConnection`
- Maps OpenAI's bursty, faster-than-real-time output onto one continuous, **monotonic** RTP timeline using a media-playout clock: advances by media duration per frame and inserts a proportional silence gap only when the source idled longer than the buffered media (`gapThresholdMs`, default 100). Guarantees the timestamp never decreases across response boundaries or bursts

### Translation runtime abstraction (container vs Worker)

The translation core (`TranslatorProxy`, `TranslatorConnection`, `RtpTimestamper`) is **runtime-agnostic**: it imports no `config`/`logger`/`metrics`/`ws`/codec modules directly. Everything host-specific is injected via a **`TranslationRuntime`** (`src/translate/runtime.ts`): `logger`, config values, metric sink + batcher, an outbound-WebSocket factory, Opus codec factories, and `buildServerInfo`. `IWebSocket` is the minimal socket surface common to Node `ws`, the Node global WebSocket, and the Worker WebSocket.

- **Node/container** — `createNodeTranslationRuntime` (`src/translate/nodeRuntime.ts`): existing `config`/Winston/OTLP, the Node global `WebSocket` (auth via the OpenAI `openai-insecure-api-key` subprotocol), and the codec facades (native/WASM per `OPUS_BACKEND`). Used by `server.ts` for `/transcribe` **and** `/translate`.
- **Cloudflare Worker** — `worker/translationRuntime.ts` + `worker/handleTranslate.ts`: the Worker handles `/translate` **directly** (a `WebSocketPair` `accept()`, no Durable Object — the accepted socket keeps the Worker alive for the session, and the bridge's pings keep it active). console logger, config from Worker env, no-op metrics, WASM codec (import-loaded, no fs — see below), and an **outbound OpenAI socket via fetch-upgrade** (`ws(s)://`→`http(s)://` rewrite; auth via the `Authorization: Bearer` header — never both forms, which OpenAI rejects). The async fetch-upgrade is wrapped as a synchronous `IWebSocket` (queues sends/listeners until connected). `worker/index.ts` calls `handleTranslate` for `/translate`; `/transcribe` stays on the container (Worker outbound-connection limits — translate's fan-out is bounded by source×language). Requires `nodejs_compat`.
- **Worker-safe WASM codec**: `OpusDecoderWasm`/`OpusEncoderWasm` don't read `fs` at module scope — the Emscripten glue + compiled `WebAssembly.Module` are injected via `provideDecoderWasm`/`provideEncoderWasm`. Node registers them from disk (`src/OpusDecoder/wasmSourceNode.ts`, dynamic-imported by the facade only on the wasm path); the Worker imports them (`worker/opusWasmSource.ts`). Auth token is passed to the runtime as a neutral `bearerToken`; each runtime applies it its own way.
- **Guard**: `npm run check:worker-safe` (`scripts/check-worker-safe.mjs`, run in CI) fails if the core imports a Node-only module/API, so it stays bundlable for workerd. `npm run typecheck:worker` typechecks the Worker + imported core against `@cloudflare/workers-types`.

### Translation usage reporting (`src/usage-reporter.ts`)

Live-translation audio duration is metered so it can be billed downstream. It's **runtime-agnostic** (imports no `node:*`/config/logger — the url and a `Logger` are injected per report via `deps`), so it bundles into both the Node container and the Worker; it's on the worker-safe allowlist (`setInterval`/`clearInterval`/`clearTimeout` are globals, not Node imports).

- **Delta semantics**: each `TranslatorConnection.onUsageReport(durationSeconds, targetLanguage)` call carries the audio translated **since the previous report** (periodic while open + a final delta on close), not a cumulative total. `TranslatorProxy` wires that callback to `reportTranslationUsage(...)` — but **only when a `translationToken` is set** (the JVB-forwarded `X-Translation-Token`, threaded through `TranslatorProxyOptions.translationToken` in both runtimes). No token → no callback → no timer, so dev/replay `?lang=` sessions report nothing.
- **Batching**: `reportTranslationUsage` queues events and flushes at 50 events or 1000 ms (`flushTranslationUsage`), grouping by token (one POST per token, `Authorization: Bearer <token>`; body sends only `duration_seconds` per event — `targetLanguage` is local-logging only). Non-2xx → `logger.warn`; network error → `logger.error`; a 5 s `AbortController` bounds each POST. The module-level `buffer`/`flushTimer`/stashed `url`+`logger` and `warnedUnconfigured` are deliberately process/isolate-wide singletons (the usage URL is a deployment-wide constant and cross-connection batching is intended).
- **Close flush**: `flushTranslationUsage()` drains the final delta + any sub-threshold buffer. Node calls it on `SIGTERM`; the Worker calls it via `ctx.waitUntil(flushTranslationUsage())` in `handleTranslate`'s `proxy.on('closed', ...)` handler so the POST completes before the isolate is reclaimed. Without it the last interval's usage would be lost when the isolate is torn down.
- **Billing counter**: usage is billed from `sentSamples` (audio actually appended to OpenAI), not `totalSamplesSent` (all decoded audio) — so a session whose OpenAI socket never opens and drops its buffered audio isn't charged.
- Disabled (no-op, warns once) when `TRANSLATION_USAGE_URL` is unset. Interval configured via `TRANSLATION_USAGE_REPORT_INTERVAL_MS` (default 15000).

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
- Sends raw binary PCM frames (signed 16-bit LE, 16kHz); always requests `{ encoding: 'l16', sampleRate: 16000 }` from `getDesiredAudioFormat()` (the `XAI_SAMPLE_RATE` constant). 16 kHz is xAI's native rate per their STT docs, avoiding a server-side resample; the Opus decoder outputs 16 kHz directly (a natively supported decode rate, no separate resample step)
- `forceCommit()` finalizes the trailing utterance when the stream goes idle **without closing the WS**, by injecting a short tail of digital silence (`endpointing` + `XAI_IDLE_SILENCE_MARGIN_MS` (300) ms of 16kHz 16-bit zeros). xAI has no flush/commit message (unlike OpenAI `input_audio_buffer.commit` / Deepgram `Finalize`) — only `audio.done`, which closes the WS (code 1006) and forces a full teardown + cold-start of the next utterance. Finalization is driven by `endpointing` (xAI's VAD emits `speech_final` after that many ms of silence in the audio); when the client stops sending (pause/mute) no frames arrive so the VAD never crosses the threshold, so we feed it the silence ourselves. #94 had made this a no-op (trailing utterance before a pause/mute went unfinalized); a prior iteration used `audio.done` (verified to tear the stream down on every pause). The silence-injection approach was verified on stage: single WS survives pauses/mutes, each idle injection yields a `speech_final` within ~0.5s, no `1006` close. xAI's own `"ASR stream timed out"` on a long idle is still handled by the recoverable-reconnect path above
- xAI closes the ASR stream after a stretch of silence with `{type:error, message:"ASR stream timed out"}`. `handleMessage` detects this (message matches `/timed out/i`) and calls `onError('api_error', message, /* recoverable */ true)` (metric `errorType: 'stream_timeout'`); other `type:error` messages are non-recoverable (`errorType: 'api_error'`, `recoverable === false`). Either way the dead WS is still `close()`d — the in-place reconnect happens on the `OutgoingConnection` side (JIT-15901)
- `transcript.partial` with `speech_final=false` → interim; `transcript.partial` with `speech_final=true` → final (true utterance end); multiple `is_final=true` partials may arrive for a single utterance with accumulating text — only `speech_final=true` is the definitive end; `transcript.done` fires at stream end with empty text and is ignored
- Detected `language` is a BCP-47 code (e.g. `"en"`) and is present on `transcript.partial` events. It is passed through verbatim from xAI (no transformation)
- When `XAI_DIARIZE=true` and words carry `speaker` indices, results are split per speaker segment (same pattern as Deepgram)
- `XAI_INCLUDE_LANGUAGE=true` appends language suffix (e.g. `[en]`) to final transcript text; `language` field is always set on final messages when detected
- **Segmentation = `endpointing` (silence), not `smart_turn`.** `endpointing` (silence ms before a final) is **always sent**, default **850ms** (`XAI_ENDPOINTING`; xAI's own default of 10ms is far too choppy). `smart_turn` is end-of-turn detection for a *multi-speaker single stream*; we run one WS per participant (no turns), and enabling it holds finals across mid-sentence pauses → very long chunks. So `smart_turn`/`smart_turn_timeout` are **opt-in**: sent only when `XAI_SMART_TURN` is explicitly set (`config.xai.smartTurn` defaults to `undefined`). `smart_turn_timeout` (default 500) is only sent alongside `smart_turn`.
- All three segmentation knobs are **per-connection overridable** via URL query params — `endpointing`, `smart_turn`, `smart_turn_timeout` — flowing `ISessionParameters` (`xaiEndpointing`/`xaiSmartTurn`/`xaiSmartTurnTimeout`) → `TranscriberProxyOptions` → `BackendConfig`; `XAIBackend` resolves `backendConfig.xaiX ?? config.xai.X` (same pattern as `language`/`deepgram_mip_opt_out`)
- **Granular finalization (roll-own, `XAI_GRANULAR_FINALS`, default OFF):** xAI commits a final only on its end-of-turn `speech_final`, which re-emits the WHOLE turn at once — so a long speaker's turn lands in the stored transcript AFTER other participants' short acks (the GT-meeting ordering bug). When enabled, `XAIBackend` instead runs `XAIGranularSegmenter` (`src/backends/XAIGranularSegmenter.ts`): it reconstructs xAI's growing hypothesis from the interim stream (chunk_finals are segment-wise and interims reset after each — `mergeBase()` handles both that and a hypothetical cumulative provider), commits a **stable prefix** once it's been unchanged for `XAI_GRANULAR_STABILITY_MS` (default 1000) holding back `XAI_GRANULAR_GUARD_WORDS` (default 3) volatile words, and batches frozen words into `XAI_GRANULAR_MIN_WORDS` (default 5)-word segments emitted as finals (the in-progress remainder is emitted as an interim, Deepgram-style). The end-of-turn `speech_final` is **reconciled** — only the trailing words not already committed are flushed from its authoritative text, so the whole-turn re-emit is never reprinted; reconciliation only appends, so the sole correctness cost is a prefix word xAI revised after we froze it (measured **0 word-edits** across the whole tuned grid on 12 live captures — the "slower ⇒ fewer edits" framing is moot, the floor is already 0; slower only buys latency-margin). A non-empty `transcript.done` is routed through the segmenter only when a turn is still active (`hasActiveTurn()`) to avoid duplicating a turn already ended by `speech_final`. Granular finals are scoped to the **non-diarized** path (diarization needs per-speaker hypotheses → falls back to one-final-per-turn). DTX silence-injection `forceCommit()` and the recoverable stream-timeout reconnect are unchanged. Flag + the stability/guard knobs are overridable **per-connection** via `xai_granular_finals`/`xai_granular_stability_ms`/`xai_granular_guard_words` URL params (resolved `backendConfig.xaiGranularX ?? config.xai.granularX`); `XAI_GRANULAR_MIN_WORDS` is **global-only** (a batching detail, not per-connection). Tuned live in `unreal-agents/experiments/xai-vs-deepgram-finalization` (see `TUNING.md`)
- The CF Worker forwards `XAI_API_KEY` (as `''` when unset → provider disabled) plus any set `XAI_STT_URL`/`XAI_LANGUAGE`/`XAI_DIARIZE`/`XAI_INCLUDE_LANGUAGE`/`XAI_ENDPOINTING`/`XAI_SMART_TURN`/`XAI_SMART_TURN_TIMEOUT`/`XAI_GRANULAR_FINALS`/`XAI_GRANULAR_STABILITY_MS`/`XAI_GRANULAR_GUARD_WORDS`/`XAI_GRANULAR_MIN_WORDS` to the container via `buildContainerEnvVars`

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
- `index.ts` - Cloudflare Worker entry point (routing, container path, dispatcher forwarding)
- `ContainerCoordinator.ts` - Manages container routing (pool vs session mode)
- `handleTranslate.ts` - Worker-hosted `/translate` (no container; see Translation runtime abstraction)
- `translationRuntime.ts` / `outboundWebSocket.ts` / `opusWasmSource.ts` - the Worker `TranslationRuntime`
- Uses `@cloudflare/containers` to run the Node.js server for `/transcribe`

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
├── translatorproxy.ts         # /translate orchestration (runtime-agnostic core)
├── TranslatorConnection.ts    # One per (source, language) OpenAI realtime session
├── RtpTimestamper.ts          # Per-source RTP chunk/timestamp bookkeeping
├── serverInfo.ts              # Server `info` message builder (Node)
├── buildInfo.ts               # GIT_HASH baked in at bundle time
├── translate/
│   ├── runtime.ts             # TranslationRuntime injection boundary (worker-safe)
│   ├── nodeRuntime.ts         # Node adapter: config/Winston/OTLP/global WebSocket
│   ├── messages.ts            # Shared /translate wire-message builders (worker-safe)
│   ├── base64.ts              # Runtime-neutral base64 (native/injected fast paths)
│   └── emitter.ts             # Minimal event emitter (no node:events)
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
├── index.ts                   # Cloudflare Worker entry (routing, container path, dispatcher)
├── ContainerCoordinator.ts    # Container routing logic
├── handleTranslate.ts         # Worker-hosted /translate (WebSocketPair + TranslatorProxy)
├── translationRuntime.ts      # Worker TranslationRuntime (WASM codec, fetch-upgrade, info)
├── outboundWebSocket.ts       # Fetch-upgrade outbound WebSocket wrapped as IWebSocket
├── opusWasmSource.ts          # Import-loaded WASM binding for the Worker
└── env.d.ts                   # Worker Env types

scripts/check-worker-safe.mjs  # CI guard: the translation core must stay Worker-safe

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
npm run mix-audio -- /tmp/session123/media.jsonl output.wav
# Mixes all participant audio streams into a single WAV file
# Decodes via the OPUS_BACKEND-selected backend (default wasm); prefix OPUS_BACKEND=native to use the addon
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

**Info (sent once per connection, independent of `sendBack`):**
```json
{
  "event": "info",
  "application": "opus-transcriber-proxy",
  "gitHash": "c23ab2a",
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
An informational/observability message describing the running build and effective session config. Built by `src/serverInfo.ts` (`buildServerInfo`) and sent from `TranscriberProxy.sendServerInfo()` at the end of `setupWebSocketListeners()` (so on both initial connect and reattach). `gitHash` comes from `src/buildInfo.ts` — the `__GIT_HASH__` constant baked in at bundle time by `build.mjs` (esbuild `define`), falling back to the `GIT_HASH` env var then `'dev'` under tsx. The CF Worker augments the message **in-place** with a `worker` block (deployed worker version via the `version_metadata`/`CF_VERSION_METADATA` binding, edge `colo`/`country`/`city` from `request.cf`, `routingMode`) before forwarding it to the client. The client (JVB) may send its own `info` message (application/version/region); the proxy just logs it. An old client that doesn't know the `info` event type drops it harmlessly (its polymorphic parse fails and is caught).

The **Worker-hosted `/translate`** builds its own `info` in `worker/translationRuntime.ts` (`runtime: "cloudflare-worker"`, `gitHash`, fixed `provider: "openai"`, and a `worker` block with version/colo). It **intentionally omits** the Node message's `providersAvailable`, `config.*` (providersPriority, forceCommitTimeout, sessionResumeEnabled, useDispatcher) and `instanceId` fields — those describe transcription/container concepts that don't exist on this path. The message is informational only; the peer logs whatever it receives.

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
- `ENABLE_TRANSCRIBE` / `ENABLE_TRANSLATE` - Per-endpoint enablement (default: true each); a disabled endpoint's WS upgrade is rejected with 404
- `TRANSLATE_TRANSCRIPTS` - Emit target-language transcripts from `/translate` (default: true; false → translated audio only)
- `OPENAI_TRANSLATION_MODEL` - Speech-to-speech translation model (default: `gpt-realtime-translate`)
- `OPENAI_TRANSLATION_API_KEY` - Separate key for translation (default: falls back to `OPENAI_API_KEY`)
- `TRANSLATION_USAGE_URL` - Endpoint that receives live-translation audio-duration usage reports (see "Translation usage reporting"). Unset → usage reporting is a no-op (dev/replay runs and deployments without the endpoint cost nothing)
- `TRANSLATION_USAGE_REPORT_INTERVAL_MS` - Interval between periodic incremental usage reports for an open translation direction (default: 15000; `<= 0` disables the timer so only the final delta at close is reported). Resolved by both the Node and Worker translation runtimes
- `OPUS_BACKEND` - Opus codec backend: `wasm` (default; required in a Worker) or `native` (libopus addon, container-only, faster)

The CF Worker forwards `ENABLE_TRANSCRIBE`/`ENABLE_TRANSLATE`/`TRANSLATE_TRANSCRIPTS`/`OPENAI_TRANSLATION_MODEL`/`OPENAI_TRANSLATION_API_KEY` to the container (only when set, so container defaults apply otherwise) via `buildContainerEnvVars`.

### `/translate` transcript messages

`/translate` transcript messages use inner `type: "realtime-translation-result"` (so jitsi-meet recognizes them as a translation stream and does not render them in the CC panel like normal transcriptions) but keep outer `event: "transcription-result"` — JVB dispatches on `event` (via jicoco-mediajson) and forwards the payload, including the inner `type`, verbatim, so no JVB change is needed and old clients ignore the unrecognized `type`. Deltas are `is_interim: true`; the transcript-done event is final. Interims are sent to the client only when `sendBackInterim` is set. Note `sendBack` gates **transcripts only** on `/translate` — the translated **audio** (`media` events) is always returned to the bridge regardless of `sendBack`, since returning translated audio is the entire purpose of the endpoint (both `src/server.ts` and `worker/handleTranslate.ts`). The CF Worker dispatcher path forwards `realtime-translation-result` finals (in addition to `transcription-result`) to the dispatcher under `useDispatcher`; the Worker-hosted `/translate` forwards its finals to the per-session Dispatcher DO the same way (`worker/handleTranslate.ts`).

Both the Node server and the Worker handler build these messages via the shared builders in `src/translate/messages.ts` (`message_id` uses a per-connection sequence counter — never `Date.now()`, which collides for same-tag events within one millisecond), so the two serializers cannot drift.

## Keeping Documentation Current

When making code changes, update `CLAUDE.md` and `BACKENDS.md` in the same commit:

- **CLAUDE.md** — update the relevant Key Components description, Common Patterns section, or Notes for Claude whenever behaviour, interfaces, or invariants change.
- **BACKENDS.md** — update whenever the `TranscriptionBackend` interface changes, audio format negotiation behaviour changes, or backend-specific behaviour changes.

Do not leave stale descriptions. If a note says "only X happens" and you change it so Y also happens, fix the note.

## Notes for Claude

- Opus has two backends selected by `OPUS_BACKEND` (default `wasm`): WASM (Emscripten, `build:wasm`, needs Emscripten + the `src/OpusDecoder/opus` submodule) and native (node-gyp N-API addon, `build:native`, needs a C/C++ toolchain + python3 + the submodule). `OpusDecoder`/`OpusEncoder` are facades that dynamically import only the selected backend. If `native` fails to load at runtime, confirm `build/Release/opus_native.node` exists (`npm run build:native`) and that `src/OpusDecoder/nativeOpus.ts`'s candidate paths resolve; if `wasm` fails, confirm `dist/opus-*.{cjs,wasm}` exist (`npm run build:wasm`). The Docker image ships both; the container default is `wasm` (set `OPUS_BACKEND=native` to opt in).
- SIMD is selected at runtime (libopus RTCD on x86; NEON baseline on aarch64). Never add `-msse*`/`-mavx*` to the base `libopus` target or to global cflags — those flags must stay confined to their per-ISA static_library targets in `binding.gyp`, or the addon may execute instructions the CPU lacks.
- When modifying backends, ensure they handle connection lifecycle correctly (pending → connected → failed/closed).
- Session resumption means a `TranscriberProxy` may exist without an active WebSocket connection.
- Each participant creates its own `OutgoingConnection` and backend connection to the provider.
- The `tag` field identifies a participant's media source within a session. Format is a sourceId — `{id}-{mediaType}` (e.g. `abc123-a0`, where the suffix encodes media type: `a`=audio, `v`=video) or just `{id}`. The hex `{id}` prefix is parsed out (via `/^([0-9a-fA-F]+)-/`) as the participant id, while the full tag is retained on `participant.tag`. Tags whose prefix isn't hex fall back to `id === tag === <whole tag>`.
- Deepgram is the only backend that supports raw Opus/Ogg pass-through (controlled by `DEEPGRAM_ENCODING`, default `opus`). It returns the input encoding unchanged from `getDesiredAudioFormat()` when pass-through is active. The old `wantsRawOpus()` method has been replaced by `getDesiredAudioFormat()`.
- `openai_custom` is a provider that reuses `OpenAIBackend` but with a per-request WebSocket URL (from the `openaiCustomUrl` URL query parameter) and API key (from the `X-Custom-Openai-Api-Key` HTTP header). It is gated by `ENABLE_OPENAI_CUSTOM_PROVIDER=true` (similar to `ENABLE_DUMMY_PROVIDER`). The URL and key are stored in `TranscriberProxyOptions` (`openaiCustomUrl`, `openaiCustomApiKey`) and passed to `BackendFactory.createBackend` via `OpenAICustomOptions`. `BackendFactory` instantiates `OpenAIBackend(tag, participantInfo, wsUrl, apiKey)` for this provider.
- `DecodedAudio.audioData` is a `Uint8Array` of raw bytes (PCM for decoded audio, raw frames for pass-through). The old `pcmData: Int16Array` field no longer exists.
- When adding a new backend, implement `getDesiredAudioFormat(inputFormat): AudioFormat`. Return `{ encoding: 'l16', sampleRate: 24000 }` for PCM or `{ ...inputFormat }` (shallow copy) for raw pass-through. Do not return the `inputFormat` reference directly. This method is called on every `reinitializeDecoder` call (not just once at construction), so it must be a pure function of `inputFormat` for a given backend configuration. If the method has connect-time side effects (like `DeepgramBackend` storing `negotiatedFormat`), it will also be called on any new backend instance before `connect()`, so those side effects will be applied correctly.
- `AudioFormat.encoding` is a lowercase union type: `'opus' | 'ogg' | 'l16'`. The client-facing `'ogg-opus'` value is normalised to `'ogg'` by `validateAudioFormat()`, and all incoming encodings are lowercased before validation so case-insensitive client values are accepted.
- `OggOpusDecapsulator` only requires an `OpusHead` packet when its first page is a beginning-of-stream page (Ogg `header_type & 0x02`). If the first page seen is a non-BOS page — which happens when a client reconnects and resumes an existing Ogg stream mid-way after a server/container restart, without replaying the headers — it logs a warning and decodes from that point instead of throwing. This matters for any backend that requests `l16` from `ogg` input (e.g. xAI always, Deepgram with `DEEPGRAM_ENCODING=linear16`), which routes audio through `CascadedDecoder(OggOpusDecapsulator → OpusAudioDecoder)`. Backends on the pass-through path (`PassThroughDecoder`) never hit this validation.
- `doClose()` is idempotent. Do not call it more than once expecting repeated side effects — the `isClosed` guard makes subsequent calls no-ops. Backend callbacks (`onClosed`, `onError`, etc.) are nulled before `close()` is called, so async backend events arriving after teardown are silently dropped.
