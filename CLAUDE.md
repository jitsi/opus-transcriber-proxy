# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a real-time WebSocket transcription proxy that routes audio (Opus or other formats) to multiple speech-to-text backends (OpenAI, Deepgram, Google Gemini, xAI, Mistral). It supports:
- Multi-participant sessions (one WebSocket handles multiple audio streams)
- Provider fallback with configurable priority
- Two deployment modes: Node.js standalone or Cloudflare Workers with Containers
- Session resumption (detach/reattach within grace period)
- Optional dispatcher forwarding and OTLP telemetry

## Build System

Opus has two interchangeable codec backends (`OPUS_BACKEND`: `wasm` default, `native` opt-in); build
prerequisites and the decoder/encoder design are in `docs/claude/audio-codec.md`.

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

`npm run typecheck` needs the WASM build: `src/OpusDecoder/wasmSourceNode.ts` imports `dist/opus-*.cjs`, so the check fails with "Cannot find module" until `npm run build:wasm` has run (for example in a fresh clone or a new worktree). Without Emscripten, run `npm run typecheck:worker` and `npm run check:worker-safe` instead. `typecheck:worker` type-checks the Worker and the code it imports, including the translation core. `check:worker-safe` is an import lint over the translation core files, not a type check.

CI runs only `check:worker-safe` and `typecheck:worker`. Neither vitest nor esbuild type-checks, so nothing in CI type-checks Node-only code such as `server.ts`, `transcriberproxy.ts` or `src/backends/*`. Before you push a change to Node-only code, build WASM and run the full `npm run typecheck`.

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
full 14-cell list and required API keys — `runtime=worker` only covers `/translate` (production
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

`npm run cf:deploy` / `npm run cf:tail`. The Worker code is in `worker/`. How production is really
deployed, the SDK caveats the Durable Object depends on, the start retry, routing modes and the KV
provider/config overrides are all in `docs/claude/cloudflare.md`. Read it before touching `worker/`.

## Architecture

Three WebSocket endpoints share one server (Node container) and, in the Cloudflare deployment, one Worker:

```
Bridge WebSocket
  /transcribe → TranscriberProxy → OutgoingConnection per participant → AudioDecoder → TranscriptionBackend → provider
                                  └→ textTranslate/ (finals → `translation` events, when ENABLE_TEXT_TRANSLATION)
  /translate  → TranslatorProxy → TranslatorConnection per (source, language) → OpenAI/xAI realtime → OpusEncoder → bridge
  /agent      → AgentProxy → customer voice-agent WebSocket (dial config from the provisioning API) → MediaPacer → bridge
```

Each endpoint has its own document under `docs/claude/` (table below). Cross-cutting facts:

- Every participant has its own `OutgoingConnection` and its own provider connection; a participant's
  failure is contained to that participant and never closes the session socket (JIT-16493).
- `doClose()` on every connection class is idempotent and detaches callbacks before teardown; async
  events arriving after teardown are dropped.
- The translation core (`TranslatorProxy`, `TranslatorConnection`, `RtpTimestamper`, `MediaPacer`) is
  runtime-agnostic and must stay Worker-safe (`npm run check:worker-safe`); host specifics are injected via
  `TranslationRuntime`.
- The `/transcribe` endpoint always runs in the container; in the Cloudflare deployment `/translate` is
  served by the Worker itself and `/agent` is Node-only.

## Which document to read

Load only the documents the task touches. Each one is self-contained for its area.

| Task touches | Read |
|---|---|
| `/transcribe` session handling: `transcriberproxy.ts`, `OutgoingConnection.ts`, `SessionManager.ts`, retry/backoff, session resume, force commit, `config.ts` | `docs/claude/transcription.md`; `DISPATCHER_INTEGRATION.md` for the dispatcher side |
| A transcription provider: `src/backends/*` (OpenAI, Deepgram, Gemini, xAI incl. long-turn cap and granular finals, Mistral), adding a backend | `docs/claude/transcription-backends.md`, then `BACKENDS.md` for measured provider behaviour |
| Audio formats, decoders, Opus WASM/native builds, `binding.gyp`, `native/`, `OpusEncoder`, audio levels | `docs/claude/audio-codec.md` |
| `/translate`: `translatorproxy.ts`, `TranslatorConnection.ts`, `RtpTimestamper.ts`, `MediaPacer.ts`, `src/translate/`, usage reporting, talk boundaries, pacing | `docs/claude/translate.md`, then `TRANSLATION_BACKENDS.md` |
| `/agent`: `agentproxy.ts`, `src/agent/`, dial config, SSRF guard, fan-in, agent media format | `docs/claude/agent.md`, then `AGENT_PROTOCOL.md` (media contract) and `AGENT_REST_API.md` (provisioning contract) |
| Text translation of transcripts: `src/textTranslate/`, `sources` requests, prompts | `docs/claude/text-translation.md` |
| Anything under `worker/`, `wrangler.jsonc`, deployment, KV provider or config overrides, container start failures | `docs/claude/cloudflare.md`; the operator guides `CLOUDFLARE_DEPLOYMENT.md`, `CONTAINER_ROUTING.md`, `AUTOSCALING.md` |
| Metrics, logging, OTLP, stale markers, the monitor sidecar, message dumps, replaying a session | `docs/claude/observability.md`; the user-facing `OBSERVABILITY.md`, `WEBSOCKET_DUMP.md`, `AUDIO_MIXING.md` |
| Wire messages on the bridge socket (`media`, `sources`, `transcription-result`, `translation-result`, `info`, pong), and how the JVB parses and forwards them (ping and reconnect, dropped events) | `docs/claude/protocol.md` |

Environment variables are listed per area in those documents; README.md has the complete reference.

The top-level `*.md` files other than this one are operator and integrator documentation linked from
README.md (plus the two frozen `/agent` contracts). They describe what the system does for its users;
`docs/claude/` describes why it is built the way it is. Keep both current, and do not merge them.

## File Organization

```
src/
├── server.ts                  # HTTP/WS server entry (Node.js)
├── monitor.ts                 # Synthetic health-check entrypoint (see docs/claude/observability.md)
├── transcriberproxy.ts        # Main proxy orchestration
├── translatorproxy.ts         # /translate orchestration (runtime-agnostic core)
├── TranslatorConnection.ts    # One per (source, language) OpenAI realtime session
├── RtpTimestamper.ts          # Per-source RTP chunk/timestamp bookkeeping
├── MediaPacer.ts              # Releases synthetic audio at real time + a lead (translate return path and /agent)
├── serverInfo.ts              # Server `info` message builder (Node)
├── buildInfo.ts               # GIT_HASH baked in at bundle time
├── translate/
│   ├── runtime.ts             # TranslationRuntime injection boundary (worker-safe)
│   ├── provider.ts            # The openai / xai speech-to-speech provider specs + resolution (worker-safe)
│   ├── nodeRuntime.ts         # Node adapter: config/Winston/OTLP/global WebSocket
│   ├── messages.ts            # Shared /translate wire-message builders (worker-safe)
│   ├── base64.ts              # Runtime-neutral base64 (native/injected fast paths)
│   ├── env.ts                 # Worker-safe env-var parsing (parseIntOr) shared by both runtimes
│   ├── timers.ts              # unrefTimer: the one timer-unref shim (core + XAIBackend)
│   └── emitter.ts             # Minimal event emitter (no node:events)
├── OutgoingConnection.ts      # Per-participant handler
├── AudioDecoder.ts            # AudioDecoder interface + DecodedAudio types
├── AudioDecoderFactory.ts     # Selects decoder based on format negotiation
├── L16Decoder.ts              # PCM l16 decoder (resample or identity)
├── PassThroughDecoder.ts      # Raw-audio pass-through (no decode)
├── SessionManager.ts          # Session lifecycle management
├── textTranslate/
│   ├── TextTranslator.ts      # TextTranslator interface + language-code helpers
│   ├── ConversationHistory.ts # Per-session context buffer + synthetic speaker labels
│   ├── prompt.ts              # Shared LLM prompt + output sanitizing
│   ├── http.ts                # postJson: the one HTTP shape every provider needs
│   ├── googleAuth.ts          # Service-account JWT -> OAuth token for Cloud Translation
│   ├── ChatCompletionsTextTranslator.ts  # openai + xai (OpenAI-shaped /chat/completions)
│   ├── GeminiTextTranslator.ts           # gemini (generateContent)
│   ├── GoogleTranslateTextTranslator.ts  # google (Cloud Translation v2, no context)
│   ├── StubTextTranslator.ts  # "hello" -> "[FR] hello" (no real translation)
│   ├── factory.ts             # Provider union, availability/priority, createTextTranslator
│   └── messages.ts            # translation-result wire-message builder
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
│   ├── MistralBackend.ts         # Mistral Voxtral realtime implementation
│   └── DummyBackend.ts           # Test/stats backend
├── OpusDecoder/
│   ├── OpusAudioDecoder.ts       # High-level AudioDecoder (gap detection + concealment)
│   ├── OpusDecoder.ts            # Low-level decoder wrapper (native libopus)
│   ├── nativeOpus.ts             # Loader + typed interface for the N-API addon
│   └── opus/                     # libopus source (submodule)
└── OpusEncoder/
    ├── OpusEncoder.ts            # Low-level encoder facade (native / WASM)
    └── audioLevel.ts             # RFC 6464 audio level of a PCM frame (worker-safe)

native/                        # Native Opus addon (compiled by node-gyp)
├── opus_addon.cc              # N-API wrapper (OpusDecoder + OpusEncoder classes)
└── opus-config/config.h       # Hand-written libopus build config
binding.gyp                    # node-gyp build: libopus + per-ISA SIMD + addon

worker/
├── index.ts                   # Cloudflare Worker entry: the fetch router + DO class re-exports
├── TranscriberContainer.ts    # The container Durable Object (passthrough fetch override, /status idle probe)
├── containerEnv.ts            # Container env vars, instance name, `worker` info block (pure functions)
├── routing.ts                 # selectContainerInstance (session / pool / shared / autoscale)
├── startRetry.ts              # Retry a container start that failed for a transient platform reason
├── metrics.ts                 # OTLP/HTTP delta counters pushed from the Worker (container start outcomes)
├── sessionProxy.ts            # handleWebSocketWithDispatcher: client<->container pipe, dispatcher queue, keepalive
├── closeCode.ts               # sendableCloseCode: the close codes workerd can put in a close frame
├── types.ts                   # Dispatcher / transcription message shapes
├── ContainerCoordinator.ts    # Container routing logic
├── handleTranslate.ts         # Worker-hosted /translate (WebSocketPair + TranslatorProxy)
├── dispatcherForwarder.ts     # /translate's Dispatcher DO socket (bounded queue, reconnect on next forward)
├── translationRuntime.ts      # Worker TranslationRuntime (WASM codec, fetch-upgrade, info)
├── outboundWebSocket.ts       # Fetch-upgrade outbound WebSocket wrapped as IWebSocket
├── opusWasmSource.ts          # Import-loaded WASM binding for the Worker
├── providerOverride.ts        # KV-backed provider overrides, one slot per multi-backend service (operator lever)
├── configOverride.ts          # KV-backed config overrides: config:<NAME> over the Worker variable (operator lever)
├── kvEntry.ts                 # KV entry parsing and the `until` check, shared by both kinds of override
├── vars.ts                    # Every Worker variable: container forwarding + KV overridability
└── env.d.ts                   # Worker Env types

scripts/check-worker-safe.mjs  # CI guard: the translation core must stay Worker-safe
scripts/check-license-headers.mjs  # CI guard: every source file carries the copyright notice

docs/claude/                   # Per-area guidance for Claude Code (see "Which document to read")
BACKENDS.md                    # Measured transcription-provider behaviour and the TranscriptionBackend contract
TRANSLATION_BACKENDS.md        # Measured speech-to-speech provider behaviour (/translate)
AGENT_PROTOCOL.md              # The frozen customer-leg wire contract (/agent)

test/
├── setup.ts                   # Vitest setup
├── unit/worker/               # Worker module tests (index, containerEnv, routing, TranscriberContainer, sessionProxy, dispatcherForwarder, startRetry, metrics)
├── helpers/                   # Test utilities
└── unit/                      # Unit tests
```

## Formatting

The existing code is not prettier-clean. Do not run `npm run format` or `prettier --write` on existing files: the diff reflows lines that the change does not touch. Match the style of the surrounding code by hand. Run prettier only on a `.ts` file that you add (`.prettierrc`: tabs, `printWidth` 140). The `format` glob (`**/*.{js,ts,css,json,md}`) does not include `.cjs` or `.mjs`. `scripts/replay-dump.cjs` is indented with 4 spaces by hand. Prettier still formats a `.cjs` file that you name explicitly and converts the whole file to tabs, so edit that file by hand. For any other new file (for example a `.md`, `.json` or `.mjs` file), match the nearest sibling by hand.

## Copyright notice

Every source file starts with the Apache 2.0 copyright notice used across Jitsi projects,
`Copyright @ <year> - present 8x8, Inc.`, where the year is the one the file was created (the files
that predate the notice carry 2025, the repository's first year). Copy the block from any `.ts` file,
or the `#` form from the `Makefile`. A shebang or the Dockerfile's `# syntax=` line stays first; the
notice follows. When you add a file, add the notice: `npm run check:license-headers` (run in CI)
fails on any tracked `.ts`, `.mts`, `.mjs`, `.cjs`, `.js`, `.c`, `.cc`, `.h`, `.jsonc`, `.yml`,
`.yaml`, `Dockerfile`, `Makefile` or `binding.gyp` whose leading comment block lacks one. Only the
generated `worker-configuration.d.ts` and the libopus submodule are exempt. Code adapted from
elsewhere keeps its upstream attribution under the notice and is listed in `NOTICE`, which the
Docker image ships under `licenses/` together with `LICENSE` and libopus's `COPYING`.

## Keeping Documentation Current

When making code changes, update the documentation in the same commit:

- **`CLAUDE.md`** — this file: the build, the architecture summary, the task table and the file layout. Keep it short; detail belongs in `docs/claude/`.
- **`docs/claude/<area>.md`** — the area document for the code you changed (see the table above): component descriptions, invariants, environment variables. These carry the "why" behind the current behaviour, including the incidents that shaped it; keep that when you edit.
- **`BACKENDS.md`** — whenever the `TranscriptionBackend` interface changes, audio format negotiation behaviour changes, or backend-specific behaviour changes.
- **`TRANSLATION_BACKENDS.md`** — the `/translate` counterpart: whenever `TranslationProviderSpec` changes, a speech-to-speech provider's measured behaviour or configuration changes, or the close/reopen rules change.

Do not leave stale descriptions. If a note says "only X happens" and you change it so Y also happens, fix the note. When adding a new area, add a document under `docs/claude/` and a row to the table above rather than growing this file.
