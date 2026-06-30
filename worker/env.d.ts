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
	TRANSLATION_MIXING_MODE?: string;
	TRANSLATE_TRANSCRIPTS?: string;
	ENABLE_TRANSCRIBE?: string;
	ENABLE_TRANSLATE?: string;
	ENABLE_OPENAI_CUSTOM_PROVIDER?: string;
	OPENAI_CUSTOM_REQUIRE_WSS?: string;
	USE_DISPATCHER?: string;
	SLEEP_AFTER?: string;
	OTLP_ENDPOINT?: string;
	OTLP_ENV?: string;
	OTLP_RESOURCE_ATTRIBUTES?: string;
	OTLP_HEADERS?: string;
}
