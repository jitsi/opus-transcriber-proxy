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

import { config, getAvailableProviders, getDefaultProvider, type Provider } from './config';
import { GIT_HASH } from './buildInfo';

/**
 * The KV config overrides this process was started with: the Cloudflare Worker resolves them
 * (worker/configOverride.ts), overlays them on the env it starts the container with, and lists
 * them in CONFIG_OVERRIDES as a JSON object of variable name to value. The values are already in
 * the process env; this is only the record of which ones came from KV. Empty when unset or
 * malformed (it is informational, so a bad value must not break anything).
 */
export function startupConfigOverrides(): Record<string, string> {
	const raw = process.env.CONFIG_OVERRIDES;
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
	} catch {
		return {};
	}
}

/**
 * Build the `info` message this server sends to the client (JVB) right after the WebSocket
 * connection is established. It carries build, deployment and per-session configuration details
 * for runtime observability — the goal is to make the running commit and effective config of a
 * deployed container directly visible to the connecting peer (and in our own logs), independent
 * of the deployment pipeline.
 *
 * The shape is intentionally a plain object (not a typed schema): the Cloudflare Worker augments
 * it in-place with a `worker` block, and the peer simply logs whatever it receives.
 */
export function buildServerInfo(opts: { sessionId?: string; provider?: Provider }): Record<string, unknown> {
	// Cloudflare sets CLOUDFLARE_DURABLE_OBJECT_ID for the container; use it to distinguish the
	// container runtime from a plain Node.js deployment.
	const instanceId = process.env.CONTAINER_INSTANCE_NAME || process.env.CLOUDFLARE_DURABLE_OBJECT_ID;
	const onCloudflare = !!process.env.CLOUDFLARE_DURABLE_OBJECT_ID;

	const info: Record<string, unknown> = {
		event: 'info',
		application: 'opus-transcriber-proxy',
		gitHash: GIT_HASH,
		runtime: onCloudflare ? 'cloudflare-container' : 'node',
		// Effective provider for THIS session (per-connection override, else global default).
		provider: opts.provider ?? getDefaultProvider() ?? undefined,
		providersAvailable: getAvailableProviders(),
		config: {
			providersPriority: config.providersPriority,
			forceCommitTimeout: config.forceCommitTimeout,
			sessionResumeEnabled: config.sessionResumeEnabled,
			useDispatcher: config.useDispatcher,
			// Whether usage reporting is configured (URL set) — a flag, not the URL, to keep the
			// endpoint out of the peer's logs. Mirrored in worker/translationRuntime.ts for the Worker path.
			usageReporting: !!config.translation.usageUrl,
		},
	};

	if (opts.sessionId) info.sessionId = opts.sessionId;
	if (instanceId) info.instanceId = instanceId;
	// Docker image tag the WASM codec was sourced from, for any deploy that sets SOURCE_IMAGE_TAG — in
	// practice the translate Worker (its codec is versioned independently of the code); unset on the
	// container, where code + codec are one image. Reported alongside `gitHash` so a mismatch is visible.
	if (process.env.SOURCE_IMAGE_TAG) info.sourceImageTag = process.env.SOURCE_IMAGE_TAG;
	// The KV config overrides this container started with. Its env is fixed at start, so these are
	// what it runs with, even after the KV entries have changed (the Worker's own `worker` block
	// reports the ones in effect for the current request).
	const overrides = startupConfigOverrides();
	if (Object.keys(overrides).length > 0) info.configOverrides = overrides;

	const city = process.env.CLOUDFLARE_LOCATION;
	const country = process.env.CLOUDFLARE_COUNTRY_A2;
	if (city || country) {
		info.location = { city, country };
	}

	return info;
}
