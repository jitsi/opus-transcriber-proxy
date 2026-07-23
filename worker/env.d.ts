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
	// Speaker-identity feature (forwarded to the container)
	IDENTITY_ENABLED?: string;
	IDENTITY_SIDECAR_URL?: string;
	IDENTITY_SIDECAR_TOKEN?: string;
	CF_ACCESS_CLIENT_ID?: string;
	CF_ACCESS_CLIENT_SECRET?: string;
	IDENTITY_TENANT?: string;
	IDENTITY_TIMEOUT_MS?: string;
	IDENTITY_KV_ACCOUNT_ID?: string;
	IDENTITY_KV_NAMESPACE_ID?: string;
	IDENTITY_KV_API_TOKEN?: string;
	IDENTITY_ENROLL_MIN_SPEECH_SEC?: string;
	IDENTITY_ENROLL_COOLDOWN_MS?: string;
	IDENTITY_MAX_ENROLLS_PER_SESSION?: string;
	IDENTITY_ENROLL_CONSISTENCY_SUBWINDOW_SEC?: string;
	IDENTITY_ENROLL_CONSISTENCY_THRESHOLD?: string;
	IDENTITY_ENROLL_CONSISTENCY_MAX_STRIKES?: string;
	IDENTITY_MAX_EMBED_SEC?: string;
	IDENTITY_KV_NEGATIVE_TTL_MS?: string;
	IDENTITY_MAX_INFLIGHT?: string;
	// Vectorize fingerprint store — forwarded to the transcriber container, which embeds + matches
	// in-process (LocalIdentityClient).
	VECTORIZE_ACCOUNT_ID?: string;
	VECTORIZE_INDEX?: string;
	VECTORIZE_API_TOKEN?: string;
	MATCH_THRESHOLD?: string;
	// In-container CAM++ embedding model path (LocalIdentityClient). Has a Dockerfile default;
	// only set to override.
	EMBEDDING_MODEL?: string;
}
