import http from 'node:http';
import https from 'node:https';

/** The media-leg states the gateway reports; jicofo reports `connecting` and allocation failures itself. */
export type AgentLifecycleState = 'active' | 'failed' | 'ended';

/** What the provisioning API hands back for a dial: the customer endpoint and the opaque invite parameters. */
export interface AgentDialConfig {
	endpoint: { url: string; authorization?: string };
	customParameters?: Record<string, unknown>;
}

export interface ProvisioningResponse {
	status: number;
	body: string;
}

export interface ProvisioningClientOptions {
	/** Base URL of the provisioning API's internal routes (prosody's `/voice-agent`, or the JaaS gateway). Empty disables. */
	url: string;
	/** Bearer presented on the internal routes (the component's `voice_agent_status_secret`). */
	token?: string;
	/** Host header override, for a prosody that routes HTTP by virtual host. */
	host?: string;
	logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
	/** Injectable transport for tests. */
	request?: (method: 'GET' | 'POST', path: string, body?: string) => Promise<ProvisioningResponse>;
	retryDelayMs?: number;
	timeoutMs?: number;
}

/**
 * The gateway's client for the provisioning API's internal routes. It fetches an agent's dial config by id when
 * the bridge connects (`GET dial`), so the customer endpoint and its secret never travel through room metadata,
 * jicofo or the bridge, and it posts the media leg's lifecycle (`POST status`): the gateway is the only component
 * that sees the customer socket, so it owns `active` (socket open), `failed` (dial failed) and `ended` (agent
 * sent `end`). Status reports get one retry on a transport error or 5xx; a 404 means the agent is already gone.
 */
export class ProvisioningClient {
	private readonly request: (method: 'GET' | 'POST', path: string, body?: string) => Promise<ProvisioningResponse>;

	constructor(private readonly options: ProvisioningClientOptions) {
		this.request = options.request ?? ((method, path, body) => this.send(method, path, body));
	}

	get enabled(): boolean {
		return this.options.url !== '';
	}

	/** The dial config for an agent, or undefined when the API is not configured, the agent is gone, or the fetch failed. */
	async dialConfig(conference: string, agentId: string): Promise<AgentDialConfig | undefined> {
		if (!this.enabled) {
			return undefined;
		}
		const label = `agent ${agentId}`;
		let response: ProvisioningResponse;
		try {
			response = await this.request('GET', `dial?conference=${encodeURIComponent(conference)}&agentId=${encodeURIComponent(agentId)}`);
		} catch (error) {
			this.options.logger.warn(`Dial config fetch for ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
		if (response.status === 404) {
			this.options.logger.info(`Dial config fetch for ${label}: agent no longer exists`);
			return undefined;
		}
		if (response.status < 200 || response.status >= 300) {
			this.options.logger.warn(`Dial config fetch for ${label} failed with status ${response.status}`);
			return undefined;
		}
		let parsed: { endpoint?: { url?: unknown; authorization?: unknown }; customParameters?: unknown };
		try {
			parsed = JSON.parse(response.body);
		} catch {
			this.options.logger.warn(`Dial config for ${label} is not JSON`);
			return undefined;
		}
		const url = parsed?.endpoint?.url;
		if (typeof url !== 'string') {
			this.options.logger.warn(`Dial config for ${label} has no endpoint.url`);
			return undefined;
		}
		const authorization = parsed.endpoint?.authorization;
		const customParameters = parsed.customParameters;
		return {
			endpoint: { url, ...(typeof authorization === 'string' ? { authorization } : {}) },
			...(customParameters !== null && typeof customParameters === 'object' && !Array.isArray(customParameters)
				? { customParameters: customParameters as Record<string, unknown> }
				: {}),
		};
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
				status = (await this.request('POST', 'status', body)).status;
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

	private send(method: 'GET' | 'POST', path: string, body?: string): Promise<ProvisioningResponse> {
		const url = new URL(path, this.options.url.replace(/\/+$/, '') + '/');
		const transport = url.protocol === 'https:' ? https : http;
		return new Promise((resolve, reject) => {
			const request = transport.request(url, {
				method,
				timeout: this.options.timeoutMs ?? 5000,
				headers: {
					Accept: 'application/json',
					...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
					...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
					...(this.options.host ? { Host: this.options.host } : {}),
				},
			}, (response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
				response.on('error', reject);
			});
			request.on('timeout', () => request.destroy(new Error('timeout')));
			request.on('error', reject);
			request.end(body);
		});
	}
}
