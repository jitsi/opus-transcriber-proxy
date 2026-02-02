# Dispatcher Integration

This document explains how the transcriber forwards transcriptions to an external dispatcher service for further processing (webhooks, storage, analytics, etc.).

The transcriber is **platform-agnostic** and can connect to any WebSocket-compatible dispatcher. The dispatcher implementation is separate and must be provided by you.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Transcriber                              │
│  (Node.js server or Cloudflare Worker with Container)       │
│                                                             │
│  Client WS ←→ [Proxy] ←→ Backend (OpenAI/Deepgram/Gemini)  │
│                  │                                          │
│                  │ (final transcriptions)                   │
│                  ↓                                          │
│         Dispatcher Connection (WebSocket or RPC)            │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│              Your Dispatcher Implementation                  │
│                                                             │
│  - Receives transcription messages                          │
│  - Fans out to webhooks, databases, analytics, etc.        │
└─────────────────────────────────────────────────────────────┘
```

## Deployment Modes

### Node.js Deployment

When running as a standalone Node.js server, the transcriber connects to the dispatcher via a configurable WebSocket URL.

**Configuration:**

| Variable | Description | Default |
|----------|-------------|---------|
| `DISPATCHER_WS_URL` | WebSocket URL of your dispatcher | (empty - disabled) |
| `DISPATCHER_HEADERS` | JSON object with auth headers | `{}` |
| `DISPATCHER_RECONNECT_INTERVAL` | Reconnect delay in ms | 1800000 (30 min) |

**Example:**
```bash
DISPATCHER_WS_URL=wss://your-dispatcher.example.com/ws
DISPATCHER_HEADERS='{"Authorization": "Bearer your-token"}'
```

### Cloudflare Worker Deployment

When deployed as a Cloudflare Worker, the transcriber supports multiple dispatch methods:

| Priority | Method | Binding | Notes |
|----------|--------|---------|-------|
| 1 | WebSocket to DO | `DISPATCHER_DO` | Internal connection, avoids subrequest limit |
| 2 | Queue | `TRANSCRIPTION_QUEUE` | Counts against subrequest limit |
| 3 | RPC | `TRANSCRIPTION_DISPATCHER` | Counts against subrequest limit |

**Note on Cloudflare Limits:** Cloudflare Workers have a subrequest limit per invocation (1000 on enterprise, lower on other plans). For long-running sessions with many transcriptions, both RPC calls and queue pushes count against this limit. The WebSocket-to-Durable-Object approach avoids this because each incoming WebSocket message grants fresh subrequest quota to the DO.

## Configuration

### Cloudflare Worker

Add bindings to your `wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "DISPATCHER_DO",
        "class_name": "TranscriptionDispatcherDO",
        "script_name": "your-dispatcher-worker"
      }
    ]
  },
  "services": [
    {
      "binding": "TRANSCRIPTION_DISPATCHER",
      "service": "your-dispatcher-worker"
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "TRANSCRIPTION_QUEUE",
        "queue": "your-transcription-queue"
      }
    ]
  },
  "vars": {
    "USE_DISPATCHER": "true"
  }
}
```

### Enable Dispatcher

**Option A: Environment Variable (recommended)**

```jsonc
{
  "vars": {
    "USE_DISPATCHER": "true"
  }
}
```

**Option B: Query Parameter (per-request)**

```
wss://your-worker.workers.dev/transcribe?sessionId=test&useDispatcher=true
```

**Precedence:** Query parameter overrides the environment variable.

## Implementing Your Dispatcher

### Message Format

The transcriber sends messages in this format:

```typescript
interface DispatcherTranscriptionMessage {
  sessionId: string;      // Session identifier
  endpointId: string;     // Participant ID
  text: string;           // Transcription text
  timestamp: number;      // Unix timestamp in milliseconds
  language?: string;      // Optional language code
}
```

### WebSocket Dispatcher (Recommended for Cloudflare)

Implement a Durable Object that accepts WebSocket connections:

```typescript
import { DurableObject } from 'cloudflare:workers';

export class TranscriptionDispatcherDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();

    server.addEventListener('message', async (event) => {
      const message = JSON.parse(event.data as string);
      // Forward to webhooks, databases, etc.
      await this.fanOut(message);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async fanOut(message: DispatcherTranscriptionMessage) {
    // Your fan-out logic here
    // Each WebSocket message grants fresh subrequest quota
  }
}
```

### RPC Dispatcher (Legacy)

For simpler setups or when subrequest limits aren't a concern:

```typescript
import { WorkerEntrypoint } from 'cloudflare:workers';

export class TranscriptionDispatcher extends WorkerEntrypoint {
  async dispatch(message: DispatcherTranscriptionMessage): Promise<RPCResponse> {
    // Forward to webhook, database, etc.
    return { success: true, dispatched: 1 };
  }
}
```

### Generic WebSocket Server (Any Platform)

For Node.js or other platforms, implement a WebSocket server:

```typescript
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws, req) => {
  const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');

  ws.on('message', async (data) => {
    const message = JSON.parse(data.toString());
    // Forward to webhooks, databases, etc.
  });
});
```

## Testing

### Without Dispatcher

```bash
# Transcripts returned to client only (dispatcher disabled)
wscat -c "wss://your-endpoint/transcribe?sessionId=test&sendBack=true"
```

### With Dispatcher

```bash
# Transcripts returned to client + forwarded to dispatcher
wscat -c "wss://your-endpoint/transcribe?sessionId=test&sendBack=true&useDispatcher=true"
```

### Check Dispatcher Logs (Cloudflare)

```bash
wrangler tail --name=your-dispatcher-worker-name
```

## Monitoring

Look for these log messages:
- `Connected to Dispatcher DO via WebSocket` - WebSocket connection established
- `Dispatcher connection closed` - Connection lost
- `Queue send failed` / `Dispatcher RPC failed` - Fallback method errors
