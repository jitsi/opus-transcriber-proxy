// Environment types for the Cloudflare Worker

import type { TranscriptionDispatcher } from './index';

interface Env {
	// Durable Object binding for the container
	TRANSCRIBER: DurableObjectNamespace;

	// Service bindings
	TRANSCRIPTION_DISPATCHER?: Service<TranscriptionDispatcher>;

	// Durable Object for auto-scaling
	CONTAINER_COORDINATOR: DurableObjectNamespace;

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
}
