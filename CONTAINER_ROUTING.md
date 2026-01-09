# Container Routing Strategies

This document explains the different container routing strategies and how to choose the right one for your use case.

> **Note:** For detailed information about auto-scaling with connection counting, see [AUTOSCALING.md](./AUTOSCALING.md)

## Container Initialization Time

Understanding initialization times is critical for choosing the right routing strategy:

| State | Latency | Description |
|-------|---------|-------------|
| **Cold Start** | 8-15 seconds | First request, need to pull image and start container |
| **Warm Hit** | <100ms | Container already running |
| **Wake from Sleep** | 1-3 seconds | Container sleeping, needs to wake up |

**Breakdown of Cold Start (8-15 seconds):**
- Container image pull: ~3-5 seconds (first time only)
- Container startup: ~1-2 seconds
- Node.js server initialization: ~1-2 seconds
- WASM module loading (Opus decoder): ~1-2 seconds

**Key Insight:** Cold starts are expensive! Choose a routing strategy that minimizes them.

## Routing Strategies

Four routing modes are available, configured via `ROUTING_MODE` environment variable:

### 1. Pool-Based Routing (Recommended) ⭐

**Best for: Many short-lived sessions with no per-session state**

```typescript
ROUTING_MODE = "pool"
CONTAINER_POOL_SIZE = "5"  // Number of containers in pool
```

**How it works:**
- Maintains a fixed pool of N containers (e.g., 5 containers)
- Requests are distributed across the pool using consistent hashing
- Same `sessionId` → Same container (within pool, for connection reuse)
- Containers stay warm because they handle multiple sessions

**Example:**
```
100 sessions → 5 containers in pool
Container 0: Sessions A, F, K, P, U, Z...
Container 1: Sessions B, G, L, Q, V...
Container 2: Sessions C, H, M, R, W...
Container 3: Sessions D, I, N, S, X...
Container 4: Sessions E, J, O, T, Y...
```

**Advantages:**
- ✅ Minimal cold starts (pool stays warm)
- ✅ Predictable resource usage (fixed N containers)
- ✅ Good for high throughput
- ✅ Cost-effective (containers are shared)

**Disadvantages:**
- ❌ No session-specific state persistence
- ❌ Sessions share container resources (but Node.js server handles multiple connections fine)

**When to use:**
- Many different sessions (100s or 1000s)
- Sessions are short-lived (start, transcribe, close)
- No need to preserve state between connections
- Want predictable latency (<100ms after pool is warm)

**Tuning `CONTAINER_POOL_SIZE`:**
```
Expected concurrent sessions: ~50
Recommended pool size: 5-10 containers

Expected concurrent sessions: ~200
Recommended pool size: 10-20 containers

Expected concurrent sessions: ~1000
Recommended pool size: 20-50 containers
```

Rule of thumb: `CONTAINER_POOL_SIZE = max_concurrent_sessions / 10`

### 2. Session-Based Routing

**Best for: Long-lived sessions that need persistent state**

```typescript
ROUTING_MODE = "session"
```

**How it works:**
- Each unique `sessionId` gets its own dedicated container
- Same `sessionId` → Always routes to the same container instance
- Container persists for the session's lifetime + `sleepAfter` timeout

**Example:**
```
Session A → Container A (dedicated)
Session B → Container B (dedicated)
Session C → Container C (dedicated)
100 sessions → 100 containers!
```

**Advantages:**
- ✅ Session affinity (same session → same container)
- ✅ Can maintain in-memory state per session
- ✅ Isolated resources per session

**Disadvantages:**
- ❌ Expensive (one container per session)
- ❌ Many cold starts (new session = new container)
- ❌ Resource waste (idle containers consuming memory)
- ❌ Can hit `max_instances` limit quickly

**When to use:**
- Few long-lived sessions (10s, not 100s)
- Need to maintain state between requests in a session
- Session lifetime is hours/days, not minutes
- Willing to pay for dedicated resources

**Not recommended for:**
- Many short-lived sessions (your use case!)
- Sessions that don't need persistent state

### 3. Shared Container

**Best for: Low traffic or simple testing**

```typescript
ROUTING_MODE = "shared"
```

**How it works:**
- All requests route to a single shared container
- Simplest setup, one container for everything

**Example:**
```
Session A → Shared Container
Session B → Shared Container
Session C → Shared Container
1000 sessions → 1 container!
```

**Advantages:**
- ✅ Simplest setup
- ✅ No cold starts after initial warm-up
- ✅ Lowest cost (only 1 container)

**Disadvantages:**
- ❌ Single point of failure
- ❌ No horizontal scaling
- ❌ Resource contention under high load
- ❌ Can become bottleneck

**When to use:**
- Development/testing
- Very low traffic (<10 concurrent sessions)
- Proof of concept

**Not recommended for:**
- Production with >10 concurrent sessions
- High availability requirements

## Container Sleep Behavior

### What is "Sleep"?

After `sleepAfter` period of inactivity (default: 10 minutes), containers go to **sleep**:

```typescript
sleepAfter = '10m';  // Configurable in worker/index.ts
```

**What happens during sleep:**
- ✅ CPU and memory are released (you're not charged)
- ✅ Container instance ID persists
- ❌ Active WebSocket connections are closed
- ❌ In-memory state is lost (unless using Durable Object storage)
- ❌ OpenAI connections are closed

**Wake from sleep:**
- Next request to the same container instance wakes it up
- Wake time: ~1-3 seconds (faster than cold start)
- Container restarts from scratch (no in-memory state)

### Can You "Destroy" Containers Instead of Sleep?

**No.** Cloudflare automatically manages container lifecycle:
- You cannot manually destroy containers
- You cannot prevent sleep behavior
- You can only control `sleepAfter` duration

**Why this matters less with pool-based routing:**
- Pool containers rarely sleep (constant traffic keeps them warm)
- Even if one pool container sleeps, others handle requests
- Wake-ups are fast (1-3 seconds)

### Tuning `sleepAfter`

**For pool-based routing:**
```typescript
sleepAfter = '30m';  // Longer is better
```
- Pool containers serve many sessions
- Longer sleep timeout = fewer wake-ups
- Pool stays warm even with moderate traffic

**For session-based routing:**
```typescript
sleepAfter = '5m';  // Shorter is better
```
- Session-specific containers aren't reused
- After session ends, no point keeping container alive
- Release resources quickly

**For shared container:**
```typescript
sleepAfter = '1h';  // Longer is better
```
- Single container serves all traffic
- Want to avoid cold starts
- Keep it alive as long as possible

### 4. Auto-Scaling Routing ⚡

**Best for: Variable traffic with automatic scaling**

```typescript
ROUTING_MODE = "autoscale"
MAX_CONNECTIONS_PER_CONTAINER = "10"  // Scale up threshold
MIN_CONTAINERS = "2"                  // Minimum to keep warm
```

**How it works:**
- Coordinator Durable Object tracks connection counts per container
- Automatically creates new containers when existing ones reach capacity
- Scales down idle containers after timeout
- Requires sessionId for all connections

**Advantages:**
- ✅ Automatic scaling based on actual load
- ✅ Cost-efficient (scales to demand)
- ✅ Handles traffic spikes well
- ✅ Can monitor load via /stats endpoint

**Disadvantages:**
- ⚠️ +20-50ms latency (coordinator lookup)
- ⚠️ More complex (Durable Object state)
- ⚠️ Requires sessionId
- ⚠️ Ongoing cold starts as scale up

**When to use:**
- Traffic is highly variable (10x swings)
- Cost optimization is important
- All connections have sessionIds
- Can tolerate small latency overhead

**See [AUTOSCALING.md](./AUTOSCALING.md) for detailed documentation.**

## Comparison Table

| Feature | Pool (Recommended) | Session | Shared | Auto-Scale |
|---------|-------------------|---------|--------|------------|
| Cold starts | Minimal (pool warm-up) | High (per session) | Minimal (one warm-up) | Ongoing (as scale up) |
| Latency after warm-up | <100ms | <100ms | <100ms | <150ms (+coordinator) |
| Resource usage | Medium (N containers) | High (1 per session) | Low (1 container) | Variable (scales) |
| Scalability | Good (fixed pool) | Limited by max_instances | Poor (no scaling) | Excellent (dynamic) |
| Session affinity | Hash-based (optional) | Guaranteed | None | Least-loaded |
| Cost | Medium (fixed) | High (per session) | Low (fixed) | Variable (scales to load) |
| Best for | Many short sessions | Few long sessions | Dev/testing | Variable traffic |
| Requires sessionId | No | Yes | No | Yes |

## Configuration Examples

### Example 1: High-Traffic Media Server (Recommended)

**Use case:** Jitsi/Zoom-like platform with 100s of concurrent meetings

```jsonc
// wrangler-container.jsonc
{
  "vars": {
    "ROUTING_MODE": "pool",
    "CONTAINER_POOL_SIZE": "20"  // 20 containers in pool
  },
  "containers": [{
    "max_instances": 25  // Allow 20 pool + 5 spare
  }]
}
```

```typescript
// worker/index.ts
sleepAfter = '30m';  // Keep pool warm
```

**Expected behavior:**
- 20 containers stay warm constantly
- Each handles ~10-15 concurrent sessions
- <100ms latency after pool warm-up (2-3 minutes)
- Total capacity: ~300 concurrent sessions

### Example 2: Low-Traffic Application

**Use case:** Internal tool with <10 concurrent sessions

```jsonc
// wrangler-container.jsonc
{
  "vars": {
    "ROUTING_MODE": "shared"
  },
  "containers": [{
    "max_instances": 2  // 1 active + 1 spare
  }]
}
```

```typescript
// worker/index.ts
sleepAfter = '1h';  // Keep single container warm
```

**Expected behavior:**
- 1 container handles all sessions
- First request: 8-15 second cold start
- Subsequent requests: <100ms
- Sleeps after 1 hour of inactivity

### Example 3: Per-User Persistent Sessions

**Use case:** Long-running AI assistant conversations with state

```jsonc
// wrangler-container.jsonc
{
  "vars": {
    "ROUTING_MODE": "session"
  },
  "containers": [{
    "max_instances": 50  // Max 50 concurrent users
  }]
}
```

```typescript
// worker/index.ts
sleepAfter = '5m';  // Release resources when user leaves
```

**Expected behavior:**
- Each user gets dedicated container
- First connection: 8-15 second cold start
- Reconnections within 5 minutes: <100ms (same container)
- After 5 minutes idle: Container sleeps, wake on next connect

## Monitoring Container Pool

### View Active Containers

```bash
npx wrangler containers list --config wrangler-container.jsonc
```

Example output with pool routing:
```
ID: pool-0 | Status: running | Requests: 1,234
ID: pool-1 | Status: running | Requests: 1,187
ID: pool-2 | Status: running | Requests: 1,201
ID: pool-3 | Status: running | Requests: 1,156
ID: pool-4 | Status: running | Requests: 1,198
```

### View Container Logs

```bash
cd worker && npm run tail
```

Look for:
- `"Transcriber container started"` - Container cold start or wake
- `"Transcriber container stopped"` - Container going to sleep
- `"Using dispatcher for sessionId: X, container: pool-Y"` - Routing decisions

## Recommendations for Your Use Case

Based on your description:
> "Many different sessions, connection closes when session ends, don't need to preserve state"

**Use pool-based routing:**

```jsonc
// wrangler-container.jsonc
{
  "vars": {
    "ROUTING_MODE": "pool",
    "CONTAINER_POOL_SIZE": "10"  // Start with 10, adjust based on load
  },
  "containers": [{
    "max_instances": 15  // 10 pool + 5 spare
  }]
}
```

```typescript
// worker/index.ts
sleepAfter = '30m';  // Keep pool warm
```

**Expected behavior:**
- First 10 requests: Cold starts (8-15 seconds each)
- After pool is warm: <100ms latency
- Pool stays warm with moderate traffic
- Each container handles multiple sessions concurrently
- No per-session containers = lower cost

**Cost optimization:**
- Start with smaller pool (5 containers)
- Monitor request distribution
- Increase if seeing frequent wake-ups
- Decrease if containers are mostly idle

## Migration Path

If you're unsure, start with shared container and migrate:

```
Phase 1: Shared container (testing)
  ↓ (traffic increases)
Phase 2: Pool with 5 containers (production)
  ↓ (traffic increases more)
Phase 3: Pool with 20 containers (scale)
```

Change just one environment variable - no code changes needed!
