# Health Check Client

A test client for verifying the transcription proxy is working. Streams an Ogg/Opus audio file and checks that transcriptions are returned.

## Usage

```bash
node test/stream-test.js --url <base-url> --file <ogg-file> [options]
```

## Options

| Option | Description |
|--------|-------------|
| `--url, -u` | Base WebSocket URL (required) |
| `--file, -f` | Ogg/Opus audio file (required) |
| `--tag, -t` | Participant tag (default: `health-check-<timestamp>`) |
| `--cf-id` | Cloudflare Access Client ID |
| `--cf-secret` | Cloudflare Access Client Secret |
| `--loop` | Loop audio continuously |
| `--timeout <sec>` | Wait time after streaming (default: 10) |
| `--verbose, -v` | Enable progress logging |
| `--interims` | Include interim transcriptions |

## Environment Variables

```bash
CF_ACCESS_CLIENT_ID      # Cloudflare Access Client ID
CF_ACCESS_CLIENT_SECRET  # Cloudflare Access Client Secret
```

## Exit Codes

- `0` - Success (received at least one transcription)
- `1` - Failure (no transcriptions, error, or timeout)

## Examples

### Health check (quiet, JSON output)

```bash
node test/stream-test.js \
  --url wss://your-transcriber.example.com/transcribe \
  --file test/test.ogg
```

### With Cloudflare Access

```bash
node test/stream-test.js \
  --url wss://your-transcriber.example.com/transcribe \
  --file test/test.ogg \
  --cf-id "$CF_ACCESS_CLIENT_ID" \
  --cf-secret "$CF_ACCESS_CLIENT_SECRET"
```

### Verbose output

```bash
node test/stream-test.js \
  --url wss://your-transcriber.example.com/transcribe \
  --file test/test.ogg \
  --verbose
```

### Local development

```bash
node test/stream-test.js \
  --url ws://localhost:8080/transcribe \
  --file test/test.ogg \
  --verbose --loop
```

## Output

JSON summary to stdout:

```json
{
  "success": true,
  "transcriptions": [
    {
      "text": "hello world",
      "interim": false,
      "participant": "health-check-abc123",
      "timestamp": 1234567890,
      "language": "en"
    }
  ],
  "metrics": {
    "durationMs": 15234,
    "connectLatencyMs": 145,
    "firstTranscriptionLatencyMs": 2341,
    "estimatedAudioDurationSec": 5.2,
    "chunksSent": 260,
    "bytesSent": 52000,
    "interimCount": 3,
    "finalCount": 1,
    "errors": []
  }
}
```

## Test Audio File

The `test.ogg` file is the "Speech, various bitrates" sample from the [Opus Codec examples page](https://opus-codec.org/examples/). It demonstrates Opus encoding at various bitrates from 8 kb/s to 64 kb/s.

**Source:** https://opus-codec.org/examples/
**License:** The opus-codec.org website is licensed under [CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/). The speech samples are provided for demonstration purposes; no explicit license is documented for the audio content itself.

## Creating Custom Test Audio

Convert any audio file to Ogg/Opus:

```bash
ffmpeg -i input.mp3 -c:a libopus -b:a 24k -ar 48000 -ac 1 test/test.ogg
```
