import http from 'node:http';
import https from 'node:https';


/** The media-leg states the gateway reports; jicofo reports `connecting` and allocation failures itself. */
export type AgentLifecycleState = 'active' | 'failed' | 'ended';

/** What the provisioning API hands back for a dial: the customer endpoint and the opaque invite parameters. */
export interface AgentDialConfig {
	endpoint: { url: string; authorization?: string };
	customParameters?: Record<string, unknown>;
	/** The room as the customer names it (`<tenant>/<room>` or `<room>`), never the MUC JID. */
	conference?: string;
	/** The encoding the invite asked for on the customer leg, unchecked: the caller fails a dial it cannot speak. */
	mediaFormat?: { encoding: string };
	/** The fan-in the invite asked for, unchecked likewise. */
	fanIn?: string;
}

/** The outcome of fetching a dial config, so the caller can tell a retryable failure from a permanent one. */
export type DialConfigResult =
	| { status: 'ok'; config: AgentDialConfig }
	/** 404: the agent no longer exists. */
	| { status: 'gone' }
	/** The API answered, but not with a dial config the relay can act on. */
	| { status: 'invalid'; reason: string }
	/** The API could not be reached or answered with an error other than 404; worth retrying. */
	| { status: 'unavailable'; reason: string };

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
	/** Attempts per status report (default 5), spaced by retryDelayMs doubling each time. */
	maxAttempts?: number;
	/** Called when a status report gave up, so the condition is visible beyond the log. */
	onReportGivenUp?: (state: AgentLifecycleState) => void;
	/** The most response body read from the API (default 64 KiB); a dial config is small. */
	maxBodyBytes?: number;
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
	/** The dial config, or undefined when there is none to act on (see [fetchDialConfig] for why). */
	async dialConfig(conference: string, agentId: string): Promise<AgentDialConfig | undefined> {
		const result = await this.fetchDialConfig(conference, agentId);
		return result.status === 'ok' ? result.config : undefined;
	}

	async fetchDialConfig(conference: string, agentId: string): Promise<DialConfigResult> {
		if (!this.enabled) {
			return { status: 'unavailable', reason: 'no provisioning API configured' };
		}
		const label = `agent ${agentId}`;
		let response: ProvisioningResponse;
		try {
			response = await this.request('GET', `dial?conference=${encodeURIComponent(conference)}&agentId=${encodeURIComponent(agentId)}`);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.options.logger.warn(`Dial config fetch for ${label} failed: ${reason}`);
			return { status: 'unavailable', reason: `provisioning API unreachable: ${reason}` };
		}
		if (response.status === 404) {
			this.options.logger.info(`Dial config fetch for ${label}: agent no longer exists`);
			return { status: 'gone' };
		}
		if (response.status < 200 || response.status >= 300) {
			this.options.logger.warn(`Dial config fetch for ${label} failed with status ${response.status}`);
			return { status: 'unavailable', reason: `provisioning API answered ${response.status}` };
		}
		let parsed: {
			endpoint?: { url?: unknown; authorization?: unknown };
			customParameters?: unknown;
			conference?: unknown;
			mediaFormat?: { encoding?: unknown };
			fanIn?: unknown;
		};
		try {
			parsed = JSON.parse(response.body);
		} catch {
			this.options.logger.warn(`Dial config for ${label} is not JSON`);
			return { status: 'invalid', reason: 'not JSON' };
		}
		const url = parsed?.endpoint?.url;
		if (typeof url !== 'string') {
			this.options.logger.warn(`Dial config for ${label} has no endpoint.url`);
			return { status: 'invalid', reason: 'no endpoint.url' };
		}
		const authorization = parsed.endpoint?.authorization;
		const customParameters = parsed.customParameters;
		const publicConference = parsed.conference;
		const encoding = parsed.mediaFormat?.encoding;
		const fanIn = parsed.fanIn;
		const config: AgentDialConfig = {
			endpoint: { url, ...(typeof authorization === 'string' ? { authorization } : {}) },
			// The agent must never see an internal XMPP address, whatever the API returns.
			...(typeof publicConference === 'string' && publicConference !== '' && !publicConference.includes('@')
				? { conference: publicConference }
				: {}),
			...(typeof encoding === 'string' ? { mediaFormat: { encoding } } : {}),
			...(typeof fanIn === 'string' ? { fanIn } : {}),
			...(customParameters !== null && typeof customParameters === 'object' && !Array.isArray(customParameters)
				? { customParameters: customParameters as Record<string, unknown> }
				: {}),
		};
		return { status: 'ok', config };
	}

	async report(conference: string, agentId: string, state: AgentLifecycleState, reason?: string): Promise<void> {
		if (!this.enabled) {
			return;
		}
		const body = JSON.stringify({ conference, agentId, state, ...(reason ? { reason } : {}) });
		const label = `agent ${agentId} in ${conference} (${state})`;
		// The route is idempotent and forward-only, so retrying is safe; a report that gives up leaves the agent in
		// the wrong state for good (connecting with media flowing, or active after it ended), so try for a while.
		const maxAttempts = this.options.maxAttempts ?? 5;
		const baseDelayMs = this.options.retryDelayMs ?? 1000;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
			if (attempt < maxAttempts) {
				await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
			} else {
				this.options.logger.warn(`Status report for ${label} gave up after ${maxAttempts} attempts, last status ${status}`);
				this.options.onReportGivenUp?.(state);
			}
		}
	}

	private send(method: 'GET' | 'POST', path: string, body?: string): Promise<ProvisioningResponse> {
		const url = new URL(path, this.options.url.replace(/\/+$/, '') + '/');
		const transport = url.protocol === 'https:' ? https : http;
		const timeoutMs = this.options.timeoutMs ?? 5000;
		const maxBodyBytes = this.options.maxBodyBytes ?? 64 * 1024;
		return new Promise((resolve, reject) => {
			const request = transport.request(url, {
				method,
				// Node's own timeout is an idle timeout; the deadline below bounds the whole exchange.
				timeout: timeoutMs,
				headers: {
					Accept: 'application/json',
					...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
					...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
					...(this.options.host ? { Host: this.options.host } : {}),
				},
			}, (response) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on('data', (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > maxBodyBytes) {
						request.destroy(new Error(`response larger than ${maxBodyBytes} bytes`));
						return;
					}
					chunks.push(chunk);
				});
				response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
				response.on('error', reject);
			});
			const deadline = setTimeout(() => request.destroy(new Error('timeout')), timeoutMs);
			request.on('timeout', () => request.destroy(new Error('timeout')));
			request.on('error', reject);
			request.on('close', () => clearTimeout(deadline));
			request.end(body);
		});
	}
}
