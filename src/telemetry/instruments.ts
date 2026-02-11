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
