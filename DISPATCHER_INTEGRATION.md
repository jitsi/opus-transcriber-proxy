# Dispatcher Integration

This document explains how the Worker intercepts and fans out transcriptions to both the media server and a Transcription Dispatcher worker.

## Architecture Overview

### Before: Direct Pass-through
```
Media Server ←→ Worker ←→ Container ←→ OpenAI
```

### After: Worker Intercepts & Fans Out
```
Media Server ←→ Worker ←→ Container ←→ OpenAI
                  ↓
                  ↓ (RPC)
                  ↓
         Transcription Dispatcher
```

## How It Works

### 1. WebSocket Interception

The Worker creates two WebSocket pairs:
- **Client Pair**: Connects to the media server
- **Container Pair**: Connects to the container

```typescript
// Create interception points
const clientPair = new WebSocketPair();
const [clientWs, clientServerWs] = Object.values(clientPair);

const containerPair = new WebSocketPair();
const [containerClientWs, containerServerWs] = Object.values(containerPair);
```

### 2. Message Flow

**Upstream (Media Server → Container):**
```typescript
// Forward audio data from client to container
clientServerWs.addEventListener('message', (event) => {
  containerClientWs.send(event.data);  // High bandwidth, no interception needed
});
```

**Downstream (Container → Media Server + Dispatcher):**
```typescript
// Intercept transcriptions from container
containerClientWs.addEventListener('message', (event) => {
  // 1. Forward to media server immediately (low latency)
  clientServerWs.send(event.data);

  // 2. Fan out to dispatcher asynchronously (doesn't block)
  if (dispatcher) {
    ctx.waitUntil(
      (async () => {
        const data = JSON.parse(event.data);
        if (data.type === 'transcription') {
          await dispatcher.dispatch({
            sessionId: sessionId,
            endpointId: data.participant?.id || 'unknown',
            text: data.transcript.map(t => t.text).join(' '),
            timestamp: data.timestamp,
          });
        }
      })()
    );
  }
});
```

### 3. Key Design Decisions

**✅ Low Latency for Media Server**
- Transcripts are immediately forwarded to the media server
- Dispatcher call happens asynchronously and doesn't block

**✅ Container Remains Simple**
- Container only knows about OpenAI
- No routing logic in the container
- Easy to test and maintain

**✅ Worker Controls Distribution**
- All routing logic is in one place
- Easy to add more consumers later
- No container changes needed

**✅ Service Binding Performance**
- Uses Cloudflare Service Bindings for zero-latency RPC
- No HTTP overhead
- Direct worker-to-worker communication

## Configuration

### 1. Add Service Binding

Add the `TRANSCRIPTION_DISPATCHER` service binding to your `wrangler.jsonc`:

```jsonc
{
  "services": [
    {
      "binding": "TRANSCRIPTION_DISPATCHER",
      "service": "transcription-dispatcher"
    }
  ]
}
```

### 2. Enable Dispatcher

The dispatcher can be enabled in two ways:

**Option A: Environment Variable (recommended for global enable)**

Add `USE_DISPATCHER` to your wrangler.jsonc vars:

```jsonc
{
  "vars": {
    "USE_DISPATCHER": "true"
  }
}
```

**Option B: Query Parameter (per-request control)**

Add `useDispatcher=true` query parameter:

```
wss://your-worker.workers.dev/transcribe?sessionId=test&useDispatcher=true
```

**Precedence:** Query parameter overrides the environment variable. If neither is set, dispatcher is disabled by default.

### 3. Implement Dispatcher Worker

Your dispatcher worker must implement the `dispatch()` RPC method:

```typescript
import { WorkerEntrypoint } from 'cloudflare:workers';

export interface DispatcherTranscriptionMessage {
  sessionId: string;
  endpointId: string;
  text: string;
  timestamp: number;
  language?: string;
}

export interface RPCResponse {
  success: boolean;
  dispatched: number;
  errors?: string[];
  message?: string;
}

export class TranscriptionDispatcher extends WorkerEntrypoint {
  async dispatch(message: DispatcherTranscriptionMessage): Promise<RPCResponse> {
    // Your implementation here
    console.log('Received transcription:', message);

    // Forward to webhook, database, etc.

    return {
      success: true,
      dispatched: 1,
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return new Response('Transcription Dispatcher');
  },
};
```

## Message Format

### Transcription Message (from Container)

```typescript
interface TranscriptionMessage {
  type: 'transcription' | 'interim_transcription';
  participant: {
    id?: string;
  };
  transcript: Array<{
    text: string;
  }>;
  timestamp: number;
}
```

### Dispatcher Message (to Dispatcher)

```typescript
interface DispatcherTranscriptionMessage {
  sessionId: string;      // Session identifier
  endpointId: string;     // Participant ID (from participant.id)
  text: string;           // Joined transcript text
  timestamp: number;      // Timestamp in milliseconds
  language?: string;      // Optional language code
}
```

## Benefits of This Approach

1. **Separation of Concerns**
   - Container: Audio processing and transcription
   - Worker: Routing and distribution
   - Dispatcher: Business logic and forwarding

2. **Scalability**
   - Easy to add more consumers without touching container code
   - Worker fan-out is lightweight and fast
   - Service Bindings provide zero-latency RPC

3. **Maintainability**
   - Clear boundaries between components
   - Easy to test each component independently
   - Changes to routing don't require container redeployment

4. **Performance**
   - Media server gets transcripts with minimal latency
   - Dispatcher calls don't block the critical path
   - High-bandwidth audio data bypasses interception

## Comparison to Alternatives

### ❌ Alternative 1: Container → Dispatcher Directly

**Problems:**
- Container becomes complex (routing logic)
- Need to pass dispatcher URL to container
- Tight coupling between container and dispatcher
- Hard to add more consumers later

### ❌ Alternative 2: Media Server → Dispatcher

**Problems:**
- Media server must know about dispatcher
- Extra network hop for dispatcher
- Media server becomes a distribution point

### ✅ Our Approach: Worker Fan-out

**Advantages:**
- Container stays simple and focused
- Worker is natural distribution point
- Easy to extend with more consumers
- Leverages Cloudflare Service Bindings

## Testing

### Without Dispatcher

```bash
# Media server receives transcripts directly (dispatcher disabled)
wscat -c "wss://your-worker.workers.dev/transcribe?sessionId=test&sendBack=true"
```

### With Dispatcher (via query param)

```bash
# Media server receives transcripts + dispatcher gets notified
wscat -c "wss://your-worker.workers.dev/transcribe?sessionId=test&sendBack=true&useDispatcher=true"
```

### With Dispatcher (via env var)

If `USE_DISPATCHER=true` is set in wrangler.jsonc, all connections will dispatch:

```bash
# Dispatcher enabled globally via env var
wscat -c "wss://your-worker.workers.dev/transcribe?sessionId=test&sendBack=true"
```

Check dispatcher logs:
```bash
wrangler tail --name=your-dispatcher-worker-name
```

## Monitoring

View Worker logs to see dispatcher calls:
```bash
cd worker
npm run tail
```

Look for:
- `"Using dispatcher for sessionId: XXX"` - Dispatcher enabled
- `"Dispatcher error:"` - Dispatcher RPC failures
- `"Error dispatching transcription:"` - Parse or call errors

## Migration from Old Code

The old Worker (commented in `src/index.ts`) had dispatcher code inline:

```typescript
// Old approach (lines 182-207)
if (useDispatcher) {
  dispatcher?.dispatch(dispatcherMessage)
    .then(response => { /* handle */ })
    .catch(error => { /* handle */ });
}
```

Now extracted to `worker/index.ts` with WebSocket interception, making it:
- More maintainable (separated concerns)
- More flexible (easy to add consumers)
- More testable (clear interfaces)

## Reference Implementation

See the original dispatcher implementation on the `main` branch for a complete example of a dispatcher worker.
