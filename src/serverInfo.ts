import { config, getAvailableProviders, getDefaultProvider, type Provider } from './config';
import { GIT_HASH } from './buildInfo';

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
		},
	};

	if (opts.sessionId) info.sessionId = opts.sessionId;
	if (instanceId) info.instanceId = instanceId;

	const city = process.env.CLOUDFLARE_LOCATION;
	const country = process.env.CLOUDFLARE_COUNTRY_A2;
	if (city || country) {
		info.location = { city, country };
	}

	return info;
}
