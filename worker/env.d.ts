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

	// Environment variables
	OPENAI_API_KEY: string;
	OPENAI_MODEL?: string;
	GEMINI_API_KEY?: string;
	DEEPGRAM_API_KEY?: string;
	DEEPGRAM_MODEL?: string;
	DEEPGRAM_DETECT_LANGUAGE?: string;
	DEEPGRAM_INCLUDE_LANGUAGE?: string;
	DEEPGRAM_PUNCTUATE?: string;
	DEEPGRAM_ENCODING?: string;
	DEEPGRAM_TAGS?: string;
	PROVIDERS_PRIORITY?: string;
	FORCE_COMMIT_TIMEOUT?: string;
	DEBUG?: string;
	ROUTING_MODE?: string;
	CONTAINER_POOL_SIZE?: string;
	MAX_CONNECTIONS_PER_CONTAINER?: string;
	MIN_CONTAINERS?: string;
	SCALE_DOWN_IDLE_TIME?: string;
	TRANSLATION_MIXING_MODE?: string;
	USE_DISPATCHER?: string;
	SLEEP_AFTER?: string;
}
