# Audio Mixing Script

The `mix-audio.mjs` script decodes Opus-encoded audio from `media.jsonl` dump files and mixes multiple audio streams into a single WAV file.

## Usage

```bash
node scripts/mix-audio.mjs [input.jsonl] [output.wav]
```

**Arguments:**
- `input.jsonl` - Path to media.jsonl dump file (default: `media.jsonl`)
- `output.wav` - Path to output WAV file (default: `output.wav`)

**Example:**
```bash
# Mix audio from a session dump
node scripts/mix-audio.mjs /tmp/session123/media.jsonl recording.wav
```

## How It Works

1. **Reads media.jsonl** - Parses the JSONL file containing base64-encoded Opus packets
2. **Groups by tag** - Organizes audio packets by participant tag (e.g., "abc123-456")
3. **Sorts by timestamp** - Orders packets chronologically within each stream
4. **Decodes Opus** - Decodes each Opus packet to PCM audio at 24 kHz
5. **Synchronizes streams** - Uses timestamps to align audio from multiple participants on a global timeline
6. **Inserts silence** - Fills gaps with silence samples for proper temporal alignment
7. **Mixes audio** - Combines multiple streams by summing samples (with clipping protection)
8. **Writes WAV** - Outputs a standard WAV file (24 kHz, 16-bit, mono)

## Technical Details

### Audio Format
- **Input:** Base64-encoded Opus packets (assumed 20ms each)
- **Output:** WAV file, 24 kHz sample rate, 16-bit PCM, mono
- **Packet duration:** 20ms = 480 samples at 24 kHz

### RTP Timestamps
- Media packets contain RTP timestamps from the original stream
- These are in 48 kHz clock units (48,000 ticks per second)
- Timestamps can be very large (billions) as they represent absolute RTP clock time
- For a 1-minute session, timestamps might range from ~8,000,000,000 to ~8,003,000,000
- The script handles this by working with relative offsets from the earliest timestamp

### Synchronization
- Uses timestamps from the media packets to align streams on a global timeline
- Timestamps are RTP timestamps in 48 kHz units (increments of 1/48000 seconds)
- These can be very large numbers (billions), so the script works with relative offsets
- Conversion process:
  1. Find earliest timestamp across all participants
  2. Convert timestamp to milliseconds: `timestamp / 48.0`
  3. Calculate relative time: `(timestamp_ms - start_ms)`
  4. Convert to sample offset: `relative_time_ms / 1000 * 24000`
- Automatically fills gaps between packets with silence (zeros)
- Each participant's audio is positioned exactly where it occurred in real time

### Mixing Algorithm
- Simple additive mixing: `output[i] = stream1[i] + stream2[i] + ...`
- Clipping protection: values clamped to 16-bit signed range [-32768, 32767]
- No automatic gain control or normalization

## Prerequisites

The WASM module must be built before running this script:

```bash
npm run build:wasm
```

## Example Session

```bash
# Enable dump in .env
DUMP_WEBSOCKET_MESSAGES=true

# Run server and generate some audio
npm start

# Mix the recorded audio
node scripts/mix-audio.mjs /tmp/abc123/media.jsonl conference-call.wav

# Play the result
afplay conference-call.wav  # macOS
# or
aplay conference-call.wav   # Linux
```

## Output

The script provides progress information:
```
Reading from /tmp/session123/media.jsonl...
Found 2 audio stream(s)
Initializing Opus decoder...
Decoding audio packets...
  Stream abc123-1: timestamps 1234567890 to 1234571890 (150 packets)
    Successfully decoded 150 packets
  Stream abc123-2: timestamps 1234568000 to 1234571800 (140 packets)
    Successfully decoded 140 packets

Global timestamp range: 1234567890 to 1234571890
Output duration: 4.02 seconds (96480 samples, 4020ms)
Mixing audio streams...
Mixed 139200 total samples from 2 stream(s)

Writing WAV file to output.wav...
Done! Output file size: 0.19 MB
```

## Troubleshooting

**Error: "Failed to load OpusDecoder module"**
- Make sure to build the WASM module: `npm run build:wasm`

**Error: "No media packets found in input file"**
- Check that the input file contains media events with the `event: "media"` field
- Verify the file is a valid JSONL file (one JSON object per line)

**Error: "The value of 'value' is out of range" with large numbers**
- This has been fixed in the latest version of the script
- RTP timestamps can exceed 32-bit integer limits (8+ billion)
- The script now properly converts timestamps to relative offsets
- If you still see this error, make sure you're using the latest version of mix-audio.mjs

**Audio sounds choppy or distorted**
- This is expected with simple additive mixing when multiple participants speak simultaneously
- The mixing algorithm doesn't perform automatic gain control
- You may want to normalize the output using an audio tool like `ffmpeg`:
  ```bash
  ffmpeg -i output.wav -af loudnorm output-normalized.wav
  ```

**Silence at the beginning/end**
- The script aligns all streams to the global timestamp range
- Participants who join late or leave early will have silence in those periods
- This is intentional to preserve temporal alignment based on actual packet timestamps
- The output starts at the earliest packet timestamp and ends at the latest packet timestamp

## Advanced Usage

### Convert to MP3
```bash
# Mix to WAV first
node scripts/mix-audio.mjs session.jsonl output.wav

# Convert to MP3
ffmpeg -i output.wav -codec:a libmp3lame -qscale:a 2 output.mp3
```

### Extract single participant
To extract a single participant's audio without mixing, you can filter the media.jsonl file first:

```bash
# Extract packets for a specific tag
grep '"tag":"participant-id-123"' /tmp/session123/media.jsonl > participant-123.jsonl

# Mix just that participant
node scripts/mix-audio.mjs participant-123.jsonl participant-123.wav
```

Or modify the script to filter by tag during the reading phase.

### Adjust sample rate
The output sample rate is hardcoded to 24 kHz (matching the server configuration). To change it, you would need to resample the decoded audio before mixing.
