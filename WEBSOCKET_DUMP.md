# WebSocket Message & Transcript Dumping

This feature allows you to record all incoming WebSocket messages and transcripts for testing, debugging, and replay purposes.

## Configuration

Enable dumping by setting these environment variables:

```bash
# Enable WebSocket message dumping
DUMP_WEBSOCKET_MESSAGES=true

# Enable transcript dumping (default: false)
DUMP_TRANSCRIPTS=true

# Optional: specify base path (default: /tmp)
# Files will be written to $DUMP_BASE_PATH/$sessionId/
DUMP_BASE_PATH=/tmp
```

Files are organized by session ID:
- WebSocket messages: `/tmp/$sessionId/websocket-messages.jsonl`
- Transcripts: `/tmp/$sessionId/transcripts.jsonl`

## Output Format

All files are written in **JSONL** (JSON Lines) format - one JSON object per line.

### WebSocket Messages (`websocket-messages.jsonl`)

```json
{"timestamp":1768341932350,"direction":"incoming","data":"{\"event\":\"media\",\"media\":{...}}"}
```

**Fields:**
- **timestamp**: Unix timestamp in milliseconds when the message was received
- **direction**: Always `"incoming"` (indicates message direction)
- **data**: Raw message data as received (usually JSON string)

### Transcripts (`transcripts.jsonl`)

```json
{"timestamp":1768341932350,"message":{"transcript":[{"confidence":0.98,"text":"hello world"}],"is_interim":false,"message_id":"item_123","type":"transcription-result","event":"transcription-result","participant":{"id":"10a52c3f","ssrc":"2614982672"},"timestamp":1768341932350}}
```

**Fields:**
- **timestamp**: Unix timestamp in milliseconds when the transcript was received
- **message**: Complete transcription message object including participant info, confidence scores, and text

## Example Usage

### 1. Record a session

```bash
# Enable dumping in your .env
DUMP_WEBSOCKET_MESSAGES=true
DUMP_TRANSCRIPTS=true
DUMP_BASE_PATH=/tmp

# Start the server
npm start

# Connect your client with a sessionId
# ws://localhost:8080/transcribe?transcribe=true&sendBack=true&sessionId=my-test-session

# Files will be written to:
# - /tmp/my-test-session/websocket-messages.jsonl
# - /tmp/my-test-session/transcripts.jsonl
```

### 2. View captured data

```bash
# View all WebSocket messages
cat /tmp/my-test-session/websocket-messages.jsonl

# View all transcripts
cat /tmp/my-test-session/transcripts.jsonl

# View formatted (requires jq)
cat /tmp/my-test-session/transcripts.jsonl | jq '.'

# Count messages
wc -l /tmp/my-test-session/websocket-messages.jsonl

# Extract just transcription text
cat /tmp/my-test-session/transcripts.jsonl | jq -r '.message.transcript[].text'

# Extract transcripts for a specific participant
cat /tmp/my-test-session/transcripts.jsonl | jq 'select(.message.participant.id=="10a52c3f") | .message.transcript[].text'
```

### 3. Replay messages

Use the provided replay script to send recorded messages:

```bash
# Replay messages with original timing
node scripts/replay-dump.cjs /tmp/my-test-session/websocket-messages.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true"
```

**Note:** Make sure to quote the WebSocket URL if it contains special characters like `?` or `&`.

The replay script will:
- Preserve the original timing between messages
- Show progress as messages are sent
- Display any responses received

### 4. Use for testing

The dump files can be used to:
- Create repeatable integration tests
- Debug specific message sequences
- Replay sessions for testing
- Analyze message patterns and timing
- Verify transcription quality
- Track participant contributions

## Notes

- Messages are appended to files (uses `flags: 'a'`)
- Files are not automatically rotated or cleaned up
- Each session gets its own directory under `$DUMP_BASE_PATH/$sessionId/`
- Streams are automatically closed when the WebSocket connection closes
- Parse errors are handled gracefully and logged
- If no sessionId is provided, files are written directly to `$DUMP_BASE_PATH/`

## Docker Usage

When running in Docker, make sure to:

1. Mount a volume to persist dump files:
   ```bash
   docker run -v /host/path:/tmp -p 8080:8080 --env-file .env opus-transcriber-proxy
   ```

2. Or copy files from the container:
   ```bash
   # Copy entire session directory
   docker cp <container_id>:/tmp/my-test-session ./my-test-session

   # Or copy specific files
   docker cp <container_id>:/tmp/my-test-session/transcripts.jsonl ./transcripts.jsonl
   ```
