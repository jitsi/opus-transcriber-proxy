# Auto-Scaling Containers with Connection Counting

This document explains how the auto-scaling container coordinator works.

## Overview

The `autoscale` routing mode uses a **ContainerCoordinator Durable Object** to automatically scale containers based on connection load.

### How It Works

```
Request arrives
    ↓
Worker calls Coordinator
    ↓
Coordinator checks load across all containers
    ↓
    ├─ All containers have < MAX connections
    │  → Assign to least-loaded container
    │
    └─ All containers at capacity
       → Create new container
       → Assign to new container
```

**When connections close:**
```
Connection closes
    ↓
Worker reports to Coordinator
    ↓
Coordinator decrements connection count
    ↓
Check if container has been idle (0 connections) for > SCALE_DOWN_IDLE_TIME
    ↓
    ├─ Yes + More than MIN_CONTAINERS
    │  → Remove container from pool
    │
    └─ No or at MIN_CONTAINERS
       → Keep container
```

## Architecture

### ContainerCoordinator Durable Object

**Location:** `worker/ContainerCoordinator.ts`

**Responsibilities:**
- Tracks all active containers and their connection counts
- Assigns incoming sessions to least-loaded containers
- Creates new containers when all are at capacity
- Scales down idle containers after timeout
- Persists state to Durable Object storage

**State:**
```typescript
{
  containers: Map<string, {
    id: string,
    activeConnections: number,
    lastActivity: timestamp,
    createdAt: timestamp
  }>,
  sessionToContainer: Map<sessionId, containerId>,
  nextContainerId: number  // For generating unique IDs
}
```

### Worker Integration

**Location:** `worker/index.ts`

**Flow:**
1. Request arrives at worker
2. Worker asks coordinator: "Which container should handle this session?"
3. Coordinator responds with container ID
4. Worker routes request to that container
5. When WebSocket opens: Worker reports `connection-opened` to coordinator
6. When WebSocket closes: Worker reports `connection-closed` to coordinator

## Configuration

### Enable Auto-Scaling

```jsonc
// wrangler-container.jsonc
{
  "vars": {
    "ROUTING_MODE": "autoscale",
    "MAX_CONNECTIONS_PER_CONTAINER": "10",  // Scale up when container reaches this
    "MIN_CONTAINERS": "2",                   // Always keep at least this many
    "SCALE_DOWN_IDLE_TIME": "600000"        // 10 minutes in milliseconds
  }
}
```

### Configuration Parameters

#### `MAX_CONNECTIONS_PER_CONTAINER` (default: 10)

Maximum WebSocket connections per container before creating a new one.

**Tuning:**
- **Higher (20-50)**: Fewer containers, more cost-effective, but higher load per container
- **Lower (5-10)**: More containers, better isolation, but higher overhead

**Recommended values:**
- Light workload (mostly idle): 20-30
- Medium workload (active transcription): 10-15
- Heavy workload (continuous processing): 5-10

#### `MIN_CONTAINERS` (default: 2)

Minimum number of containers to keep running at all times.

**Why keep a minimum:**
- ✅ Avoid cold starts for incoming requests
- ✅ Provide baseline capacity
- ✅ Handle sudden traffic spikes

**Tuning:**
- **Low traffic**: Set to 1-2
- **Medium traffic**: Set to 3-5
- **High traffic**: Set to 5-10

**Cost consideration:** You pay for these containers even when idle (until they sleep after `sleepAfter` timeout).

#### `SCALE_DOWN_IDLE_TIME` (default: 600000 = 10 minutes)

How long a container with 0 connections must be idle before being removed from the pool.

**Tuning:**
- **Shorter (5 minutes)**: More aggressive cleanup, lower cost, but more scale-up events
- **Longer (15-30 minutes)**: Keep capacity available, fewer scale events, but higher idle cost

**Note:** This is separate from `sleepAfter`. Containers sleep (release CPU/memory) after `sleepAfter`, but remain in the coordinator's pool. `SCALE_DOWN_IDLE_TIME` removes them from the pool entirely.

## Scaling Behavior

### Scale Up

**Trigger:** All existing containers have ≥ `MAX_CONNECTIONS_PER_CONTAINER` connections

**Action:**
1. Create new container with ID `container-N` (N increments)
2. Add to coordinator's pool
3. Assign incoming session to new container

**Example:**
```
Current state:
- container-0: 10 connections (at max)
- container-1: 10 connections (at max)

New request arrives
  ↓
Coordinator creates container-2
  ↓
New state:
- container-0: 10 connections
- container-1: 10 connections
- container-2: 1 connection (new request)
```

### Scale Down

**Trigger:** Container has 0 connections for > `SCALE_DOWN_IDLE_TIME` AND pool size > `MIN_CONTAINERS`

**Action:**
1. Remove container from coordinator's pool
2. Stop routing new requests to it
3. Container will eventually sleep (after `sleepAfter`)

**Example:**
```
Current state:
- container-0: 5 connections
- container-1: 0 connections (idle for 11 minutes)
- container-2: 3 connections
MIN_CONTAINERS = 2

Check triggered (connection closed on container-0)
  ↓
container-1 is idle > 10 min AND pool size (3) > MIN (2)
  ↓
Remove container-1 from pool
  ↓
New state:
- container-0: 5 connections
- container-2: 3 connections
(container-1 removed, will sleep and release resources)
```

## Monitoring

### Real-Time Stats

Get current coordinator statistics:

```bash
curl https://your-worker.workers.dev/stats
```

**Response:**
```json
{
  "totalContainers": 5,
  "totalConnections": 42,
  "containers": [
    {
      "id": "container-0",
      "connections": 8,
      "utilization": 80.0
    },
    {
      "id": "container-1",
      "connections": 10,
      "utilization": 100.0
    },
    {
      "id": "container-2",
      "connections": 7,
      "utilization": 70.0
    },
    // ...
  ],
  "config": {
    "maxConnectionsPerContainer": 10,
    "minContainers": 2,
    "scaleDownIdleTime": 600000
  }
}
```

### View Logs

```bash
cd worker
npm run tail
```

**Look for:**
- `"Assigned session X to container-Y (load: N/10)"` - Session assignment
- `"Created new container: container-N (total: M)"` - Scale up event
- `"Connection opened: X on container-Y (load: N)"` - Connection tracking
- `"Connection closed: X on container-Y (load: N)"` - Connection cleanup
- `"Scaled down container: container-Y (remaining: N)"` - Scale down event

## Performance Characteristics

### Latency

| Operation | Latency | Notes |
|-----------|---------|-------|
| Container assignment | +20-50ms | Coordinator DO lookup |
| Connection open report | Non-blocking | Async via ctx.waitUntil() |
| Connection close report | Non-blocking | Async via ctx.waitUntil() |
| Scale up (new container) | +5-15s | Cold start on first use |
| Scale down | 0ms | Just removes from pool |

**Total overhead:** ~20-50ms per WebSocket connection (coordinator lookup)

### Consistency

✅ **Strong consistency:** Coordinator is a single Durable Object, all decisions are serialized
✅ **Accurate counts:** Connection open/close events are reported reliably
⚠️ **Eventual reporting:** Connection events are reported asynchronously (could be delayed)

**Edge case:** If worker fails to report `connection-closed`, coordinator may have inflated counts. This self-corrects over time as scale-down removes idle containers.

## Comparison: Auto-Scale vs Pool

| Feature | Pool (Fixed) | Auto-Scale |
|---------|-------------|------------|
| Complexity | Low | Medium |
| Latency overhead | None | +20-50ms |
| Predictability | High (fixed N) | Variable |
| Resource efficiency | Medium | High |
| Cost at low traffic | Fixed | Lower (scales to MIN) |
| Cost at high traffic | Fixed | Higher (scales up) |
| Cold starts | Initial pool warm-up | Ongoing as scale up |
| Requires sessionId | No | Yes |

## When to Use Auto-Scaling

**Use auto-scaling when:**
- ✅ Traffic is highly variable (10x differences)
- ✅ Cost optimization is important
- ✅ You have sessionIds for all connections
- ✅ You can tolerate +20-50ms latency overhead
- ✅ You want to avoid over-provisioning

**Use fixed pool when:**
- ✅ Traffic is relatively stable
- ✅ Predictability is more important than cost
- ✅ You want lowest latency (<100ms)
- ✅ Simpler setup is preferred

## Example Scenarios

### Scenario 1: Gradual Traffic Growth

```
09:00 - 10 sessions arrive
  → MIN_CONTAINERS (2) already warm
  → Assign 5 sessions to container-0, 5 to container-1
  → Load: 5/10 and 5/10 (50% utilization)

10:00 - 15 more sessions arrive (total 25)
  → container-0 reaches 10/10, container-1 reaches 10/10
  → Create container-2 for next session
  → Load: 10/10, 10/10, 5/10

11:00 - 10 more sessions arrive (total 35)
  → container-2 reaches 10/10
  → Create container-3
  → Load: 10/10, 10/10, 10/10, 5/10

12:00 - Traffic drops, 20 sessions close (15 remain)
  → Load: 10/10, 5/10, 0/10, 0/10

12:10 - Scale down check (10 min idle)
  → container-2 and container-3 at 0 connections for 10 min
  → Remove container-3 (keep container-2 to maintain MIN_CONTAINERS)
  → Load: 10/10, 5/10, 0/10
```

### Scenario 2: Sudden Spike

```
Initial: 2 containers, 0 connections

Spike: 50 sessions arrive within 1 minute
  → First 10: container-0
  → Next 10: container-1
  → Next 10: Create container-2 (cold start ~10s)
  → Next 10: Create container-3 (cold start ~10s)
  → Next 10: Create container-4 (cold start ~10s)

Result: 5 containers, 10 connections each

30 minutes later: All sessions end
  → All containers idle

40 minutes later: Scale down triggered
  → Remove container-2, container-3, container-4
  → Keep container-0, container-1 (MIN_CONTAINERS)
```

## Limitations

1. **No load metrics:** Coordinator only tracks connection count, not CPU/memory usage
2. **No per-container health checks:** Coordinator doesn't monitor container health
3. **Async reporting:** Connection events are reported eventually, not immediately
4. **sessionId required:** Auto-scaling requires sessionId for all connections
5. **Coordinator latency:** Every request incurs coordinator lookup overhead

## Migration from Pool Mode

To switch from pool to autoscale:

1. **Update configuration:**
   ```jsonc
   "ROUTING_MODE": "autoscale",
   "MAX_CONNECTIONS_PER_CONTAINER": "10",
   "MIN_CONTAINERS": "2"  // Start conservatively
   ```

2. **Deploy:**
   ```bash
   cd worker
   npm run deploy
   ```

3. **Monitor stats:**
   ```bash
   # Check scaling behavior
   watch -n 5 'curl -s https://your-worker.workers.dev/stats | jq'
   ```

4. **Tune based on observation:**
   - If containers are mostly underutilized: Increase `MAX_CONNECTIONS_PER_CONTAINER`
   - If too many cold starts: Increase `MIN_CONTAINERS`
   - If costs are high: Decrease `MIN_CONTAINERS` or `SCALE_DOWN_IDLE_TIME`

## Troubleshooting

### Containers keep scaling up

**Cause:** `MAX_CONNECTIONS_PER_CONTAINER` is too low

**Fix:** Increase the threshold:
```jsonc
"MAX_CONNECTIONS_PER_CONTAINER": "20"  // Was 10
```

### Containers never scale down

**Cause:** `SCALE_DOWN_IDLE_TIME` is too long or connections aren't closing properly

**Fix:**
- Reduce timeout: `"SCALE_DOWN_IDLE_TIME": "300000"` (5 minutes)
- Check logs for connection close events
- Verify WebSocket connections are closing properly

### Stats show inflated connection counts

**Cause:** Worker failed to report some `connection-closed` events

**Fix:**
- This is self-correcting (idle containers removed after timeout)
- Check worker logs for errors in reporting
- Ensure worker isn't timing out before reporting

### Coordinator state corruption

**Cause:** Durable Object storage issue (rare)

**Fix:**
- Coordinator state can be reset (will reinitialize to MIN_CONTAINERS)
- Use wrangler to inspect/clear DO storage if needed

## Best Practices

1. **Start conservative:** Begin with higher `MAX_CONNECTIONS_PER_CONTAINER` and lower `MIN_CONTAINERS`
2. **Monitor first:** Watch stats for a week before tuning
3. **Test scale-down:** Ensure idle containers are removed correctly
4. **Use sessionIds:** Always provide sessionId for proper routing
5. **Check logs regularly:** Look for scale events and connection tracking
6. **Adjust for traffic patterns:** Increase MIN_CONTAINERS during peak hours if needed
