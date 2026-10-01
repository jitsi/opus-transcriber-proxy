import http from 'node:http';
import https from 'node:https';

/** The media-leg states the gateway reports; jicofo reports `connecting` and allocation failures itself. */
export type AgentLifecycleState = 'active' | 'failed' | 'ended';

export interface AgentStatusReporterOptions {
	/** The provisioning API's status route (prosody's `/voice-agent/status`, or the JaaS gateway). Empty disables. */
	url: string;
	/** Bearer presented on the route (the component's `voice_agent_status_secret`). */
	token?: string;
	/** Host header override, for a prosody that routes HTTP by virtual host. */
	host?: string;
	logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
	/** Injectable transport for tests; resolves to the HTTP status code. */
	send?: (body: string) => Promise<number>;
	retryDelayMs?: number;
	timeoutMs?: number;
}

/**
 * Posts the media leg's lifecycle to the provisioning API. The gateway is the only component that sees the
 * customer socket, so it owns `active` (socket open), `failed` (dial failed) and `ended` (agent sent `end`).
 * One retry on a transport error or 5xx; a 404 means the agent is already gone and is not retried.
 */
export class AgentStatusReporter {
	private readonly send: (body: string) => Promise<number>;

	constructor(private readonly options: AgentStatusReporterOptions) {
		this.send = options.send ?? ((body) => this.post(body));
	}

	get enabled(): boolean {
		return this.options.url !== '';
	}

	async report(conference: string, agentId: string, state: AgentLifecycleState, reason?: string): Promise<void> {
		if (!this.enabled) {
			return;
		}
		const body = JSON.stringify({ conference, agentId, state, ...(reason ? { reason } : {}) });
		const label = `agent ${agentId} (${state})`;
		for (let attempt = 1; attempt <= 2; attempt++) {
			let status: number;
			try {
				status = await this.send(body);
			} catch (error) {
				status = -1;
				this.options.logger.warn(`Status report for ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (status >= 200 && status < 300) {
				return;
			}
			if (status === 404) {
				this.options.logger.info(`Status report for ${label}: agent no longer exists`);
				return;
			}
			if (attempt === 1) {
				await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? 1000));
			} else {
				this.options.logger.warn(`Status report for ${label} gave up, last status ${status}`);
			}
		}
	}

	private post(body: string): Promise<number> {
		const url = new URL(this.options.url);
		const transport = url.protocol === 'https:' ? https : http;
		return new Promise((resolve, reject) => {
			const request = transport.request(url, {
				method: 'POST',
				timeout: this.options.timeoutMs ?? 5000,
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body),
					...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
					...(this.options.host ? { Host: this.options.host } : {}),
				},
			}, (response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			});
			request.on('timeout', () => request.destroy(new Error('timeout')));
			request.on('error', reject);
			request.end(body);
		});
	}
}
