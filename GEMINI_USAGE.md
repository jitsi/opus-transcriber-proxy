# Using Gemini for Translation

The translation service now supports both OpenAI and Google Gemini providers, controlled by a single environment variable.

## Quick Start

### 1. Set the Translation Provider

Add to your `wrangler.toml`:

```toml
[vars]
TRANSLATION_PROVIDER = "gemini"  # or "openai" (default)
```

Or set as an environment variable:

```bash
# For local development
export TRANSLATION_PROVIDER=gemini

# For production (Cloudflare)
wrangler secret put TRANSLATION_PROVIDER
```

### 2. Add Your Gemini API Key

```bash
wrangler secret put GEMINI_API_KEY
```

### 3. Use the `/translate` Endpoint

Both providers use the same endpoint - the provider is automatically selected based on `TRANSLATION_PROVIDER`:

```bash
wscat -c "wss://your-worker.workers.dev/translate?sendBack=true"
```

## Provider Comparison

| Feature | OpenAI | Gemini |
|---------|--------|--------|
| **Model** | `gpt-4o-realtime` | `gemini-2.0-flash-exp` |
| **Input Sample Rate** | 24kHz | 16kHz |
| **Output Sample Rate** | 24kHz | 24kHz |
| **Auth Method** | WebSocket subprotocol | Query parameter |
| **Response Style** | Streaming deltas | Turn-based (complete responses) |
| **Voice Selection** | Supported (alloy, echo, etc.) | N/A |

## How It Works

The `TranslateProxy` class automatically creates the appropriate connection type based on the `TRANSLATION_PROVIDER` environment variable:

```typescript
// In translateproxy.ts
const provider = this.env.TRANSLATION_PROVIDER || 'openai';

const newConnection = provider === 'gemini'
    ? new GeminiTranslateConnection(tag, this.env, { ... })
    : new TranslateConnection(tag, this.env, { ... });
```

Both connection types implement the same interface:
- `handleMediaEvent(mediaEvent)` - Process incoming Opus audio
- `onTranscription` - Callback for transcription results
- `onAudioFrame` - Callback for translated audio frames
- `onError` - Callback for errors
- `onClosed` - Callback for connection closure

## Configuration

### OpenAI Configuration
```toml
[vars]
TRANSLATION_PROVIDER = "openai"
OPENAI_API_KEY = "sk-..."  # or use wrangler secret
OPENAI_MODEL = "gpt-4o-realtime"  # optional
```

### Gemini Configuration
```toml
[vars]
TRANSLATION_PROVIDER = "gemini"
GEMINI_API_KEY = "..."  # or use wrangler secret
```

## Audio Processing Pipeline

### OpenAI Path
1. **Input**: Opus frames @ 48kHz
2. **Decode**: Opus → PCM16 @ 24kHz
3. **Send**: Base64-encoded PCM to OpenAI
4. **Receive**: Streaming audio deltas from OpenAI @ 24kHz
5. **Encode**: PCM → Opus @ 24kHz
6. **Output**: Base64-encoded Opus frames

### Gemini Path
1. **Input**: Opus frames @ 48kHz
2. **Decode**: Opus → PCM16 @ 16kHz (resampled)
3. **Send**: Base64-encoded PCM chunks to Gemini
4. **Receive**: Complete audio responses @ 24kHz
5. **Encode**: PCM → Opus @ 24kHz
6. **Output**: Base64-encoded Opus frames

## Metrics

Both providers track their own metrics:

### OpenAI Metrics
- `openai_audio_queued` - Audio queued before connection ready
- `openai_audio_sent` - Audio chunks sent to OpenAI
- `openai_api_error` - API and connection errors

### Gemini Metrics
- `gemini_audio_queued` - Audio queued before setup complete
- `gemini_audio_sent` - Audio chunks sent to Gemini
- `gemini_api_error` - API and connection errors

### Shared Metrics
- `opus_packet_received` - Incoming packets from client
- `opus_packet_decoded` - Successfully decoded packets
- `opus_decode_failure` - Decoding failures
- `opus_loss_concealment` - Packet loss concealment

## Testing

### Test with OpenAI
```bash
# Set environment
export TRANSLATION_PROVIDER=openai
export OPENAI_API_KEY=sk-...

# Run locally
npm run dev

# Connect
wscat -c "ws://localhost:8787/translate?sendBack=true"
```

### Test with Gemini
```bash
# Set environment
export TRANSLATION_PROVIDER=gemini
export GEMINI_API_KEY=...

# Run locally
npm run dev

# Connect
wscat -c "ws://localhost:8787/translate?sendBack=true"
```

## Switching Providers

You can switch providers without any code changes:

```bash
# Switch to Gemini
wrangler secret put TRANSLATION_PROVIDER
# Enter: gemini

# Switch back to OpenAI
wrangler secret put TRANSLATION_PROVIDER
# Enter: openai

# Or use vars in wrangler.toml for non-sensitive configuration
```

## Advanced: Provider-Specific Features

### OpenAI-Specific: Voice Selection
When using OpenAI, you can specify a voice via query parameter:

```bash
wscat -c "wss://your-worker.workers.dev/translate?voice=nova&sendBack=true"
```

Available voices: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`

### Gemini-Specific: Model Selection
The Gemini model is hardcoded to `gemini-2.0-flash-exp` but can be modified in `GeminiTranslateConnection.ts` if needed.

## Troubleshooting

### Provider Not Switching
1. Verify the environment variable is set correctly:
   ```bash
   wrangler secret list
   ```
2. Check the logs for "Creating [provider] translation connection"
3. Restart the worker after changing secrets

### Audio Quality Issues
- **OpenAI**: Try adjusting the `voice` parameter or check input audio quality
- **Gemini**: Note that input is resampled from 24kHz to 16kHz, which may affect quality

### Connection Errors
- **OpenAI**: Verify `OPENAI_API_KEY` is set correctly
- **Gemini**: Verify `GEMINI_API_KEY` is set correctly and has API access enabled

Check metrics for specific error counts:
```bash
# View errors in Cloudflare dashboard
# Analytics > Workers Analytics > Metrics
```

## Implementation Details

The implementation maintains a unified interface while adapting to each provider's protocol:

**OpenAI Protocol:**
- Setup: `session.update` message
- Input: `input_audio_buffer.append` with base64 PCM
- Output: `response.output_audio.delta` streaming

**Gemini Protocol:**
- Setup: `setup` message, wait for `setupComplete`
- Input: `realtime_input.media_chunks` with PCM and mime type
- Output: `serverContent.modelTurn.parts` with audio and text

Both are transparent to the application layer - all you need to do is set `TRANSLATION_PROVIDER`.
