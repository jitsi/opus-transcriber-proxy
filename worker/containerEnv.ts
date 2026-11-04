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
import type { AppliedOverrides } from './providerOverride';
import { WORKER_VARS, type VarSpec } from './vars';

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
 * Build the container env vars from the worker env bindings, as worker/vars.ts declares them.
 * `TranscriberContainer.envVars` adds CONTAINER_INSTANCE_NAME on top, so every start path (the
 * Worker's explicit `startAndWaitForPorts`, the SDK's start-on-fetch, the passthrough override's
 * safety net) gives the container the same identity.
 *
 * `env` is the effective env: the Worker's bindings with any KV config overrides already overlaid
 * (worker/configOverride.ts). `configOverrides` lists those overrides; it is passed to the container
 * as CONFIG_OVERRIDES so its `info` message can report what this container started with, which
 * the Worker cannot know for a container that was already running.
 */
export function buildContainerEnvVars(env: Env, configOverrides?: Readonly<Record<string, string>>): Record<string, string> {
	const vars: Record<string, string> = {};
	const source = env as unknown as Readonly<Record<string, string | undefined>>;
	for (const [name, spec] of Object.entries(WORKER_VARS) as Array<[string, VarSpec]>) {
		const value = source[name];
		if (spec.container === 'if-set') {
			if (value) vars[name] = value;
		} else if (spec.container) {
			const fallback = spec.container.default;
			vars[name] = value || (typeof fallback === 'function' ? fallback(source) : fallback);
		}
	}
	if (configOverrides && Object.keys(configOverrides).length > 0) {
		vars.CONFIG_OVERRIDES = JSON.stringify(configOverrides);
	}
	// The container must listen where TranscriberContainer.defaultPort expects it, so these are not
	// configurable.
	vars.PORT = '8080';
	vars.HOST = '0.0.0.0';
	return vars;
}

/**
 * Build the `worker` block that augments the container's `info` message, recording that the
 * request went through the Cloudflare Worker and adding edge/deployment details the container
 * cannot know about (deployed Worker version, the colo/location that handled the request, the
 * routing mode). Merged in-place into the container's info before forwarding to the client.
 *
 * `providerOverride` and `textTranslationProviderOverride` are present only when an operator
 * override (worker/providerOverride.ts) actually changed this connection's transcription or
 * text-translation provider. The container reports the providers it used either way, but it cannot
 * tell an override apart from a client-supplied parameter — so recording them here is what makes an
 * active override visible in the peer's logs (JVB logs the info message verbatim).
 *
 * `configOverrides` are the KV config overrides (worker/configOverride.ts) in effect for this
 * request, which is what the Worker's own decisions (routing, the dispatcher) used. The
 * container reports, as its own `configOverrides`, the ones it was started with; the two differ
 * when an override changed after the container started.
 */
export function buildWorkerInfo(
	request: Request,
	env: Env,
	overrides?: AppliedOverrides,
	configOverrides?: Readonly<Record<string, string>>,
): Record<string, unknown> {
	const cf = (request.cf || {}) as Record<string, unknown>;
	const worker: Record<string, unknown> = {
		present: true,
		routingMode: env.ROUTING_MODE || 'session',
	};
	if (overrides?.transcribe) worker.providerOverride = overrides.transcribe;
	if (overrides?.['text-translation']) worker.textTranslationProviderOverride = overrides['text-translation'];
	if (configOverrides && Object.keys(configOverrides).length > 0) worker.configOverrides = { ...configOverrides };
	if (env.CF_VERSION_METADATA) {
		worker.versionId = env.CF_VERSION_METADATA.id;
		worker.versionTag = env.CF_VERSION_METADATA.tag;
	}
	if (cf.colo) worker.colo = cf.colo;
	if (cf.country) worker.country = cf.country;
	if (cf.city) worker.city = cf.city;
	return worker;
}
