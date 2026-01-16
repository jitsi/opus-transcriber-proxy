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
TRANSCRIPTION_BACKEND=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-transcribe
OPENAI_TRANSCRIPTION_PROMPT="Your custom prompt here"
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
TRANSCRIPTION_BACKEND=gemini
GEMINI_API_KEY=your-key-here
GEMINI_MODEL=gemini-2.0-flash-exp
GEMINI_TRANSCRIPTION_PROMPT="Your custom prompt here"
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
TRANSCRIPTION_BACKEND=deepgram
DEEPGRAM_API_KEY=your-key-here
DEEPGRAM_MODEL=nova-2
DEEPGRAM_PUNCTUATE=true
DEEPGRAM_DIARIZE=false
```

**Models:**
- `nova-2` - Latest and most accurate (recommended)
- `nova` - Previous generation
- `enhanced` - Enhanced general model
- `base` - Fastest, lower cost

**Technical Details:**
- Uses WebSocket API: `wss://api.deepgram.com/v1/listen`
- Streams raw PCM audio directly (linear16 encoding)
- Audio sent at 24kHz, 16-bit, mono PCM
- Returns both interim and final transcriptions
- Supports KeepAlive, Finalize, and CloseStream control messages
- Authentication via Sec-WebSocket-Protocol header
- Defaults to `language=multi` for automatic multilingual detection (supports 31+ languages with Nova-3)
- Generates unique UUID for each transcription message

## Architecture

### Backend Interface
All backends implement the `TranscriptionBackend` interface:

```typescript
interface TranscriptionBackend {
  // Lifecycle
  connect(config: BackendConfig): Promise<void>;
  close(): void;
  getStatus(): 'pending' | 'connected' | 'failed' | 'closed';

  // Audio
  sendAudio(audioBase64: string): Promise<void>;
  forceCommit(): void;

  // Configuration
  updatePrompt(prompt: string): void;

  // Callbacks
  onInterimTranscription?: (message: TranscriptionMessage) => void;
  onCompleteTranscription?: (message: TranscriptionMessage) => void;
  onError?: (errorType: string, errorMessage: string) => void;
}
```

### Audio Format
All backends receive **24 kHz, 16-bit, mono PCM audio** encoded as base64 strings.

The opus-transcriber-proxy handles:
1. Receiving Opus-encoded packets from clients
2. Decoding to PCM
3. Sending PCM to the transcription backend

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
import type { TranscriptionBackend, BackendConfig } from './TranscriptionBackend';
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

  async sendAudio(audioBase64: string): Promise<void> {
    if (this.status !== 'connected') {
      throw new Error('Backend not connected');
    }

    // Send audio to your transcription service
    // Format: 24kHz, 16-bit, mono PCM (base64-encoded)
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
  transcriptionBackend: (process.env.TRANSCRIPTION_BACKEND || 'openai') as 'openai' | 'gemini' | 'yourbackend',

  // ... existing config ...

  yourbackend: {
    apiKey: process.env.YOURBACKEND_API_KEY || '',
    model: process.env.YOURBACKEND_MODEL || 'default-model',
    transcriptionPrompt: process.env.YOURBACKEND_TRANSCRIPTION_PROMPT || undefined,
  },
} as const;

// Add validation
if (config.transcriptionBackend === 'yourbackend' && !config.yourbackend.apiKey) {
  throw new Error('YOURBACKEND_API_KEY environment variable is required');
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
# Set backend in .env
TRANSCRIPTION_BACKEND=yourbackend
YOURBACKEND_API_KEY=...

# Run the server
npm start

# Test with real audio or replay a dump
cd ../transcription-experiments
node scripts/replay-dump.cjs standup-2026-01-14/recording/media.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true"
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
