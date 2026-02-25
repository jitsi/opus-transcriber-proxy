# Transcription Backends

opus-transcriber-proxy uses an abstract backend system that allows you to choose different transcription services. This makes it easy to:
- Switch between providers
- Compare transcription quality across different services
- Add new transcription providers

## Available Backends

### OpenAI (Default)
Uses OpenAI's Realtime API for low-latency streaming transcription.

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
DEEPGRAM_ENCODING=linear16        # Audio encoding: linear16 (PCM) or opus (default: linear16)
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
- Audio encoding options (via `DEEPGRAM_ENCODING` env var or `encoding` URL parameter):
  - **linear16** (default): Sends decoded PCM audio at 24kHz, 16-bit, mono. Uses more CPU for Opus decoding but universally compatible.
  - **opus**: Sends raw Opus frames at 48kHz. More efficient (skips decoding step), lower CPU usage, native Opus support.
  - **ogg-opus**: Sends containerized Ogg-Opus audio (e.g., from Voximplant). Deepgram auto-detects encoding from the container header - no `encoding` or `sample_rate` params are sent to Deepgram.
- Returns both interim and final transcriptions
- Supports KeepAlive, Finalize, and CloseStream control messages
- Authentication via Sec-WebSocket-Protocol header
- Multilingual streaming support:
  - Defaults to `language=multi` for automatic multilingual code-switching (31+ languages with Nova-3)
  - Can specify single language (e.g., `en`, `es`, `fr`, `de`, `pt`, etc.)
  - Automatically adds `endpointing=100` for multilingual mode (recommended for code-switching)
  - Optional: Include detected language in transcript (e.g., `"Hello [en]"`) via `DEEPGRAM_INCLUDE_LANGUAGE=true`
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

## Architecture

### Backend Interface
All backends implement the `TranscriptionBackend` interface:

```typescript
interface AudioFormat {
  encoding: string;   // e.g. 'L16', 'opus', 'ogg'
  channels?: number;
  sampleRate?: number;
}

interface BackendConfig {
  language: string | null;
  prompt?: string;
  model?: string;
  encoding?: string;  // Audio encoding hint from client connection
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

  // Format negotiation — called once before the decoder is created
  getDesiredAudioFormat(inputFormat: AudioFormat): AudioFormat;

  // Configuration
  updatePrompt(prompt: string): void;

  // Callbacks
  onInterimTranscription?: (message: TranscriptionMessage) => void;
  onCompleteTranscription?: (message: TranscriptionMessage) => void;
  onError?: (errorType: string, errorMessage: string) => void;
  onClosed?: () => void;
}
```

### Audio Format Negotiation

`OutgoingConnection` calls `backend.getDesiredAudioFormat(inputFormat)` once when the backend is
initialized. The returned `AudioFormat` tells `AudioDecoderFactory` what to produce:

```
Client audio (ogg-opus / raw opus)
        ↓
OutgoingConnection calls getDesiredAudioFormat(inputFormat)
        ↓
AudioDecoderFactory.createAudioDecoder(inputFormat, desiredFormat)
        ↓
  outputFormat.encoding === 'opus' or 'ogg'  →  PassThroughDecoder (no decode)
  outputFormat.encoding === 'L16'            →  OpusAudioDecoder   (decode to PCM)
        ↓
sendAudio() called with base64-encoded bytes in the negotiated format
```

**PCM mode (default):** Return `{ encoding: 'L16', sampleRate: 24000 }` to receive decoded
24 kHz, 16-bit, mono PCM. Used by OpenAI and Gemini.

**Raw pass-through mode:** Return the input encoding unchanged (mirror `inputFormat.encoding`)
to skip decoding entirely. Useful when the provider natively supports the client's format.
Deepgram uses this for `opus` and `ogg` input, avoiding unnecessary decode/re-encode overhead.

Example implementations:

```typescript
// Always want PCM (OpenAI, Gemini)
getDesiredAudioFormat(_inputFormat: AudioFormat): AudioFormat {
  return { encoding: 'L16', sampleRate: 24000 };
}

// Pass through raw audio when possible (Deepgram)
getDesiredAudioFormat(inputFormat: AudioFormat): AudioFormat {
  if (inputFormat.encoding === 'opus' || inputFormat.encoding === 'ogg') {
    return inputFormat;  // skip decoding
  }
  return { encoding: 'L16', sampleRate: 24000 };
}
```

**Encoding values** used internally (note: the client-facing `ogg-opus` value is mapped to `ogg`
by `OutgoingConnection.updateInputFormat()` before it reaches `getDesiredAudioFormat`):

| Value  | Description |
|--------|-------------|
| `L16`  | 16-bit linear PCM, little-endian |
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
  onError?: (errorType: string, errorMessage: string) => void;

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

  getDesiredAudioFormat(_inputFormat: AudioFormat): AudioFormat {
    // Return the format you want to receive.
    // For PCM (most backends):
    return { encoding: 'L16', sampleRate: 24000 };
    // For raw pass-through (if your provider supports Opus/Ogg natively):
    // if (_inputFormat.encoding === 'opus' || _inputFormat.encoding === 'ogg') {
    //   return _inputFormat;
    // }
    // return { encoding: 'L16', sampleRate: 24000 };
  }

  async sendAudio(audioBase64: string): Promise<void> {
    if (this.status !== 'connected') {
      throw new Error('Backend not connected');
    }

    // Send audio to your transcription service.
    // Format matches what getDesiredAudioFormat() returned:
    //   L16  → 24kHz, 16-bit, mono PCM (base64-encoded)
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

export function createBackend(tag: string, participantInfo: any): TranscriptionBackend {
  const backendType = config.transcriptionBackend;

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

export function getBackendConfig(): BackendConfig {
  const backendType = config.transcriptionBackend;

  switch (backendType) {
    // ... existing cases ...
    case 'yourbackend':
      return {
        language: null,
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
   - Retry transient errors

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
