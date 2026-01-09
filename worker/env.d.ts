// Environment types for the Cloudflare Worker

interface Env {
	// Durable Object binding for the container
	TRANSCRIBER: DurableObjectNamespace;

	// Environment variables
	OPENAI_API_KEY: string;
	OPENAI_MODEL?: string;
	FORCE_COMMIT_TIMEOUT?: string;
	DEBUG?: string;
}
