# Observability

Metrics are exported via OpenTelemetry Protocol (OTLP) HTTP to a Prometheus-compatible endpoint (e.g., Grafana Alloy, OpenTelemetry Collector).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OTLP_ENDPOINT` | (empty) | OTLP HTTP endpoint (telemetry disabled if empty) |
| `OTLP_ENV` | (empty) | Environment label (e.g., `dev`, `staging`, `prod`) |
| `OTLP_EXPORT_INTERVAL_MS` | `60000` | Metrics export interval (ms) |
| `OTLP_RESOURCE_ATTRIBUTES` | `{}` | Additional resource attributes (JSON) |
| `OTLP_HEADERS` | `{}` | Custom HTTP headers for authentication (JSON) |

Example:
```bash
OTLP_ENDPOINT=https://otlp.example.com
OTLP_ENV=staging
OTLP_RESOURCE_ATTRIBUTES='{"team":"platform","component":"transcription"}'
```

### Authentication

For endpoints requiring authentication, use `OTLP_HEADERS` to pass custom headers:

**Cloudflare Zero Trust:**
```bash
OTLP_HEADERS='{"CF-Access-Client-Id":"xxx.access","CF-Access-Client-Secret":"secret"}'
```

**Bearer token:**
```bash
OTLP_HEADERS='{"Authorization":"Bearer your-token"}'
```

**API key:**
```bash
OTLP_HEADERS='{"X-API-Key":"your-api-key"}'
```

## Available Metrics

All metrics are prefixed with `otp_` (opus-transcriber-proxy).

### Gauges (current state)

| Metric | Description |
|--------|-------------|
| `otp_sessions_active` | Currently active sessions |
| `otp_sessions_detached` | Sessions in grace period (disconnected but not expired) |
| `otp_backend_connections_active` | Open backend WebSocket connections |
| `otp_participants_active` | Active participant tags |

### Counters (monotonic)

| Metric | Labels | Description |
|--------|--------|-------------|
| `otp_session_starts_total` | `provider` | Total sessions started |
| `otp_session_reattachments_total` | | Session reconnections |
| `otp_client_audio_bytes_total` | | Audio bytes received from clients |
| `otp_client_audio_chunks_total` | | Audio chunks received |
| `otp_client_websocket_close_total` | `code` | WebSocket close events |
| `otp_backend_audio_sent_bytes_total` | `provider` | Audio bytes sent to backends |
| `otp_backend_errors_total` | `provider`, `type` | Backend errors |
| `otp_transcriptions_received_total` | `provider`, `is_interim` | Transcriptions from backends |
| `otp_transcriptions_delivered_total` | `provider`, `is_interim` | Transcriptions sent to clients |
| `otp_dispatcher_messages_sent_total` | | Messages sent to dispatcher |

### Histograms (distributions)

| Metric | Labels | Buckets | Description |
|--------|--------|---------|-------------|
| `otp_backend_connection_duration_seconds` | `provider` | 0.1, 0.25, 0.5, 1, 2.5, 5, 10 | Backend connection time |
| `otp_transcription_latency_seconds` | `provider` | 0.5, 1, 2, 5, 10, 30 | Audio to transcription latency |
| `otp_session_duration_seconds` | | 60, 300, 600, 1800, 3600, 7200 | Session lifetime |

## Resource Attributes

The following resource attributes are set on all metrics:

| Attribute | Source | Description |
|-----------|--------|-------------|
| `service.name` | hardcoded | `opus-transcriber-proxy` |
| `deployment.environment` | `OTLP_ENV` | Environment name |
| `env` | `OTLP_ENV` | Environment name (common label) |
| (custom) | `OTLP_RESOURCE_ATTRIBUTES` | Any additional attributes |

Resource attributes appear in Prometheus as the `target_info` metric. To use them with other metrics, join on the `job` label or configure your collector to promote them.

## Example PromQL Queries

```promql
# Active sessions
otp_sessions_active

# Transcription rate by provider
rate(otp_transcriptions_received_total[5m])

# Backend connection p95 latency
histogram_quantile(0.95, sum(rate(otp_backend_connection_duration_seconds_bucket[5m])) by (le, provider))

# Error rate by provider
rate(otp_backend_errors_total[5m])

# Audio throughput (bytes/sec)
rate(otp_client_audio_bytes_total[5m])

# Session duration p50
histogram_quantile(0.50, sum(rate(otp_session_duration_seconds_bucket[5m])) by (le))
```

## Grafana Dashboard

To create a dashboard:

1. Add Prometheus as a data source pointing to your collector
2. Import metrics using the `otp_*` prefix
3. Use `job="opus-transcriber-proxy"` to filter

Suggested panels:
- **Active Sessions**: `otp_sessions_active`
- **Transcriptions/sec**: `rate(otp_transcriptions_received_total{is_interim="false"}[5m])`
- **Backend Latency**: `histogram_quantile(0.95, sum(rate(otp_backend_connection_duration_seconds_bucket[5m])) by (le))`
- **Error Rate**: `sum(rate(otp_backend_errors_total[5m])) by (provider)`
- **Audio Throughput**: `rate(otp_client_audio_bytes_total[5m])`
