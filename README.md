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

### Text translation (`/transcribe`)

This feature translates the **text** from the transcriber into a set of target languages. It sends
the translations with the original transcript. It is not the same as `/translate` above, which
translates speech to speech.

Do not configure the target languages here. The bridge sends the set in the `sources` control event.
Jicofo makes the set from the languages that the participants request. Jicofo sends a new set each
time a participant changes the subtitle language. The proxy translates the final results only. It
does not translate interim results.

For each final result, the proxy makes one call for each target language. These calls run in
parallel. If one call is slow, or if it fails, the original transcript is not delayed and the other
languages are not stopped.

There are five providers. Four of them translate. One of them is for tests only.

| Provider | API | Context | Billing |
|----------|-----|---------|---------|
| `openai` | Chat Completions (`/v1/chat/completions`) | Yes | Per token |
| `xai` | Chat Completions (`https://api.x.ai/v1/chat/completions`) | Yes | Per token |
| `gemini` | Generative Language API (`generateContent`) | Yes | Per token |
| `google` | Cloud Translation v2 (dedicated machine translation) | **No** | Per character |
| `stub` | none — puts the target language before the text (`"hello"` → `"[FR] hello"`) | No | Free |

"Context" means that the provider gets the recent turns of the conversation with the text to
translate. One sentence alone is often not enough to select the correct pronoun, the correct gender
or the correct level of formality. The `google` provider works on one sentence at a time. It ignores
the history and the speaker labels.

The proxy selects the provider in the same way as for transcription. Set the order in
`TEXT_TRANSLATION_PROVIDERS_PRIORITY`. The first provider in the list that has an API key becomes
the default. Each connection can select a different provider with the `text_translation_provider`
URL parameter.

If the parameter gives a provider that is not valid or not available, the proxy writes an error
message and uses the default. The proxy does not close the connection. Text translation is an
addition to the session, and it must not stop transcription.

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_TEXT_TRANSLATION` | `false` | Translate final transcripts into the requested target languages. If this is `false`, the proxy ignores the requested languages and writes a log message |
| `TEXT_TRANSLATION_PROVIDERS_PRIORITY` | `openai,gemini,xai,google` | Provider order. The first available provider is the default. The providers that use context are first, because `google` cannot use context |
| `ENABLE_TEXT_TRANSLATION_STUB` | `false` | Make the `stub` provider available. Keep it `false` in a deployment |
| `TEXT_TRANSLATION_HISTORY_TURNS` | `6` | How many earlier final results to send as context. `0` disables the context |
| `TEXT_TRANSLATION_HISTORY_MAX_CHARS` | `2000` | Maximum total characters of the context. The proxy removes the oldest turns first |
| `TEXT_TRANSLATION_INCLUDE_SPEAKERS` | `true` | Send a speaker label with each turn (`Speaker 1`, `Speaker 2`). The label is a per-session number, not a display name. The proxy always removes the label from the translated text. Set this to `false` to keep the label out of the request also |
| `TEXT_TRANSLATION_TIMEOUT_MS` | `10000` | Timeout for one translation request. The proxy discards a translation that is too late |
| `TEXT_TRANSLATION_TEMPERATURE` | (unset) | `temperature` for the LLM providers. Unset means the model default, which is 1. A value of `0` makes the translations more repeatable, but the GPT-5 and Grok 4 model families reject a value that is not 1 |
| `TEXT_TRANSLATION_REASONING_EFFORT` | (unset) | `reasoning_effort` for the `openai` and `xai` providers. Use it if the configured model does reasoning by default |
| `TEXT_TRANSLATION_MAX_OUTPUT_TOKENS` | (unset) | `max_completion_tokens` for the `openai` and `xai` providers. Be careful: a reasoning model can use a small limit for reasoning tokens only, and then return no text |
| `TEXT_TRANSLATION_OPENAI_API_KEY` | (falls back to `OPENAI_API_KEY`) | Key for the `openai` provider |
| `TEXT_TRANSLATION_OPENAI_MODEL` | `gpt-4o-mini` | Model for the `openai` provider. Measured against the API: 0.5 s to 1.2 s for one translation, and no reasoning tokens. `gpt-5-nano` costs less per token, but it used ~750 reasoning tokens for the same prompt (~6 s) |
| `TEXT_TRANSLATION_OPENAI_URL` | `https://api.openai.com/v1/chat/completions` | Endpoint for the `openai` provider |
| `TEXT_TRANSLATION_XAI_API_KEY` | (falls back to `XAI_API_KEY`) | Key for the `xai` provider |
| `TEXT_TRANSLATION_XAI_MODEL` | `grok-4.20-0309-non-reasoning` | Model for the `xai` provider. This is the variant that does no reasoning. The Grok 4 reasoning models used 3 s to 17 s for one translation |
| `TEXT_TRANSLATION_XAI_URL` | `https://api.x.ai/v1/chat/completions` | Endpoint for the `xai` provider |
| `TEXT_TRANSLATION_GEMINI_API_KEY` | (falls back to `GEMINI_API_KEY`) | Key for the `gemini` provider |
| `TEXT_TRANSLATION_GEMINI_MODEL` | `gemini-3.5-flash-lite` | Model for the `gemini` provider. Measured against the API: 0.4 s to 0.8 s for one translation, with no thinking tokens. Do not use a 2.5 model. The API lists them, but it refuses them for a new key ("no longer available to new users") |
| `TEXT_TRANSLATION_GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Base URL for the `gemini` provider |
| `TEXT_TRANSLATION_GEMINI_THINKING_BUDGET` | (unset) | `thinkingConfig.thinkingBudget` for the `gemini` provider, where `0` disables thinking. This is the control for the 2.x models. A 3.x model rejects it with HTTP 400 |
| `TEXT_TRANSLATION_GEMINI_THINKING_LEVEL` | (unset) | `thinkingConfig.thinkingLevel` for the `gemini` provider (for example `low`). This is the control for the 3.x models. The default model does no thinking, so you do not usually need either control |
| `TEXT_TRANSLATION_GOOGLE_API_KEY` | (unset) | API key for the `google` provider. This must be a Google Cloud API key that has the Cloud Translation API enabled. There is **no** fallback to `GEMINI_API_KEY`, because Cloud Translation is a different API and a Gemini key is not valid for it |
| `TEXT_TRANSLATION_GOOGLE_CREDENTIALS_JSON` | (falls back to `GOOGLE_CREDENTIALS_JSON`) | Service-account JSON key for the `google` provider, as an alternative to the API key. Cloud Translation v2 also accepts an OAuth2 token, so a deployment that has a service account does not need a new API key. The API key has precedence if you set both. If you set neither, the `google` provider is not available |
| `TEXT_TRANSLATION_GOOGLE_URL` | `https://translation.googleapis.com/language/translate/v2` | Endpoint for the `google` provider |

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
