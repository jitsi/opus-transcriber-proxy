/*
 * Copyright @ 2025 - Present, 8x8 Inc
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * OpenTelemetry metric instruments for opus-transcriber-proxy.
 *
 * All metrics are prefixed with 'otp_' (opus-transcriber-proxy).
 */

import { Counter, Histogram, ObservableGauge, UpDownCounter } from '@opentelemetry/api';
import { getMeter } from '../telemetry';

// Lazy initialization - instruments created on first access
let _instruments: Instruments | null = null;

interface Instruments {
	// Gauges (current state)
	sessionsActive: UpDownCounter;
	sessionsDetached: UpDownCounter;
	backendConnectionsActive: UpDownCounter;
	participantsActive: UpDownCounter;
	dispatcherQueueDepth: ObservableGauge;

	// Counters (monotonic)
	sessionStartsTotal: Counter;
	sessionReattachmentsTotal: Counter;
	clientAudioBytesTotal: Counter;
	clientAudioChunksTotal: Counter;
	clientWebsocketCloseTotal: Counter;
	backendAudioSentBytesTotal: Counter;
	backendErrorsTotal: Counter;
	backendHandshakeFailuresTotal: Counter;
	agentDialFailuresTotal: Counter;
	agentStatusReportsGivenUpTotal: Counter;
	transcriptionsReceivedTotal: Counter;
	transcriptionsDeliveredTotal: Counter;
	dispatcherMessagesSentTotal: Counter;

	// Histograms (distributions)
	backendConnectionDurationSeconds: Histogram;
	transcriptionLatencySeconds: Histogram;
	sessionDurationSeconds: Histogram;
}

function createInstruments(): Instruments {
	const meter = getMeter();

	return {
		// Gauges - use UpDownCounter for values that can go up and down
		sessionsActive: meter.createUpDownCounter('otp_sessions_active', {
			description: 'Currently active sessions',
			unit: '{sessions}',
		}),

		sessionsDetached: meter.createUpDownCounter('otp_sessions_detached', {
			description: 'Sessions in grace period (detached but not expired)',
			unit: '{sessions}',
		}),

		backendConnectionsActive: meter.createUpDownCounter('otp_backend_connections_active', {
			description: 'Open backend WebSocket connections',
			unit: '{connections}',
		}),

		participantsActive: meter.createUpDownCounter('otp_participants_active', {
			description: 'Active participant tags',
			unit: '{participants}',
		}),

		// Observable gauge for dispatcher queue (read from external state)
		dispatcherQueueDepth: meter.createObservableGauge('otp_dispatcher_queue_depth', {
			description: 'Pending messages in dispatcher queue',
			unit: '{messages}',
		}),

		// Counters
		sessionStartsTotal: meter.createCounter('otp_session_starts_total', {
			description: 'Total sessions started',
			unit: '{sessions}',
		}),

		sessionReattachmentsTotal: meter.createCounter('otp_session_reattachments_total', {
			description: 'Total session reattachments (reconnections)',
			unit: '{reattachments}',
		}),

		clientAudioBytesTotal: meter.createCounter('otp_client_audio_bytes_total', {
			description: 'Total audio bytes received from clients',
			unit: 'By',
		}),

		clientAudioChunksTotal: meter.createCounter('otp_client_audio_chunks_total', {
			description: 'Total audio chunks received from clients',
			unit: '{chunks}',
		}),

		clientWebsocketCloseTotal: meter.createCounter('otp_client_websocket_close_total', {
			description: 'Total client WebSocket close events',
			unit: '{closes}',
		}),

		backendAudioSentBytesTotal: meter.createCounter('otp_backend_audio_sent_bytes_total', {
			description: 'Total audio bytes sent to transcription backends',
			unit: 'By',
		}),

		backendErrorsTotal: meter.createCounter('otp_backend_errors_total', {
			description: 'Total backend errors',
			unit: '{errors}',
		}),

		// Per-attempt handshake failures, including the ones a retry then recovers from —
		// otp_backend_errors_total only counts a connection once its retries are exhausted,
		// so on its own it hides a provider blip the retry absorbed (and understates the
		// failure rate during an outage, since each loss now takes seconds to report).
		// Labels: provider, reason (http_<status> | transport | timeout).
		backendHandshakeFailuresTotal: meter.createCounter('otp_backend_handshake_failures_total', {
			description: 'Backend WebSocket handshake attempts that failed (before any retry)',
			unit: '{attempts}',
		}),

		// Labels: reason (config | ssrf). Permanent failures only: the bridge is told not to redial.
		agentDialFailuresTotal: meter.createCounter('otp_agent_dial_failures_total', {
			description: '/agent connections failed permanently before dialing (bad or unsupported dial config, SSRF guard)',
			unit: '{connections}',
		}),

		// Labels: state. A report that gave up leaves the agent in a wrong state at the provisioning API.
		agentStatusReportsGivenUpTotal: meter.createCounter('otp_agent_status_reports_given_up_total', {
			description: 'Agent lifecycle reports to the provisioning API that gave up after all retries',
			unit: '{reports}',
		}),

		transcriptionsReceivedTotal: meter.createCounter('otp_transcriptions_received_total', {
			description: 'Total transcriptions received from backends',
			unit: '{transcriptions}',
		}),

		transcriptionsDeliveredTotal: meter.createCounter('otp_transcriptions_delivered_total', {
			description: 'Total transcriptions delivered to clients',
			unit: '{transcriptions}',
		}),

		dispatcherMessagesSentTotal: meter.createCounter('otp_dispatcher_messages_sent_total', {
			description: 'Total messages sent to dispatcher',
			unit: '{messages}',
		}),

		// Histograms
		backendConnectionDurationSeconds: meter.createHistogram('otp_backend_connection_duration_seconds', {
			description: 'Time to establish backend WebSocket connection',
			unit: 's',
			advice: {
				explicitBucketBoundaries: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
			},
		}),

		transcriptionLatencySeconds: meter.createHistogram('otp_transcription_latency_seconds', {
			description: 'Latency from audio commit to transcription result',
			unit: 's',
			advice: {
				explicitBucketBoundaries: [0.5, 1, 2, 5, 10, 30],
			},
		}),

		sessionDurationSeconds: meter.createHistogram('otp_session_duration_seconds', {
			description: 'Total session duration',
			unit: 's',
			advice: {
				explicitBucketBoundaries: [60, 300, 600, 1800, 3600, 7200],
			},
		}),
	};
}

/**
 * Get metric instruments (lazy initialization).
 */
export function getInstruments(): Instruments {
	if (!_instruments) {
		_instruments = createInstruments();
	}
	return _instruments;
}

// Re-export types for convenience
export type { Instruments };
