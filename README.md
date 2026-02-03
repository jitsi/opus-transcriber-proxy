# opus-transcriber-proxy

Real-time WebSocket transcription proxy supporting multiple speech-to-text backends. Routes audio to OpenAI, Deepgram, or Google Gemini and streams transcription results back to clients.

## Features

- **Multi-provider support** - OpenAI Realtime, Deepgram Nova, Google Gemini
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

# Build WASM decoder (first time only)
npm run configure  # Install Emscripten
npm run build:wasm

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

## Installation

### Prerequisites

- Node.js 22+
- Emscripten (for WASM compilation)

### Build

```bash
npm install
npm run configure   # Setup Emscripten (one-time)
npm run build       # Build WASM + TypeScript + bundle
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

### Provider Options

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_MODEL` | `gpt-4o-mini-transcribe` | OpenAI model |
| `DEEPGRAM_MODEL` | `nova-2` | Deepgram model |
| `DEEPGRAM_LANGUAGE` | `multi` | Language code or `multi` for auto |
| `DEEPGRAM_ENCODING` | `linear16` | `linear16`, `opus`, or `ogg-opus` |
| `GEMINI_MODEL` | `gemini-2.0-flash-exp` | Gemini model |

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
└── OpusDecoder/           # WASM Opus decoder
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
npm run mix-audio /tmp/session123/media.jsonl output.wav
```

See [WEBSOCKET_DUMP.md](WEBSOCKET_DUMP.md) and [AUDIO_MIXING.md](AUDIO_MIXING.md).

## Documentation

- [BACKENDS.md](BACKENDS.md) - Provider details and comparison
- [CLOUDFLARE_DEPLOYMENT.md](CLOUDFLARE_DEPLOYMENT.md) - Cloudflare setup
- [DISPATCHER_INTEGRATION.md](DISPATCHER_INTEGRATION.md) - External dispatcher
- [CONTAINER_ROUTING.md](CONTAINER_ROUTING.md) - Container routing modes
- [WEBSOCKET_DUMP.md](WEBSOCKET_DUMP.md) - Message debugging
- [AUDIO_MIXING.md](AUDIO_MIXING.md) - Audio extraction tool

## License

Apache 2.0
