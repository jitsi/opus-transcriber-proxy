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
 * Pure helpers that turn the Worker's env bindings and the incoming request into what the
 * container and the client see: the container's environment, its instance name, and the
 * `worker` block merged into the container's `info` message.
 */
import type { Env } from './env';
import type { OverridableProvider } from './providerOverride';

/**
 * CONTAINER_INSTANCE_NAME for the container, from the name this Durable Object was looked up by.
 * Every lookup in this Worker goes through `getContainer(binding, name)`, and Cloudflare keeps
 * the name on the id when the object is later woken by one of its own alarms, so the name is
 * expected to be set; the warning exists so that if an unnamed id ever appears (`idFromString`,
 * `newUniqueId`, or an alarm scheduled before names were stored), the resulting change in
 * `service.instance.id` and `info.instanceId` is explained in the log rather than silent.
 */
export function instanceNameEnv(id: DurableObjectId): Record<string, string> {
	if (!id.name) {
		console.warn(`Durable Object ${id} has no name; CONTAINER_INSTANCE_NAME will be unset for its container`);
		return {};
	}
	return { CONTAINER_INSTANCE_NAME: id.name };
}

/**
 * Build the container env vars from the worker env bindings. `TranscriberContainer.envVars`
 * adds CONTAINER_INSTANCE_NAME on top, so every start path (the Worker's explicit
 * `startAndWaitForPorts`, the SDK's start-on-fetch, the passthrough override's safety net)
 * gives the container the same identity.
 */
export function buildContainerEnvVars(env: Env): Record<string, string> {
	return {
		OPENAI_API_KEY: env.OPENAI_API_KEY,
		OPENAI_MODEL: env.OPENAI_MODEL || 'gpt-4o-transcribe',
		// Only forwarded when explicitly set; otherwise the container defaults apply (endpoints/transcripts on).
		...(env.OPENAI_TRANSLATION_MODEL && { OPENAI_TRANSLATION_MODEL: env.OPENAI_TRANSLATION_MODEL }),
		// Optional separate key for translation; when unset the container falls back to OPENAI_API_KEY.
		...(env.OPENAI_TRANSLATION_API_KEY && { OPENAI_TRANSLATION_API_KEY: env.OPENAI_TRANSLATION_API_KEY }),
		...(env.ENABLE_TRANSCRIBE && { ENABLE_TRANSCRIBE: env.ENABLE_TRANSCRIBE }),
		...(env.ENABLE_TRANSLATE && { ENABLE_TRANSLATE: env.ENABLE_TRANSLATE }),
		// Text translation of transcripts (the /transcribe path, which the container serves).
		// Forwarded only when set, so the container default (off) applies otherwise.
		...(env.ENABLE_TEXT_TRANSLATION && { ENABLE_TEXT_TRANSLATION: env.ENABLE_TEXT_TRANSLATION }),
		...(env.TEXT_TRANSLATION_PROVIDERS_PRIORITY && { TEXT_TRANSLATION_PROVIDERS_PRIORITY: env.TEXT_TRANSLATION_PROVIDERS_PRIORITY }),
		...(env.ENABLE_TEXT_TRANSLATION_STUB && { ENABLE_TEXT_TRANSLATION_STUB: env.ENABLE_TEXT_TRANSLATION_STUB }),
		...(env.TEXT_TRANSLATION_HISTORY_TURNS && { TEXT_TRANSLATION_HISTORY_TURNS: env.TEXT_TRANSLATION_HISTORY_TURNS }),
		...(env.TEXT_TRANSLATION_HISTORY_MAX_CHARS && { TEXT_TRANSLATION_HISTORY_MAX_CHARS: env.TEXT_TRANSLATION_HISTORY_MAX_CHARS }),
		...(env.TEXT_TRANSLATION_INCLUDE_SPEAKERS && { TEXT_TRANSLATION_INCLUDE_SPEAKERS: env.TEXT_TRANSLATION_INCLUDE_SPEAKERS }),
		...(env.TEXT_TRANSLATION_TIMEOUT_MS && { TEXT_TRANSLATION_TIMEOUT_MS: env.TEXT_TRANSLATION_TIMEOUT_MS }),
		...(env.TEXT_TRANSLATION_TEMPERATURE && { TEXT_TRANSLATION_TEMPERATURE: env.TEXT_TRANSLATION_TEMPERATURE }),
		...(env.TEXT_TRANSLATION_REASONING_EFFORT && { TEXT_TRANSLATION_REASONING_EFFORT: env.TEXT_TRANSLATION_REASONING_EFFORT }),
		...(env.TEXT_TRANSLATION_MAX_OUTPUT_TOKENS && { TEXT_TRANSLATION_MAX_OUTPUT_TOKENS: env.TEXT_TRANSLATION_MAX_OUTPUT_TOKENS }),
		// Per-provider translation keys. Each falls back to that provider's transcription key inside
		// the container, so only a separately-billed key needs forwarding here — except
		// TEXT_TRANSLATION_GOOGLE_API_KEY, which has no fallback (Cloud Translation is a different
		// API from Gemini) and is the only way to enable the `google` provider.
		...(env.TEXT_TRANSLATION_OPENAI_API_KEY && { TEXT_TRANSLATION_OPENAI_API_KEY: env.TEXT_TRANSLATION_OPENAI_API_KEY }),
		...(env.TEXT_TRANSLATION_OPENAI_URL && { TEXT_TRANSLATION_OPENAI_URL: env.TEXT_TRANSLATION_OPENAI_URL }),
		...(env.TEXT_TRANSLATION_OPENAI_MODEL && { TEXT_TRANSLATION_OPENAI_MODEL: env.TEXT_TRANSLATION_OPENAI_MODEL }),
		...(env.TEXT_TRANSLATION_XAI_API_KEY && { TEXT_TRANSLATION_XAI_API_KEY: env.TEXT_TRANSLATION_XAI_API_KEY }),
		...(env.TEXT_TRANSLATION_XAI_URL && { TEXT_TRANSLATION_XAI_URL: env.TEXT_TRANSLATION_XAI_URL }),
		...(env.TEXT_TRANSLATION_XAI_MODEL && { TEXT_TRANSLATION_XAI_MODEL: env.TEXT_TRANSLATION_XAI_MODEL }),
		...(env.TEXT_TRANSLATION_GEMINI_API_KEY && { TEXT_TRANSLATION_GEMINI_API_KEY: env.TEXT_TRANSLATION_GEMINI_API_KEY }),
		...(env.TEXT_TRANSLATION_GEMINI_BASE_URL && { TEXT_TRANSLATION_GEMINI_BASE_URL: env.TEXT_TRANSLATION_GEMINI_BASE_URL }),
		...(env.TEXT_TRANSLATION_GEMINI_MODEL && { TEXT_TRANSLATION_GEMINI_MODEL: env.TEXT_TRANSLATION_GEMINI_MODEL }),
		...(env.TEXT_TRANSLATION_GEMINI_THINKING_BUDGET && { TEXT_TRANSLATION_GEMINI_THINKING_BUDGET: env.TEXT_TRANSLATION_GEMINI_THINKING_BUDGET }),
		...(env.TEXT_TRANSLATION_GEMINI_THINKING_LEVEL && { TEXT_TRANSLATION_GEMINI_THINKING_LEVEL: env.TEXT_TRANSLATION_GEMINI_THINKING_LEVEL }),
		...(env.TEXT_TRANSLATION_GOOGLE_API_KEY && { TEXT_TRANSLATION_GOOGLE_API_KEY: env.TEXT_TRANSLATION_GOOGLE_API_KEY }),
		...(env.TEXT_TRANSLATION_GOOGLE_CREDENTIALS_JSON && { TEXT_TRANSLATION_GOOGLE_CREDENTIALS_JSON: env.TEXT_TRANSLATION_GOOGLE_CREDENTIALS_JSON }),
		...(env.TEXT_TRANSLATION_GOOGLE_URL && { TEXT_TRANSLATION_GOOGLE_URL: env.TEXT_TRANSLATION_GOOGLE_URL }),
		...(env.TRANSLATE_TRANSCRIPTS && { TRANSLATE_TRANSCRIPTS: env.TRANSLATE_TRANSCRIPTS }),
		// Forwarded only when set so the container default (350) applies otherwise; matches the other translation
		// tunables above. In the CF deployment /translate is handled by the Worker (not the container); this
		// forwarding is for a standalone container deployment that serves /translate itself. "0" (disable) is a
		// non-empty string → truthy → still forwarded.
		...(env.TRANSLATION_TALK_SILENCE_TIMEOUT_MS && { TRANSLATION_TALK_SILENCE_TIMEOUT_MS: env.TRANSLATION_TALK_SILENCE_TIMEOUT_MS }),
		GEMINI_API_KEY: env.GEMINI_API_KEY || '',
		DEEPGRAM_API_KEY: env.DEEPGRAM_API_KEY || '',
		DEEPGRAM_MODEL: env.DEEPGRAM_MODEL || 'nova-3-general',
		DEEPGRAM_DETECT_LANGUAGE: env.DEEPGRAM_DETECT_LANGUAGE || 'true',
		DEEPGRAM_INCLUDE_LANGUAGE: env.DEEPGRAM_INCLUDE_LANGUAGE || 'false',
		DEEPGRAM_DIARIZE: env.DEEPGRAM_DIARIZE || 'false',
		DEEPGRAM_PUNCTUATE: env.DEEPGRAM_PUNCTUATE || 'true',
		DEEPGRAM_ENCODING: env.DEEPGRAM_ENCODING || 'opus',
		DEEPGRAM_MIP_OPT_OUT: env.DEEPGRAM_MIP_OPT_OUT || 'false',
		DEEPGRAM_TAGS: env.DEEPGRAM_TAGS || '',
		// XAI_API_KEY is forwarded as '' when unset so the container treats xAI as
		// unconfigured (provider disabled). The remaining XAI_* knobs are only
		// forwarded when explicitly set, otherwise the container's code defaults apply.
		XAI_API_KEY: env.XAI_API_KEY || '',
		...(env.XAI_STT_URL && { XAI_STT_URL: env.XAI_STT_URL }),
		...(env.XAI_LANGUAGE && { XAI_LANGUAGE: env.XAI_LANGUAGE }),
		...(env.XAI_DIARIZE && { XAI_DIARIZE: env.XAI_DIARIZE }),
		...(env.XAI_INCLUDE_LANGUAGE && { XAI_INCLUDE_LANGUAGE: env.XAI_INCLUDE_LANGUAGE }),
		...(env.XAI_ENDPOINTING && { XAI_ENDPOINTING: env.XAI_ENDPOINTING }),
		...(env.XAI_SMART_TURN && { XAI_SMART_TURN: env.XAI_SMART_TURN }),
		...(env.XAI_SMART_TURN_TIMEOUT && { XAI_SMART_TURN_TIMEOUT: env.XAI_SMART_TURN_TIMEOUT }),
		...(env.XAI_GRANULAR_FINALS && { XAI_GRANULAR_FINALS: env.XAI_GRANULAR_FINALS }),
		...(env.XAI_GRANULAR_STABILITY_MS && { XAI_GRANULAR_STABILITY_MS: env.XAI_GRANULAR_STABILITY_MS }),
		...(env.XAI_GRANULAR_GUARD_WORDS && { XAI_GRANULAR_GUARD_WORDS: env.XAI_GRANULAR_GUARD_WORDS }),
		...(env.XAI_GRANULAR_MIN_WORDS && { XAI_GRANULAR_MIN_WORDS: env.XAI_GRANULAR_MIN_WORDS }),
		...(env.XAI_CONNECT_ATTEMPTS && { XAI_CONNECT_ATTEMPTS: env.XAI_CONNECT_ATTEMPTS }),
		...(env.XAI_CONNECT_BACKOFF_MS && { XAI_CONNECT_BACKOFF_MS: env.XAI_CONNECT_BACKOFF_MS }),
		...(env.XAI_MAX_TURN_MS && { XAI_MAX_TURN_MS: env.XAI_MAX_TURN_MS }),
		...(env.XAI_TURN_SOFT_MAX_WORDS && { XAI_TURN_SOFT_MAX_WORDS: env.XAI_TURN_SOFT_MAX_WORDS }),
		...(env.XAI_TURN_HARD_MAX_WORDS && { XAI_TURN_HARD_MAX_WORDS: env.XAI_TURN_HARD_MAX_WORDS }),
		...(env.XAI_IDLE_TURN_END_GRACE_MS && { XAI_IDLE_TURN_END_GRACE_MS: env.XAI_IDLE_TURN_END_GRACE_MS }),
		...(env.XAI_ENCODING && { XAI_ENCODING: env.XAI_ENCODING }),
		...(env.XAI_IDLE_FLUSH && { XAI_IDLE_FLUSH: env.XAI_IDLE_FLUSH }),
		// MISTRAL_API_KEY is forwarded as '' when unset so the container treats Mistral as
		// unconfigured (provider disabled). MISTRAL_MODEL is only forwarded when set.
		MISTRAL_API_KEY: env.MISTRAL_API_KEY || '',
		...(env.MISTRAL_MODEL && { MISTRAL_MODEL: env.MISTRAL_MODEL }),
		PROVIDERS_PRIORITY: env.PROVIDERS_PRIORITY || 'openai',
		ENABLE_OPENAI_CUSTOM_PROVIDER: env.ENABLE_OPENAI_CUSTOM_PROVIDER || 'false',
		OPENAI_CUSTOM_REQUIRE_WSS: env.OPENAI_CUSTOM_REQUIRE_WSS || 'true',
		FORCE_COMMIT_TIMEOUT: env.FORCE_COMMIT_TIMEOUT || '2',
		DEBUG: env.DEBUG || 'false',
		// If DEBUG=true is explicitly set on the Worker env, default LOG_LEVEL to
		// 'debug' unless an operator overrides it (e.g. LOG_LEVEL=info).
		LOG_LEVEL: env.LOG_LEVEL || (env.DEBUG === 'true' ? 'debug' : 'info'),
		ROUTING_MODE: env.ROUTING_MODE || 'session',
		CONTAINER_POOL_SIZE: env.CONTAINER_POOL_SIZE || '5',
		MAX_CONNECTIONS_PER_CONTAINER: env.MAX_CONNECTIONS_PER_CONTAINER || '10',
		MIN_CONTAINERS: env.MIN_CONTAINERS || '2',
		SCALE_DOWN_IDLE_TIME: env.SCALE_DOWN_IDLE_TIME || '600000',
		OTLP_ENDPOINT: env.OTLP_ENDPOINT || '',
		OTLP_ENV: env.OTLP_ENV || '',
		OTLP_RESOURCE_ATTRIBUTES: env.OTLP_RESOURCE_ATTRIBUTES || '',
		OTLP_HEADERS: env.OTLP_HEADERS || '',
		// Voice agents (/agent, served by the container): off unless the Worker env enables it; the AGENT_*
		// knobs are forwarded only when set, so the container defaults apply otherwise.
		...(env.ENABLE_AGENT && { ENABLE_AGENT: env.ENABLE_AGENT }),
		...(env.AGENT_REQUIRE_WSS && { AGENT_REQUIRE_WSS: env.AGENT_REQUIRE_WSS }),
		...(env.AGENT_ALLOWED_HOSTS && { AGENT_ALLOWED_HOSTS: env.AGENT_ALLOWED_HOSTS }),
		...(env.AGENT_ALLOW_PRIVATE_ENDPOINTS && { AGENT_ALLOW_PRIVATE_ENDPOINTS: env.AGENT_ALLOW_PRIVATE_ENDPOINTS }),
		...(env.AGENT_SHARED_SECRET && { AGENT_SHARED_SECRET: env.AGENT_SHARED_SECRET }),
		...(env.AGENT_ALLOW_UNAUTHENTICATED && { AGENT_ALLOW_UNAUTHENTICATED: env.AGENT_ALLOW_UNAUTHENTICATED }),
		...(env.AGENT_PACE_LEAD_MS && { AGENT_PACE_LEAD_MS: env.AGENT_PACE_LEAD_MS }),
		...(env.AGENT_PROVISIONING_URL && { AGENT_PROVISIONING_URL: env.AGENT_PROVISIONING_URL }),
		...(env.AGENT_PROVISIONING_TOKEN && { AGENT_PROVISIONING_TOKEN: env.AGENT_PROVISIONING_TOKEN }),
		...(env.AGENT_PROVISIONING_HOST && { AGENT_PROVISIONING_HOST: env.AGENT_PROVISIONING_HOST }),
		PORT: '8080',
		HOST: '0.0.0.0',
	};
}

/**
 * Build the `worker` block that augments the container's `info` message, recording that the
 * request went through the Cloudflare Worker and adding edge/deployment details the container
 * cannot know about (deployed Worker version, the colo/location that handled the request, the
 * routing mode). Merged in-place into the container's info before forwarding to the client.
 *
 * `providerOverride` is present only when an operator override actually changed this connection's
 * provider. The container reports the provider it used either way, but it cannot tell an override
 * apart from a client-supplied parameter — so recording it here is what makes an active override
 * visible in the peer's logs (JVB logs the info message verbatim).
 */
export function buildWorkerInfo(request: Request, env: Env, providerOverride?: OverridableProvider): Record<string, unknown> {
	const cf = (request.cf || {}) as Record<string, unknown>;
	const worker: Record<string, unknown> = {
		present: true,
		routingMode: env.ROUTING_MODE || 'session',
	};
	if (providerOverride) worker.providerOverride = providerOverride;
	if (env.CF_VERSION_METADATA) {
		worker.versionId = env.CF_VERSION_METADATA.id;
		worker.versionTag = env.CF_VERSION_METADATA.tag;
	}
	if (cf.colo) worker.colo = cf.colo;
	if (cf.country) worker.country = cf.country;
	if (cf.city) worker.city = cf.city;
	return worker;
}
