# opus-transcriber-proxy

Real-time WebSocket transcription proxy supporting multiple speech-to-text backends. Routes audio to OpenAI, Deepgram, Google Gemini, or xAI and streams transcription results back to clients.

## Features

- **Multi-provider support** - OpenAI Realtime, Deepgram Nova, Google Gemini, xAI Grok
- **Provider fallback** - Configurable priority order with automatic failover
- **Multi-participant sessions** - Single WebSocket handles multiple audio streams
- **Real-time streaming** - Interim and final transcription results
- **Flexible deployment** - Node.js standalone or Cloudflare Workers with Containers
- **Dispatcher integration** - Forward transcriptions to external services
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
| `XAI_CONNECT_ATTEMPTS` | `4` | Handshake attempts before a connect is reported failed. A rejected upgrade with a transient status (408/425/429/500/502/503/504, plus the Cloudflare origin-failure codes 521-526/530) or a pre-open transport error is retried; 401/403/400/404 fail fast |
| `XAI_CONNECT_BACKOFF_MS` | `250` | Base delay between handshake retries; doubles per attempt (±25% jitter, capped at 4s). A `Retry-After` on the rejection takes precedence, up to the same 4s cap — a longer one means no retry |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DEBUG` | `false` | Enable debug logging |
| `FORCE_COMMIT_TIMEOUT` | `2` | Seconds before finalizing pending audio |

### Translation (`/translate`)

Speech-to-speech translation via OpenAI's realtime translations endpoint (`gpt-realtime-translate`).

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_TRANSLATE` | `true` | Enable the `/translate` endpoint (disabled → its WebSocket upgrade is rejected with 404) |
| `TRANSLATE_TRANSCRIPTS` | `true` | Emit target-language transcripts (`false` → translated audio only) |
| `OPENAI_TRANSLATION_MODEL` | `gpt-realtime-translate` | Speech-to-speech translation model |
| `OPENAI_TRANSLATION_API_KEY` | (falls back to `OPENAI_API_KEY`) | Separate API key for translation |
| `TRANSLATION_USAGE_URL` | (unset) | Endpoint that receives translated-audio duration usage reports; unset → usage reporting is a no-op |
| `TRANSLATION_USAGE_REPORT_INTERVAL_MS` | `15000` | Interval between incremental usage reports for an open translation direction; `<= 0` reports only the final delta at close |
| `TRANSLATION_TALK_SILENCE_TIMEOUT_MS` | `350` | Silence (ms past projected media playout) before a translated "talk" ends and a `sending=false` notification is emitted to clients. Must exceed the 100 ms RtpTimestamper gap threshold; `<= 0` disables end-of-talk detection — unsafe on the translations endpoint (which sends no boundary event), where a talk would then never end until the connection closes |
| `SOURCE_IMAGE_TAG` | (unset) | Docker image tag the WASM Opus codec was sourced from. Set by the translate-Worker deploy (the only path that sets it in practice, since the codec is versioned independently of the worker code); the container leaves it unset because code and codec ship in one image. Whenever present in the environment it is surfaced as `sourceImageTag` in the `info` message so a code/WASM mismatch is visible against `gitHash`; not used at runtime |

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
