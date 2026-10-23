/*
 * Copyright @ 2025 - present 8x8, Inc.
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
 * Metrics service for writing to Cloudflare Analytics Engine
 * Provides consistent metric structure across the transcription pipeline
 *
 * Note: Environment is not tracked since each Cloudflare account represents
 * a separate environment (dev, staging, prod).
 */

import logger from './logger';

/**
 * Internal debug state for logging metric writes
 */
let debugMetrics = false;

/**
 * Sets the debug state for metric logging
 * @param enabled - Whether to enable debug logging for metrics
 */
export function setMetricDebug(enabled: boolean): void {
	debugMetrics = enabled;
}

export type MetricName =
	| 'transcription_success'
	| 'transcription_failure'
	| 'audio_packet_received'
	| 'audio_packet_queued'
	| 'audio_loss_concealment'
	| 'audio_packet_decoded'
	| 'audio_decode_failure'
	| 'audio_packet_discarded'
	| 'backend_audio_queued'
	| 'backend_audio_sent'
	| 'openai_api_error'
	| 'gemini_api_error'
	| 'deepgram_api_error'
	| 'xai_api_error'
	| 'agent_decoder_failure'
	| 'agent_media_dropped';

export interface MetricEvent {
	name: MetricName;
	worker: 'opus-transcriber-proxy';
	errorType?: string;
	sessionId?: string;
	latencyMs?: number;
}

/**
 * Writes a metric data point (legacy - logs to console when debug enabled)
 * Note: New metrics should use OpenTelemetry via telemetry/instruments.ts
 */
export function writeMetric(analytics: undefined, event: MetricEvent, count: number = 1): void {
	if (debugMetrics) {
		logger.debug(
			'[METRIC]',
			JSON.stringify({
				name: event.name,
				worker: event.worker,
				errorType: event.errorType,
				sessionId: event.sessionId,
				count,
				latencyMs: event.latencyMs,
			}),
		);
	}
}
