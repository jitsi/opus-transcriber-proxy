# Deploying to Cloudflare Containers

This guide walks you through deploying the Opus Transcriber Proxy as a Cloudflare Container.

## Quick Start (TL;DR)

```bash
# 1. Configure WASM build tools (one-time)
npm run configure

# 2. Install worker dependencies and authenticate
cd worker
npm install
npx wrangler login

# 3. Set OpenAI API key
npx wrangler secret put OPENAI_API_KEY --config ../wrangler-container.jsonc

# 4. Deploy (builds locally, then deploys to Cloudflare)
cd ..
npm run cf:deploy

# Wait 3-5 minutes for provisioning, then connect to:
# wss://opus-transcriber-proxy-container.YOUR_ACCOUNT.workers.dev/transcribe?sessionId=test&transcribe=true&sendBack=true
```

## Prerequisites

1. **Docker**: Must be installed and running
   ```bash
   docker info  # Verify Docker is running
   ```

2. **Node.js Build Tools**: Required to build WASM modules locally
   - Node.js 18+ (you already have this)
   - Make, GCC, Python (for WASM compilation)
   - Emscripten (installed via `npm run configure`)

3. **Cloudflare Account**: You need a Workers Paid plan ($5/month minimum)

4. **Wrangler CLI**: Install in the worker directory
   ```bash
   cd worker
   npm install
   ```

5. **Cloudflare Authentication**:
   ```bash
   npx wrangler login
   ```

## Build Process

The Docker image uses a **pre-built approach**:
1. WASM modules are compiled on your local machine (requires Emscripten)
2. TypeScript is compiled to JavaScript locally
3. Docker copies the compiled artifacts into a minimal runtime container

This approach:
- ✅ Creates smaller Docker images
- ✅ Faster builds (no compilation in Docker)
- ✅ Avoids Emscripten installation issues in Alpine
- ✅ More reliable for CI/CD pipelines

## Setup Steps

### 1. Configure Secrets

Set your OpenAI API key as a Cloudflare secret:

```bash
cd worker
npx wrangler secret put OPENAI_API_KEY --config ../wrangler-container.jsonc
# Enter your OpenAI API key when prompted
```

Optionally set the OpenAI model:

```bash
npx wrangler secret put OPENAI_MODEL --config ../wrangler-container.jsonc
# Enter: gpt-4o-transcribe or gpt-4o-mini-transcribe
```

### 2. Build and Deploy

First, ensure you have WASM tools configured (one-time setup):

```bash
# From project root
npm run configure
```

Deploy the container (this will take 5-10 minutes):

```bash
# From project root - this builds WASM, compiles TS, builds Docker, and deploys
npm run cf:deploy
```

Or manually:

```bash
# Build locally first
npm run build

# Then deploy from worker directory
cd worker
npm run deploy
```

This deployment process:
1. Compiles WASM modules locally (Opus decoder)
2. Compiles TypeScript to JavaScript
3. Builds Docker image with compiled artifacts
4. Pushes image to Cloudflare's Container Registry
5. Deploys your Worker
6. Configures the network

**Important**: After first deployment, wait 3-5 minutes for the container to be fully provisioned before making requests.

### 3. Verify Deployment

Check the status:

```bash
npx wrangler containers list --config ../wrangler-container.jsonc
npx wrangler containers images list --config ../wrangler-container.jsonc
```

### 4. Test Your Deployment

Your Worker will be available at:
```
https://opus-transcriber-proxy-container.YOUR_ACCOUNT.workers.dev
```

Test the WebSocket endpoint:
```bash
# Using wscat (install with: npm install -g wscat)
wscat -c "wss://opus-transcriber-proxy-container.YOUR_ACCOUNT.workers.dev/transcribe?sessionId=test1&transcribe=true&sendBack=true"
```

## Usage

### WebSocket Connection

Connect to:
```
wss://opus-transcriber-proxy-container.YOUR_ACCOUNT.workers.dev/transcribe
```

Query parameters:
- `sessionId` (optional) - Routes to a specific container instance
- `transcribe=true` (required) - Enable transcription
- `sendBack=true` (required) - Send transcripts back on the same WebSocket
- `sendBackInterim=true` (optional) - Include interim transcription results
- `lang` (optional) - Language code (e.g., 'en', 'es', 'fr')
- `useDispatcher=true` (optional) - Fan out transcripts to the Transcription Dispatcher worker

### Transcription Dispatcher Integration

The Worker can fan out transcriptions to a separate Transcription Dispatcher worker for processing, logging, or forwarding to other systems.

**How it works:**
1. Media server connects via WebSocket and sends audio
2. Container decodes audio and gets transcriptions from OpenAI
3. Worker intercepts transcriptions and:
   - Forwards to media server via WebSocket (low latency path)
   - Asynchronously dispatches to Dispatcher worker (doesn't block)

**Dispatch Methods (in order of preference):**

1. **Cloudflare Queue** (recommended) - Messages sent to a queue, consumed by Dispatcher
   - Doesn't count against the 50 subrequest limit per WebSocket connection
   - Better for high-throughput scenarios

2. **Service Binding RPC** (fallback) - Direct RPC call to Dispatcher worker
   - Each dispatch counts as a subrequest (50 limit per WebSocket lifetime)
   - Use only for low-traffic scenarios

**Setup with Queue (Recommended):**

1. Deploy your Transcription Dispatcher worker with queue consumer configured
2. Update `wrangler.jsonc` to add a queue producer:
   ```jsonc
   "queues": {
     "producers": [{
       "binding": "TRANSCRIPTION_QUEUE",
       "queue": "transcription-dispatch-queue-staging"
     }]
   }
   ```
3. Set `USE_DISPATCHER` environment variable:
   ```jsonc
   "vars": {
     "USE_DISPATCHER": "true"
   }
   ```
4. Or enable per-connection with query parameter:
   ```
   wss://your-worker.workers.dev/transcribe?sessionId=test&transcribe=true&sendBack=true&useDispatcher=true
   ```

**Setup with RPC (Fallback):**

1. Deploy your Transcription Dispatcher worker (must implement the `dispatch()` RPC method)
2. Update `wrangler.jsonc` to add a service binding:
   ```jsonc
   "services": [{
     "binding": "TRANSCRIPTION_DISPATCHER",
     "service": "transcription-dispatcher"
   }]
   ```
3. Enable with `USE_DISPATCHER=true` or `useDispatcher=true` query param

**Environment Variables:**
- `USE_DISPATCHER` - Set to `"true"` to enable dispatching by default (can be overridden per-connection via URL param)

**Message Format:**
```typescript
interface DispatcherTranscriptionMessage {
  sessionId: string;
  endpointId: string;  // participant ID
  text: string;        // full transcript text
  timestamp: number;
  language?: string;
}
```

**Dispatcher Interface (for RPC fallback):**
```typescript
export interface TranscriptionDispatcher extends WorkerEntrypoint<Env> {
  dispatch(message: DispatcherTranscriptionMessage): Promise<RPCResponse>;
}

interface RPCResponse {
  success: boolean;
  dispatched: number;
  errors?: string[];
  message?: string;
}
```

See the [transcription-dispatcher](https://github.com/jitsi/vo_meetings_cf-transcription-dispatcher) repository for the dispatcher implementation.

### Monitoring

View logs in real-time:
```bash
cd worker
npm run tail
```

View metrics in Cloudflare Dashboard:
- Navigate to Workers & Pages
- Select your worker
- Click on "Containers" tab

## Configuration

### Container Settings

Edit `wrangler-container.jsonc` to configure:

- `max_instances`: Maximum concurrent containers (default: 10)
- `sleepAfter`: How long to keep idle containers running (default: 10m)
- Environment variables in the `vars` section

### Scaling

The container will automatically scale based on demand:
- Each unique `sessionId` gets its own container instance
- Containers sleep after `sleepAfter` period of inactivity
- Wake up automatically on new requests
- Max `max_instances` can run concurrently

## Updating the Application

To update after code changes:

```bash
cd worker
npm run deploy
```

Wrangler will rebuild the Docker image and redeploy.

## Cost Estimates

Cloudflare Containers pricing (as of 2025):
- Workers Paid plan: $5/month base
- Container usage: Pay-per-use based on:
  - CPU time
  - Memory usage
  - Network egress

Check current pricing at: https://developers.cloudflare.com/containers/platform/pricing/

## Troubleshooting

### Docker build fails

If `npm run docker:build` fails:

1. **Ensure code is built first**:
   ```bash
   npm run configure  # One-time setup
   npm run build      # Build WASM and TypeScript
   ```

2. **Verify dist/ directory exists with required files**:
   ```bash
   ls -la dist/
   # Should see: opus-decoder.js, opus-decoder.wasm, opus-decoder.wasm.map

   ls -la dist/src/
   # Should see: server.js and other compiled .js files
   ```

3. **Test Docker build manually**:
   ```bash
   docker build -t test-transcriber .
   ```

### Container not starting

1. Check Docker image builds locally:
   ```bash
   npm run docker:build
   npm run docker:run
   ```

2. Check container logs in Cloudflare:
   ```bash
   cd worker
   npm run tail
   ```

### WebSocket connection fails

1. Verify container is running:
   ```bash
   npx wrangler containers list --config ../wrangler-container.jsonc
   ```

2. Test HTTP endpoint first:
   ```bash
   curl https://opus-transcriber-proxy-container.YOUR_ACCOUNT.workers.dev/health
   ```

3. Check for OPENAI_API_KEY secret:
   ```bash
   npx wrangler secret list --config ../wrangler-container.jsonc
   ```

### First deployment takes too long

This is normal. Containers take 3-5 minutes to provision on first deployment. Subsequent deployments are faster.

## Local Development

For local development, use the standalone Node.js server:

```bash
npm run dev
```

This runs the application without Cloudflare infrastructure, useful for rapid iteration.

## Architecture

```
Media Server (WebSocket)
    ↓
    ↓ (audio data)
    ↓
Cloudflare Worker (intercepts & fans out)
    ↓                           ↓
    ↓ (audio)         (transcripts via Queue/RPC)
    ↓                           ↓
Container Instance        Transcription Dispatcher
    ↓                      (optional, parallel)
    ↓ (audio)
    ↓
OpenAI Realtime API
    ↓
    ↓ (transcripts)
    ↓
Container ← ← ← ← ←
    ↓
Worker (intercepts)
    ↓
Media Server (receives transcripts)
```

**Data Flow:**
1. Media server sends audio via WebSocket → Worker → Container
2. Container decodes Opus → sends to OpenAI
3. OpenAI returns transcripts → Container → Worker
4. Worker fans out transcripts to:
   - Media server (via WebSocket, low latency)
   - Dispatcher (via Queue or RPC, async, optional)

Each container instance:
- Runs the full Node.js application
- Handles multiple WebSocket connections
- Manages multiple OpenAI sessions (one per audio tag, no limit)
- Automatically scales based on sessionId routing
