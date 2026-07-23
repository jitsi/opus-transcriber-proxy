# opus-transcriber-proxy

Real-time WebSocket transcription proxy supporting multiple speech-to-text backends. Routes audio to OpenAI, Deepgram, Google Gemini, or xAI and streams transcription results back to clients.

## Features

- **Multi-provider support** - OpenAI Realtime, Deepgram Nova, Google Gemini, xAI Grok
- **Provider fallback** - Configurable priority order with automatic failover
- **Multi-participant sessions** - Single WebSocket handles multiple audio streams
- **Real-time streaming** - Interim and final transcription results
- **Flexible deployment** - Node.js standalone or Cloudflare Workers with Containers
- **Dispatcher integration** - Forward transcriptions to external services
- **Speaker identity** (optional) - Attribute utterances on a shared mic to known, enrolled speakers via voice fingerprints, off the transcription hot path (see [Speaker Identity](#speaker-identity-optional))
- **Audio debugging** - Dump and replay WebSocket sessions

## Quick Start

```bash
# Install dependencies
npm install

# Build the native Opus addon (first time only)
git submodule update --init src/OpusDecoder/opus
npm run build:native

# Set API key(s)
export OPENAI_API_KEY=sk-...
# or
export DEEPGRAM_API_KEY=...

# Start server
npm run dev
```

Connect via WebSocket:
```
ws://localhost:8080/transcribe?sessionId=test&sendBack=true
```

With tags (for provider-specific features like Deepgram tagging):
```
ws://localhost:8080/transcribe?sessionId=test&sendBack=true&tag=production&tag=region-us
```

## Installation

### Prerequisites

- Node.js 22+
- A C/C++ toolchain for the native Opus addon: a C/C++ compiler, `make`, and
  `python3` (node-gyp). macOS: `xcode-select --install`. Debian/Ubuntu:
  `apt-get install build-essential python3`.
- The libopus submodule: `git submodule update --init src/OpusDecoder/opus`.

(No Emscripten — Opus is compiled natively, not to WebAssembly.)

### Build

```bash
npm install
git submodule update --init src/OpusDecoder/opus
npm run build       # Build the native Opus addon + esbuild bundle
```

### Docker

```bash
npm run docker:build
npm run docker:run
```

The image is Debian-based (`node:22-bookworm-slim`), not Alpine: the optional speaker-identity path
uses `sherpa-onnx-node`, whose prebuilt native binaries are built against glibc (there is no musl
build). `docker:build` also runs `npm run fetch-models` to download the CAM++ embedding model
(architecture-independent, baked in via `COPY`, like the WASM artifacts). A bare `docker build` on its
own will fail at the model `COPY` step — run `npm run fetch-models` first (or use `npm run docker:build`).
The model + `sherpa-onnx-node` are only loaded at runtime when speaker identity is enabled.

## Configuration

Set environment variables or use a `.env` file:

### Provider Selection

| Variable | Default | Description |
|----------|---------|-------------|
| `PROVIDERS_PRIORITY` | `openai,deepgram,gemini` | Provider priority order |

### API Keys

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key |
| `DEEPGRAM_API_KEY` | Deepgram API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `XAI_API_KEY` | xAI API key |

### Provider Options

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_MODEL` | `gpt-4o-mini-transcribe` | OpenAI model |
| `DEEPGRAM_MODEL` | `nova-2` | Deepgram model |
| `DEEPGRAM_LANGUAGE` | `multi` | Language code or `multi` for auto |
| `DEEPGRAM_ENCODING` | `opus` | `opus` (pass raw Opus/Ogg through) or `linear16` (decode to PCM) |
| `DEEPGRAM_MIP_OPT_OUT` | `false` | `true` opts out of Deepgram's Model Improvement Program (adds `mip_opt_out=true`). Overridable per-connection via the `deepgram_mip_opt_out` URL query param. See https://dpgr.am/deepgram-mip |
| `GEMINI_MODEL` | `gemini-2.0-flash-exp` | Gemini model |
| `XAI_LANGUAGE` | (auto) | Language code (e.g. `en`, `fr`); omit for auto-detect |
| `XAI_DIARIZE` | `false` | Enable speaker diarization |
| `XAI_INCLUDE_LANGUAGE` | `false` | Append detected language to transcript text (e.g. `Hello [English]`) |
| `XAI_SMART_TURN` | `0.5` | Turn-end confidence threshold (0.0–1.0) |
| `XAI_SMART_TURN_TIMEOUT` | `500` | Max silence ms before forced turn end |
| `XAI_GRANULAR_FINALS` | `false` | Roll-own granular finalization — commit a stable prefix incrementally instead of one final per turn (fixes long-turn-vs-acks ordering). Overridable per-connection via the `xai_granular_finals` URL query param |
| `XAI_GRANULAR_STABILITY_MS` | `1000` | Debounce window: a word freezes after this many ms unchanged (per-connection: `xai_granular_stability_ms`) |
| `XAI_GRANULAR_GUARD_WORDS` | `3` | Volatile words held back at the growing edge (per-connection: `xai_granular_guard_words`) |
| `XAI_GRANULAR_MIN_WORDS` | `5` | Frozen words batched into segments of at least this size (or at a sentence end) |
| `XAI_STT_URL` | `wss://api.x.ai/v1/stt` | Override STT endpoint |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DEBUG` | `false` | Enable debug logging |
| `FORCE_COMMIT_TIMEOUT` | `2` | Seconds before finalizing pending audio |

### Dispatcher (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `USE_DISPATCHER` | `false` | Enable dispatcher forwarding |
| `DISPATCHER_WS_URL` | (empty) | Dispatcher WebSocket URL |
| `DISPATCHER_HEADERS` | `{}` | Auth headers (JSON) |

See [DISPATCHER_INTEGRATION.md](DISPATCHER_INTEGRATION.md) for details.

### Observability (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `OTLP_ENDPOINT` | (empty) | OTLP HTTP endpoint (disabled if empty) |
| `OTLP_ENV` | (empty) | Environment label |
| `OTLP_RESOURCE_ATTRIBUTES` | `{}` | Additional resource attributes (JSON) |
| `OTLP_HEADERS` | `{}` | Auth headers (JSON) |

See [OBSERVABILITY.md](OBSERVABILITY.md) for available metrics, queries, and authentication.

### Speaker Identity (Optional)

Identify *who* is speaking when several people share one microphone/endpoint (a meeting-room device,
a dial-in leg), and attribute each utterance to a known, enrolled participant. Provider-independent
and strictly off the transcription hot path — identity never blocks or breaks transcription.

**Off by default.** With `IDENTITY_ENABLED` unset the proxy behaves exactly as without this feature:
no extra work, no Cloudflare/native dependency loaded at runtime, live captions unchanged. Enable it
only where you have the stores below configured.

**How it works.** Segmentation comes from the *transcription backend's* per-word speaker labels (not
a local diarizer). For each speaker, a CAM++ voice embedding (via `sherpa-onnx-node`, in-process) is
matched — cosine — against a per-tenant [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/)
store. A per-endpoint `diarize` flag (on the `start` event) gates behaviour: `diarize: true` (room)
runs per-speaker identify; otherwise the endpoint's owner is enrolled in the background, guarded so a
second voice on a shared mic never pollutes one person's fingerprint. Results are written to the
transcript store only and kept out of the live captions.

> **Scope:** identity currently runs on the **xAI** backend only (it needs per-word timing + speaker
> labels on a 16 kHz PCM path). Other backends transcribe normally but are not attributed.

> **Biometric data:** voice fingerprints are personal data. Operators are responsible for retention
> and consent. Fingerprints are keyed per tenant; a delete path exists on the store.
>
> **PII on the wire:** the fingerprint key is the participant's **email**. A resolved speaker's email
> (and name) travels in the transcription/dispatcher payloads (container → Worker → dispatcher) and
> lands in the stored transcript's attribution. If that's not acceptable for your deployment, use an
> opaque key (hashed email / UUID) as the fingerprint identity instead of the raw email.

| Variable | Default | Description |
|----------|---------|-------------|
| `IDENTITY_ENABLED` | `false` | Master switch. When off, none of the below has any effect. |
| `VECTORIZE_ACCOUNT_ID` / `VECTORIZE_INDEX` / `VECTORIZE_API_TOKEN` | (unset) | Cloudflare Vectorize fingerprint store (v2 REST). All three required for the in-process path. |
| `EMBEDDING_MODEL` | `models/campplus.onnx` | CAM++ (3D-Speaker) embedding model path (fetched by `npm run fetch-models`, baked into the image). |
| `MATCH_THRESHOLD` | `0.5` | Min cosine to accept an open-set identity match. |
| `IDENTITY_TENANT` | `default` | Tenant used when a stream's identity isn't resolved from KV. |
| `IDENTITY_KV_ACCOUNT_ID` / `IDENTITY_KV_NAMESPACE_ID` / `IDENTITY_KV_API_TOKEN` | (unset) | Cloudflare KV (REST) holding per-participant identity (email/name/tenant from the join). Unset → no auto-enroll. |
| `IDENTITY_MAX_EMBED_SEC` | `4` | Cap on audio fed to a single embed — bounds the synchronous native inference so it can't stall the event loop. `<=0` disables. |
| `IDENTITY_ENROLL_MIN_SPEECH_SEC` | `8` | Min speech in a window before it may auto-enroll. |
| `IDENTITY_ENROLL_COOLDOWN_MS` | `20000` | Min gap between auto-enroll attempts per stream. |
| `IDENTITY_MAX_ENROLLS_PER_SESSION` | `10` | Cap on auto-enrolls per stream. |
| `IDENTITY_ENROLL_CONSISTENCY_SUBWINDOW_SEC` | `2` | Sub-window size for the single-mic guard. |
| `IDENTITY_ENROLL_CONSISTENCY_THRESHOLD` | `0.5` | Min pairwise cosine across sub-windows to accept a window as one voice. |
| `IDENTITY_ENROLL_CONSISTENCY_MAX_STRIKES` | `3` | Consecutive divergent (multi-voice) windows before enrollment is disabled for the stream. |
| `IDENTITY_SIDECAR_URL` | (unset) | Optional: use an **external** identity sidecar (`/identify` + `/enroll`) instead of the in-process path. See [`src/identity/SidecarClient.ts`](src/identity/SidecarClient.ts). |

## WebSocket Protocol

### Connection

```
ws://host:port/transcribe?sessionId=xxx&sendBack=true
```

**Query Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `sessionId` | (required) | Session identifier |
| `sendBack` | `false` | Return final transcriptions |
| `sendBackInterim` | `false` | Return interim transcriptions |
| `provider` | (auto) | Override provider selection |
| `encoding` | `opus` | Audio encoding: `opus` or `ogg-opus` |
| `lang` | (auto) | Language hint |
| `tag` | (none) | Session tags (multiple values supported, max 128 chars each) |

### Client Messages

**Start** (per participant/endpoint; opens/updates its stream):
```json
{
  "event": "start",
  "start": {
    "tag": "participant-id",
    "mediaFormat": { "encoding": "opus" },
    "diarize": true
  }
}
```
`diarize` is an optional per-endpoint boolean (overrides the global `XAI_DIARIZE` / `DEEPGRAM_DIARIZE`).
Set it `true` only for endpoints carrying multiple speakers (room systems, dial-in) — it drives both
backend diarization and the speaker-identity room path.

**Audio data:**
```json
{
  "event": "media",
  "media": {
    "tag": "participant-id",
    "chunk": 0,
    "timestamp": 1768341932,
    "payload": "base64-encoded-audio"
  }
}
```

**Ping:**
```json
{"event": "ping", "id": 123}
```

### Server Messages

**Transcription result:**
```json
{
  "type": "transcription-result",
  "is_interim": false,
  "transcript": [{"text": "hello world", "confidence": 0.98}],
  "participant": {"id": "participant-id"},
  "timestamp": 1768341932000,
  "language": "en"
}
```

When speaker identity is enabled, `transcription-result` messages may carry extra fields consumed by
the routing layer (the Cloudflare Worker) and normally invisible to clients:
`words` (per-word timing + `speaker`), `dispatchOnly` (store-only — a resolved-speaker final, kept out
of live captions), `noDispatch` (live-only — the raw mic-owner final, not stored), and
`attributionDeferred` (a secondary diarized final already attributed by a sibling). See
[CLAUDE.md](CLAUDE.md) for the store/live routing contract.

**Pong:**
```json
{"event": "pong", "id": 123}
```

## Supported Providers

| Provider | Features |
|----------|----------|
| **OpenAI** | Server VAD, confidence scores, streaming |
| **Deepgram** | Punctuation, diarization, code-switching, streaming |
| **Gemini** | Multimodal, multilingual |
| **xAI** | Smart turn detection, diarization, language auto-detect, streaming |

See [BACKENDS.md](BACKENDS.md) for detailed comparison and configuration.

## Deployment

### Node.js

```bash
npm start
```

### Docker

```bash
docker build -t opus-transcriber-proxy .
docker run -p 8080:8080 -e OPENAI_API_KEY=sk-... opus-transcriber-proxy
```

### Cloudflare Workers

```bash
npm run cf:deploy
```

See [CLOUDFLARE_DEPLOYMENT.md](CLOUDFLARE_DEPLOYMENT.md) for setup instructions.

## Development

```bash
npm run dev          # Dev server with hot reload
npm run test         # Run tests
npm run typecheck    # Type checking
```

### Project Structure

```
src/
├── server.ts              # HTTP/WebSocket server
├── transcriberproxy.ts    # Main proxy orchestration
├── OutgoingConnection.ts  # Per-participant backend handler
├── config.ts              # Configuration
├── backends/              # Transcription backends
│   ├── OpenAIBackend.ts
│   ├── DeepgramBackend.ts
│   └── GeminiBackend.ts
├── OpusDecoder/           # Native Opus decoder wrapper + addon loader
└── OpusEncoder/           # Native Opus encoder wrapper
native/                    # Native Opus N-API addon (libopus, built by node-gyp)
worker/
└── index.ts               # Cloudflare Worker entry
```

### Adding a Backend

1. Create `src/backends/YourBackend.ts` implementing `TranscriptionBackend`
2. Add configuration to `src/config.ts`
3. Register in `src/backends/BackendFactory.ts`

See [BACKENDS.md](BACKENDS.md) for the template and details.

## Debugging

### Dump WebSocket Messages

```bash
DUMP_WEBSOCKET_MESSAGES=true npm run dev
# Messages saved to /tmp/{sessionId}/media.jsonl
```

### Replay Recorded Session

```bash
node scripts/replay-dump.cjs media.jsonl "ws://localhost:8080/transcribe?sendBack=true"
```

### Mix Recorded Audio

```bash
npm run mix-audio -- /tmp/session123/media.jsonl output.wav
```

See [WEBSOCKET_DUMP.md](WEBSOCKET_DUMP.md) and [AUDIO_MIXING.md](AUDIO_MIXING.md).

## Documentation

- [BACKENDS.md](BACKENDS.md) - Provider details and comparison
- [CLOUDFLARE_DEPLOYMENT.md](CLOUDFLARE_DEPLOYMENT.md) - Cloudflare setup
- [DISPATCHER_INTEGRATION.md](DISPATCHER_INTEGRATION.md) - External dispatcher
- [CONTAINER_ROUTING.md](CONTAINER_ROUTING.md) - Container routing modes
- [OBSERVABILITY.md](OBSERVABILITY.md) - Metrics and monitoring
- [WEBSOCKET_DUMP.md](WEBSOCKET_DUMP.md) - Message debugging
- [AUDIO_MIXING.md](AUDIO_MIXING.md) - Audio extraction tool

## License

Apache 2.0
