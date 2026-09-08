// Environment types for the Cloudflare Worker

import type { TranscriberContainer, TranscriptionDispatcher, DispatcherTranscriptionMessage } from './index';
import type { ContainerCoordinator } from './ContainerCoordinator';

export interface Env {
	// Durable Object binding for the container
	TRANSCRIBER: DurableObjectNamespace<TranscriberContainer>;

	// Dispatcher Durable Object (for WebSocket connection - preferred)
	// This avoids the 1000 subrequest limit by using WebSocket messages
	DISPATCHER_DO?: DurableObjectNamespace;

	// Service bindings (kept for backwards compatibility)
	TRANSCRIPTION_DISPATCHER?: Service<TranscriptionDispatcher>;

	// Queue binding for transcription dispatch (fallback)
	TRANSCRIPTION_QUEUE?: Queue<DispatcherTranscriptionMessage>;

	// Durable Object for auto-scaling
	CONTAINER_COORDINATOR: DurableObjectNamespace<ContainerCoordinator>;

	// Deployed Worker version metadata (wrangler `version_metadata` binding). Optional so the
	// worker still runs if the binding is not configured.
	CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };

	// Environment variables
	OPENAI_API_KEY: string;
	OPENAI_MODEL?: string;
	GEMINI_API_KEY?: string;
	DEEPGRAM_API_KEY?: string;
	DEEPGRAM_MODEL?: string;
	DEEPGRAM_DETECT_LANGUAGE?: string;
	DEEPGRAM_INCLUDE_LANGUAGE?: string;
	DEEPGRAM_DIARIZE?: string;
	DEEPGRAM_PUNCTUATE?: string;
	DEEPGRAM_ENCODING?: string;
	DEEPGRAM_MIP_OPT_OUT?: string;
	DEEPGRAM_TAGS?: string;
	XAI_API_KEY?: string;
	XAI_STT_URL?: string;
	XAI_LANGUAGE?: string;
	XAI_DIARIZE?: string;
	XAI_INCLUDE_LANGUAGE?: string;
	XAI_ENDPOINTING?: string;
	XAI_SMART_TURN?: string;
	XAI_SMART_TURN_TIMEOUT?: string;
	XAI_GRANULAR_FINALS?: string;
	XAI_GRANULAR_STABILITY_MS?: string;
	XAI_GRANULAR_GUARD_WORDS?: string;
	XAI_GRANULAR_MIN_WORDS?: string;
	PROVIDERS_PRIORITY?: string;
	FORCE_COMMIT_TIMEOUT?: string;
	DEBUG?: string;
	LOG_LEVEL?: string;
	ROUTING_MODE?: string;
	CONTAINER_POOL_SIZE?: string;
	MAX_CONNECTIONS_PER_CONTAINER?: string;
	MIN_CONTAINERS?: string;
	SCALE_DOWN_IDLE_TIME?: string;
	TRANSLATE_TRANSCRIPTS?: string;
	OPENAI_TRANSLATION_MODEL?: string;
	OPENAI_TRANSLATION_API_KEY?: string;
	TRANSLATION_USAGE_URL?: string;
	TRANSLATION_USAGE_REPORT_INTERVAL_MS?: string;
	TRANSLATION_TALK_SILENCE_TIMEOUT_MS?: string;
	ENABLE_TRANSCRIBE?: string;
	ENABLE_TRANSLATE?: string;
	ENABLE_TEXT_TRANSLATION?: string;
	TEXT_TRANSLATION_PROVIDERS_PRIORITY?: string;
	ENABLE_TEXT_TRANSLATION_STUB?: string;
	TEXT_TRANSLATION_HISTORY_TURNS?: string;
	TEXT_TRANSLATION_HISTORY_MAX_CHARS?: string;
	TEXT_TRANSLATION_INCLUDE_SPEAKERS?: string;
	TEXT_TRANSLATION_TIMEOUT_MS?: string;
	TEXT_TRANSLATION_TEMPERATURE?: string;
	TEXT_TRANSLATION_REASONING_EFFORT?: string;
	TEXT_TRANSLATION_MAX_OUTPUT_TOKENS?: string;
	TEXT_TRANSLATION_OPENAI_API_KEY?: string;
	TEXT_TRANSLATION_OPENAI_URL?: string;
	TEXT_TRANSLATION_OPENAI_MODEL?: string;
	TEXT_TRANSLATION_XAI_API_KEY?: string;
	TEXT_TRANSLATION_XAI_URL?: string;
	TEXT_TRANSLATION_XAI_MODEL?: string;
	TEXT_TRANSLATION_GEMINI_API_KEY?: string;
	TEXT_TRANSLATION_GEMINI_BASE_URL?: string;
	TEXT_TRANSLATION_GEMINI_MODEL?: string;
	TEXT_TRANSLATION_GEMINI_THINKING_BUDGET?: string;
	TEXT_TRANSLATION_GEMINI_THINKING_LEVEL?: string;
	TEXT_TRANSLATION_GOOGLE_API_KEY?: string;
	TEXT_TRANSLATION_GOOGLE_CREDENTIALS_JSON?: string;
	TEXT_TRANSLATION_GOOGLE_URL?: string;
	// Docker image tag the Worker's WASM Opus codec was sourced from at deploy (set by the translate
	// deploy). Surfaced in the info message so a code/WASM version mismatch is visible to the peer.
	SOURCE_IMAGE_TAG?: string;
	ENABLE_OPENAI_CUSTOM_PROVIDER?: string;
	OPENAI_CUSTOM_REQUIRE_WSS?: string;
	USE_DISPATCHER?: string;
	SLEEP_AFTER?: string;
	OTLP_ENDPOINT?: string;
	OTLP_ENV?: string;
	OTLP_RESOURCE_ATTRIBUTES?: string;
	OTLP_HEADERS?: string;
}
