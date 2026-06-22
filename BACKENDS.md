# Transcription Backends

opus-transcriber-proxy uses an abstract backend system that allows you to choose different transcription services. This makes it easy to:
- Switch between providers
- Compare transcription quality across different services
- Add new transcription providers

## Available Backends

### OpenAI (Default)
Uses OpenAI's Realtime API for low-latency streaming transcription.

### OpenAI Custom
Re-uses the OpenAI Realtime API backend but connects to a custom WebSocket URL with per-request credentials. Useful for proxies, self-hosted compatible endpoints, or when different sessions need different API keys.

**How it works:**
- Identical to the `openai` backend in all respects (same protocol, same audio format, same session configuration)
- The WebSocket URL and API key are supplied per-request rather than from environment variables

**Per-request configuration:**
| Source | Parameter | Description |
|--------|-----------|-------------|
| URL query param | `openaiCustomUrl` | WebSocket URL to connect to (e.g. `wss://your-proxy/v1/realtime?intent=transcription`) |
| HTTP header | `X-Custom-Openai-Api-Key` | API key for authentication |

Both values are required; if either is missing the backend connection will fail.

**Configuration:**
```bash
# Enable the openai_custom provider (required)
ENABLE_OPENAI_CUSTOM_PROVIDER=true

# Require wss:// scheme for the openaiCustomUrl parameter (default: true)
# Set to false to allow unencrypted ws:// connections (not recommended in production)
OPENAI_CUSTOM_REQUIRE_WSS=false

# Optionally set openai_custom as the default provider
PROVIDERS_PRIORITY=openai_custom,openai,deepgram,gemini
```

**Usage (per-session via URL):**
```
ws://host/transcribe?sendBack=true&provider=openai_custom&openaiCustomUrl=wss://...
# Also pass the X-Custom-Openai-Api-Key HTTP header on the WebSocket upgrade request
```

The global `OPENAI_MODEL` and `OPENAI_TRANSCRIPTION_PROMPT` environment variables are used as defaults for model and prompt, same as for the `openai` provider.

**Features:**
- WebSocket-based streaming
- Interim and final transcriptions
- Server-side VAD (Voice Activity Detection)
- Low latency (~200-500ms)
- Confidence scores (via logprobs)
- Language detection and multilingual support

**Configuration:**
```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-transcribe
OPENAI_TRANSCRIPTION_PROMPT="Your custom prompt here"

# Make OpenAI the default provider
PROVIDERS_PRIORITY=openai,deepgram,gemini
```

**Models:**
- `gpt-4o-mini-transcribe` - Faster, lower cost
- `gpt-4o-transcribe` - Higher quality

### Google Gemini
Uses Google's Gemini WebSocket-based BidiGenerateContent API for transcription.

**Features:**
- WebSocket-based streaming (similar to OpenAI)
- Multimodal understanding
- Good multilingual support
- Streams PCM audio directly without batching

**Configuration:**
```bash
GEMINI_API_KEY=your-key-here
GEMINI_MODEL=gemini-2.0-flash-exp
GEMINI_TRANSCRIPTION_PROMPT="Your custom prompt here"

# Make Gemini the default provider
PROVIDERS_PRIORITY=gemini,openai,deepgram
```

**Models:**
- `gemini-2.0-flash-exp` - Fast, experimental (recommended for transcription)
- `gemini-1.5-pro` - More stable
- `gemini-1.5-flash` - Faster alternative

**Note:** Native audio models (`gemini-2.5-flash-native-audio-*`) are designed for audio output (TTS/voice conversations) and will fail with transcription since we request TEXT output. Use `gemini-2.0-flash-exp` for transcription.

**Technical Details:**
- Uses WebSocket API: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`
- API version: v1beta (more stable than v1alpha, BidiGenerateContent not available in stable v1)
- Streams raw PCM audio directly (no WAV conversion needed)
- Audio sent at 24kHz (Gemini's native rate is 16kHz, but it handles 24kHz)
- Returns complete transcriptions only (no interim results like OpenAI)
- Setup message sent once at connection time (prompts cannot be updated mid-stream)

### Deepgram
Uses Deepgram's WebSocket streaming API for real-time transcription.

**Features:**
- WebSocket-based streaming
- Interim and final transcriptions
- Very low latency (~300ms)
- Confidence scores
- Diarization (speaker identification)
- Punctuation
- Language detection and multilingual support
- One WebSocket connection per participant

**Configuration:**
```bash
DEEPGRAM_API_KEY=your-key-here
DEEPGRAM_MODEL=nova-2
DEEPGRAM_ENCODING=opus            # Audio encoding: opus (default, passes raw Opus/Ogg) or linear16 (decoded PCM)
DEEPGRAM_LANGUAGE=multi           # Multilingual code-switching (default)
DEEPGRAM_INCLUDE_LANGUAGE=true    # Append language to transcript (e.g., "Hello [en]")
DEEPGRAM_PUNCTUATE=true
DEEPGRAM_DIARIZE=false
DEEPGRAM_TAGS=production,region-us  # Comma-separated tags for all sessions (max 128 chars each)

# Make Deepgram the default provider
PROVIDERS_PRIORITY=deepgram,openai,gemini
```

**Models:**
- `nova-2` - Latest and most accurate (recommended)
- `nova` - Previous generation
- `enhanced` - Enhanced general model
- `base` - Fastest, lower cost

**Technical Details:**
- Uses WebSocket API: `wss://api.deepgram.com/v1/listen`
- Audio encoding options (via `DEEPGRAM_ENCODING` env var):
  - **opus** (default): Passes the client's raw audio directly to Deepgram without decoding. When the client sends raw Opus frames (`?encoding=opus`) Deepgram receives raw Opus at 48kHz; when the client sends Ogg-Opus (`?encoding=ogg-opus`) Deepgram receives the Ogg container and auto-detects the encoding from the header. More efficient (skips decoding), lower CPU usage.
  - **linear16**: Decodes audio to PCM at 24kHz, 16-bit, mono before sending to Deepgram. Higher CPU usage but universally compatible.
- Returns both interim and final transcriptions
- Supports KeepAlive, Finalize, and CloseStream control messages
- Authentication via Sec-WebSocket-Protocol header
- Multilingual streaming support:
  - Defaults to `language=multi` for automatic multilingual code-switching (31+ languages with Nova-3)
  - Can specify single language (e.g., `en`, `es`, `fr`, `de`, `pt`, etc.)
  - Automatically adds `endpointing=100` for multilingual mode (recommended for code-switching)
  - The detected language is always set as the `language` property on the transcription event when provided by Deepgram (applies to both standard and diarized paths), regardless of `DEEPGRAM_INCLUDE_LANGUAGE`
  - Optional: Also append language as a text suffix (e.g., `"Hello [en]"`) via `DEEPGRAM_INCLUDE_LANGUAGE=true`
  - **Note**: `detect_language` parameter is NOT supported for streaming (only for pre-recorded audio)
- Generates unique UUID for each transcription message
- **Tagging support**:
  - Tags can be set via `DEEPGRAM_TAGS` environment variable (comma-separated, applies to all sessions)
  - Tags can be added per-session via URL parameters: `tag=value` (multiple parameters supported)
  - URL tags are combined with environment tags and sent to Deepgram's API
  - Useful for organizing and filtering transcription requests in Deepgram's dashboard
  - **Validation**: Each tag must be ≤ 128 characters (enforced at connection time)
  - Invalid tags will cause the WebSocket connection to be rejected with a descriptive error
  - Example: `ws://host/transcribe?sessionId=test&tag=production&tag=region-us&tag=customer-service`

### xAI
Uses xAI's WebSocket STT streaming API for real-time transcription.

**Features:**
- WebSocket-based streaming
- Interim and final transcriptions
- Smart turn detection (configurable confidence threshold + timeout)
- Confidence scores (word-level, averaged per segment)
- Diarization (speaker identification)
- Language auto-detection (reported on final transcription)
- One WebSocket connection per participant

**Configuration:**
```bash
XAI_API_KEY=your-key-here
XAI_LANGUAGE=                     # Language code (e.g. en, fr, de); omit for auto-detect
XAI_INCLUDE_LANGUAGE=true         # Append language to transcript (e.g., "Hello [en]")
XAI_DIARIZE=false                 # Enable speaker diarization
XAI_ENDPOINTING=850               # Silence ms before a final (utterance segmentation); always sent; default 850
XAI_SMART_TURN=                   # End-of-turn confidence (0.0–1.0); OPT-IN, unset = disabled (only for multi-speaker single streams; we run one stream per participant)
XAI_SMART_TURN_TIMEOUT=500        # Max silence ms before forced speech_final; only sent when XAI_SMART_TURN is set; default 500
XAI_GRANULAR_FINALS=false         # Roll-own granular finalization: commit a stable prefix incrementally instead of one final per turn (fixes long-turn-vs-acks ordering); default OFF
XAI_GRANULAR_STABILITY_MS=1000    # Debounce: a word freezes after this many ms unchanged; default 1000
XAI_GRANULAR_GUARD_WORDS=3        # Volatile words held back at the growing edge; default 3
XAI_GRANULAR_MIN_WORDS=5          # Frozen words are batched into >= this many-word segments (or at a sentence end); default 5
XAI_STT_URL=wss://api.x.ai/v1/stt  # Override STT endpoint (optional)

# Make xAI the default provider
PROVIDERS_PRIORITY=xai,openai,deepgram,gemini
```

**Supported languages:** `en`, `fr`, `de`, `ja`, `zh`, `hi`, `ko`, `ru`, `ar-EG`, `ar-SA`, `ar-AE`, `bn`, `id`, `it`, `pt-BR`, `pt-PT`, `es-MX`, `es-ES`, `tr`, `vi`

**Technical Details:**
- Uses WebSocket API: `wss://api.x.ai/v1/stt`; all config via URL query parameters
- Authentication via `Authorization: Bearer` header (passed using Node.js/CF Workers-specific third constructor argument)
- Always receives signed 16-bit LE PCM at 24kHz (raw binary frames, not base64)
- `transcript.partial` events → interim transcriptions; optionally split by speaker when `XAI_DIARIZE=true`
- `transcript.done` event → final transcription; includes detected `language` field
- Detected language is always set as the `language` property on final transcription events; `XAI_INCLUDE_LANGUAGE=true` additionally appends it as text suffix (e.g. `[en]`) — these are independent behaviours (same as Deepgram)
- Diarization splits messages by consecutive speaker segments; each message carries a `speaker: number` field (same as Deepgram)
- `forceCommit()` finalizes the trailing utterance when the stream goes idle **without closing the connection**, by injecting a short tail of digital silence (`endpointing` + 300ms). xAI has no flush/commit message — only `audio.done`, which closes the WS (code 1006) and forces a full teardown + cold-start of the next utterance. Since finals are driven by `endpointing` (VAD emits `speech_final` after that many ms of silence), and a paused/muted client sends no frames for the VAD to act on, we feed it silence so it finalizes the pending utterance while the WS stays open. (#94 made this a no-op → trailing utterance unfinalized; an `audio.done` iteration → stream torn down on every pause.) xAI's own `"ASR stream timed out"` on a long idle is handled by the recoverable-reconnect path
- **Segmentation:** finals are driven by `endpointing` (silence ms; always sent, default `850` via `XAI_ENDPOINTING`). `smart_turn` (end-of-turn detection for a multi-speaker single stream) is **opt-in / disabled by default** — we run one stream per participant, so it has no turns to detect and only delays finals across mid-sentence pauses. `endpointing`, `smart_turn`, and `smart_turn_timeout` are also overridable **per-connection** via URL query params (resolved as `backendConfig.xaiX ?? config.xai.X`)
- **Granular finalization (`XAI_GRANULAR_FINALS`, default OFF):** by default xAI emits one final per turn (only on end-of-turn `speech_final`, which re-emits the whole turn), so a long turn lands in the stored transcript after other speakers' short acks. When enabled, `XAIGranularSegmenter` reconstructs xAI's growing hypothesis from the interim stream and commits a **stable prefix** once it's been unchanged for `XAI_GRANULAR_STABILITY_MS` (default 1000), holding back `XAI_GRANULAR_GUARD_WORDS` (default 3) volatile words, batched into `XAI_GRANULAR_MIN_WORDS` (default 5)-word segments emitted as finals — so the long turn interleaves in order (Deepgram-style: the in-progress remainder is emitted as an interim). The end-of-turn `speech_final` is **reconciled** (only the uncommitted trailing remainder is flushed from its authoritative text — the whole-turn re-emit is never reprinted; reconciliation only appends). A non-empty `transcript.done` is deduped via `hasActiveTurn()`. Scoped to the **non-diarized** path; `forceCommit()` DTX silence-injection and the stream-timeout reconnect are unchanged. Flag + stability/guard knobs are per-connection overridable (`xai_granular_finals`/`xai_granular_stability_ms`/`xai_granular_guard_words`); `min_words` is global-only (`XAI_GRANULAR_MIN_WORDS`, a batching detail, not a correctness knob). Defaults tuned live (0 word-edits, first commit ~2.9s vs ~29s before); see `unreal-agents/experiments/xai-vs-deepgram-finalization/TUNING.md`
- No model selection for the STT endpoint (model is inherent to the service)

## Architecture

### Backend Interface
All backends implement the `TranscriptionBackend` interface:

```typescript
interface AudioFormat {
  encoding: 'l16' | 'opus' | 'ogg';
  channels?: number;
  sampleRate?: number;
}

interface BackendConfig {
  language?: string;
  prompt?: string;
  model?: string;
  tags?: string[];
}

interface TranscriptionBackend {
  // Lifecycle
  connect(config: BackendConfig): Promise<void>;
  close(): void;
  getStatus(): 'pending' | 'connected' | 'failed' | 'closed';

  // Audio
  sendAudio(audioBase64: string): Promise<void>;
  forceCommit(): void;

  // Format negotiation — called on every reinitializeDecoder (initial setup, on updateInputFormat,
  //   and again on any new backend instance created by reconnectBackend)
  getDesiredAudioFormat(inputFormat: AudioFormat): AudioFormat;

  // Configuration
  updatePrompt(prompt: string): void;

  // Callbacks
  onInterimTranscription?: (message: TranscriptionMessage) => void;
  onCompleteTranscription?: (message: TranscriptionMessage) => void;
  onError?: (errorType: string, errorMessage: string, recoverable?: boolean) => void;
  onClosed?: () => void;
}
```

### Audio Format Negotiation

`OutgoingConnection` calls `backend.getDesiredAudioFormat(inputFormat)` on every
`reinitializeDecoder` call — at initial setup and whenever `updateInputFormat()` is called.
The returned `AudioFormat` tells `AudioDecoderFactory` what to produce:

```
Client audio (ogg-opus / raw opus / l16 / …)
        ↓
OutgoingConnection calls getDesiredAudioFormat(inputFormat)
        ↓
  desiredFormat differs from previous?  →  close old backend, open fresh one
        ↓
AudioDecoderFactory.createAudioDecoder(inputFormat, desiredFormat)
        ↓
  outputFormat.encoding === 'opus' or 'ogg'  →  PassThroughDecoder (no decode)
  outputFormat.encoding === 'l16'            →  OpusAudioDecoder   (decode to PCM)
        ↓
sendAudio() called with base64-encoded bytes in the negotiated format
```

If the desired format changes between calls (e.g. input switches from `opus` to `l16` and
Deepgram now wants `linear16` instead of `opus`), `OutgoingConnection` closes the old backend
connection and opens a fresh one before creating the new decoder. This means `getDesiredAudioFormat`
must be a **pure function of `inputFormat`** for a given backend configuration.

If your backend stores the result as a side effect for use in `connect()` (like `DeepgramBackend`
stores `negotiatedFormat` to build the WebSocket URL), that side effect will be re-applied when
`getDesiredAudioFormat` is called on the new backend instance, so the behaviour is correct.

**PCM mode (default):** Return `{ encoding: 'l16', sampleRate: 24000 }` to receive decoded
24 kHz, 16-bit, mono PCM. Used by OpenAI and Gemini.

**Raw pass-through mode:** Return the input encoding unchanged (mirror `inputFormat.encoding`)
to skip decoding entirely. Useful when the provider natively supports the client's format.
Deepgram uses this for `opus` and `ogg` input, avoiding unnecessary decode/re-encode overhead.

Example implementations:

```typescript
// Always want PCM (OpenAI, Gemini)
getDesiredAudioFormat(_inputFormat: AudioFormat): AudioFormat {
  return { encoding: 'l16', sampleRate: 24000 };
}

// Pass through raw audio when possible (Deepgram)
getDesiredAudioFormat(inputFormat: AudioFormat): AudioFormat {
  if (inputFormat.encoding === 'opus' || inputFormat.encoding === 'ogg') {
    return { ...inputFormat };  // shallow copy — do not return the input reference directly
  }
  return { encoding: 'l16', sampleRate: 24000 };
}
```

**Encoding values** used internally (note: the client-facing `ogg-opus` value is normalised to
`ogg` by `validateAudioFormat()` before it ever reaches `getDesiredAudioFormat`):

| Value  | Description |
|--------|-------------|
| `l16`  | 16-bit linear PCM, little-endian |
| `opus` | Raw Opus frames (no container) |
| `ogg`  | Ogg-Opus containerized audio |

**URL Parameter:** Clients can specify the audio encoding format via the `encoding` URL parameter:
- `encoding=opus` (default): Raw Opus frames at 48kHz
- `encoding=ogg-opus`: Containerized Ogg-Opus audio (e.g., from Voximplant)

Example: `wss://host/transcribe?transcribe=true&sendBack=true&encoding=ogg-opus`

### Transcription Messages
Backends must produce `TranscriptionMessage` objects:

```typescript
interface TranscriptionMessage {
  transcript: Array<{ text: string; confidence?: number }>;
  is_interim: boolean;  // true for partial results
  message_id: string;
  type: 'transcription-result';
  event: 'transcription-result';
  participant: { id: string; ssrc?: string };
  timestamp: number;
}
```

## Adding a New Backend

### 1. Create Backend Class

Create `src/backends/YourBackend.ts`:

```typescript
import type { TranscriptionBackend, BackendConfig, AudioFormat } from './TranscriptionBackend';
import type { TranscriptionMessage } from '../transcriberproxy';
import logger from '../logger';
import { config } from '../config';

export class YourBackend implements TranscriptionBackend {
  private status: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
  private backendConfig?: BackendConfig;
  private participantInfo: any;
  private tag: string;

  onInterimTranscription?: (message: TranscriptionMessage) => void;
  onCompleteTranscription?: (message: TranscriptionMessage) => void;
  onError?: (errorType: string, errorMessage: string, recoverable?: boolean) => void;

  constructor(tag: string, participantInfo: any) {
    this.tag = tag;
    this.participantInfo = participantInfo;
  }

  async connect(backendConfig: BackendConfig): Promise<void> {
    this.backendConfig = backendConfig;

    // Initialize your connection here
    // - Connect to your transcription service
    // - Set up message handlers
    // - Update this.status to 'connected'

    this.status = 'connected';
    logger.info(`Your backend connected for tag: ${this.tag}`);
  }

  getDesiredAudioFormat(inputFormat: AudioFormat): AudioFormat {
    // Return the format you want to receive.
    // For PCM (most backends):
    return { encoding: 'l16', sampleRate: 24000 };
    // For raw pass-through (if your provider supports Opus/Ogg natively):
    // if (inputFormat.encoding === 'opus' || inputFormat.encoding === 'ogg') {
    //   return { ...inputFormat };  // shallow copy — never return the reference directly
    // }
    // return { encoding: 'l16', sampleRate: 24000 };
  }

  async sendAudio(audioBase64: string): Promise<void> {
    if (this.status !== 'connected') {
      throw new Error('Backend not connected');
    }

    // Send audio to your transcription service.
    // Format matches what getDesiredAudioFormat() returned:
    //   l16  → 24kHz, 16-bit, mono PCM (base64-encoded)
    //   opus → raw Opus frames (base64-encoded)
    //   ogg  → Ogg-Opus container (base64-encoded)
  }

  forceCommit(): void {
    // Force transcription of pending audio
    // Called when audio stream goes idle
  }

  updatePrompt(prompt: string): void {
    // Update transcription prompt with new context
    // Used for transcript history injection
    this.backendConfig!.prompt = prompt;
  }

  close(): void {
    // Clean up connections
    this.status = 'closed';
  }

  getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
    return this.status;
  }

  private createTranscriptionMessage(
    transcript: string,
    confidence: number | undefined,
    timestamp: number,
    message_id: string,
    isInterim: boolean,
  ): TranscriptionMessage {
    return {
      transcript: [{ text: transcript, ...(confidence !== undefined && { confidence }) }],
      is_interim: isInterim,
      message_id,
      type: 'transcription-result',
      event: 'transcription-result',
      participant: this.participantInfo,
      timestamp,
    };
  }
}
```

### 2. Add Configuration

Update `src/config.ts`:

```typescript
export const config = {
  // ... existing config ...

  yourbackend: {
    apiKey: process.env.YOURBACKEND_API_KEY || '',
    model: process.env.YOURBACKEND_MODEL || 'default-model',
    transcriptionPrompt: process.env.YOURBACKEND_TRANSCRIPTION_PROMPT || undefined,
  },
} as const;

// Add to isProviderAvailable function
export function isProviderAvailable(provider: Provider): boolean {
  switch (provider) {
    // ... existing cases ...
    case 'yourbackend':
      return !!config.yourbackend.apiKey;
    default:
      return false;
  }
}
```

### 3. Register in Factory

Update `src/backends/BackendFactory.ts`:

```typescript
import { YourBackend } from './YourBackend';

export function createBackend(tag: string, participantInfo: any, provider?: Provider): TranscriptionBackend {
  const backendType = provider || getDefaultProvider();

  switch (backendType) {
    case 'openai':
      return new OpenAIBackend(tag, participantInfo);
    case 'gemini':
      return new GeminiBackend(tag, participantInfo);
    case 'yourbackend':
      return new YourBackend(tag, participantInfo);
    default:
      throw new Error(`Unknown transcription backend: ${backendType}`);
  }
}

export function getBackendConfig(provider?: Provider): BackendConfig {
  const backendType = provider || getDefaultProvider();

  switch (backendType) {
    // ... existing cases ...
    case 'yourbackend':
      return {
        language: undefined, // Will be set per-connection based on options
        prompt: config.yourbackend.transcriptionPrompt,
        model: config.yourbackend.model,
      };
    default:
      throw new Error(`Unknown transcription backend: ${backendType}`);
  }
}
```

### 4. Update Documentation

Add your backend to `.env.example` with configuration options and usage notes.

## Backend Comparison

### Latency

| Backend | Typical Latency | Notes |
|---------|----------------|-------|
| OpenAI  | 200-500ms | WebSocket streaming, very low latency |
| Deepgram | ~300ms | WebSocket streaming, very low latency |
| Gemini  | 3-4s | WebSocket streaming, slower responses |

### Quality

Quality varies based on:
- Audio quality and noise
- Speaker accent and language
- Model selection
- Prompt engineering

Run experiments using the `transcription-experiments` repo to compare quality for your use case.

### Cost

Costs vary significantly. Check current pricing:
- **OpenAI:** Based on audio duration (~$0.006/minute for Realtime API)
- **Deepgram:** Based on audio duration (~$0.0043/minute for Nova-2)
- **Gemini:** Based on API calls and input tokens

### Language Support

All backends support multiple languages with auto-detection:
- **OpenAI:** 50+ languages
- **Deepgram:** 35+ languages
- **Gemini:** 100+ languages (via Gemini's multimodal capabilities)

## Testing

Test your backend implementation:

```bash
# Configure API key
YOURBACKEND_API_KEY=...

# Make it the default provider
PROVIDERS_PRIORITY=yourbackend,openai,deepgram,gemini

# Run the server
npm start

# Test with real audio or replay a dump
cd ../transcription-experiments

# Use default provider
node scripts/replay-dump.cjs standup-2026-01-14/recording/media.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true"

# Or specify provider explicitly
node scripts/replay-dump.cjs standup-2026-01-14/recording/media.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true&provider=yourbackend"
```

## Best Practices

1. **Error Handling**
   - Call `onError` for connection failures
   - Handle API rate limits gracefully
   - For transient, stream-level errors that leave the participant active (e.g. xAI
     closing the ASR stream with `"ASR stream timed out"` after silence), call
     `onError(type, message, /* recoverable */ true)`. `OutgoingConnection` then
     reopens the backend in place (preserving the decoder, transcript history and
     negotiated format) instead of dropping the participant. Omit the third arg (or
     pass `false`) for fatal errors that should tear the connection down.

2. **Logging**
   - Use the logger from `src/logger.ts`
   - Log connection events (debug level)
   - Log errors (error level)

3. **Metrics**
   - Use `writeMetric` for tracking backend performance
   - Add backend-specific error types

4. **Cleanup**
   - Close connections properly in `close()`
   - Clear timers and intervals
   - Free resources

5. **Testing**
   - Test with real audio
   - Test error scenarios
   - Compare quality with other backends

## Troubleshooting

### Connection Failures

Check logs for specific error messages. Common issues:
- Invalid API key
- Network connectivity
- API quota exceeded
- Unsupported audio format

### High Latency

- **OpenAI:** Check network latency to OpenAI servers
- **Gemini:** Adjust `AUDIO_CHUNK_DURATION_MS` in `GeminiBackend.ts`

### Poor Quality

- Adjust transcription prompts
- Try different models
- Check audio quality (use `mix-audio.mjs` to listen to recorded audio)
- Run scoring experiments

## Future Backends

Potential backends to add:
- **Azure Speech Services** - Microsoft's speech-to-text API
- **AWS Transcribe** - Amazon's real-time transcription
- **AssemblyAI** - Specialized transcription API
- **Whisper** - Local/self-hosted OpenAI Whisper

Contributions welcome!
