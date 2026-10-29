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
	/** 404 for the agent: it no longer exists. */
	| { status: 'gone' }
	/**
	 * The API could not be reached, answered with an error other than 404, or answered with something that is not a
	 * dial config. All are the API's problem rather than the agent's, so worth retrying. With haproxy routing a 404
	 * saying the room is unknown counts here too: the call reached a shard that does not hold the room.
	 */
	| { status: 'unavailable'; reason: string }
	/** The conference names nothing haproxy routing can place (see [conferenceRoute]), so no request was made. */
	| { status: 'unroutable'; reason: string };

export interface ProvisioningResponse {
	status: number;
	body: string;
}

export type ProvisioningRouting = 'direct' | 'haproxy';

export interface ProvisioningClientOptions {
	/** Base URL of the provisioning API's internal routes (prosody's `/voice-agent`, or the JaaS gateway). Empty disables. */
	url: string;
	/**
	 * How the API is reached. `direct` (default): `<url>/<route>`, one prosody or a gateway that routes by itself.
	 * `haproxy`: a sharded deployment behind its HAProxy, which picks the shard holding the room from the URL, so the
	 * tenant goes in front of the base path and the room into a `room` query parameter, appended last:
	 * `https://<signal-api host>/<tenant>/voice-agent/dial?conference=…&agentId=…&room=<room>`.
	 */
	routing?: ProvisioningRouting;
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
 * sent `end`). Status reports retry a transport error or 5xx with backoff; a 404 means the agent is already gone
 * (under haproxy routing, also that the shard reached does not hold the room).
 */
export class ProvisioningClient {
	private readonly request: (method: 'GET' | 'POST', path: string, body?: string) => Promise<ProvisioningResponse>;
	private readonly routing: ProvisioningRouting;
	/** The API's path under its origin, for haproxy routing (the tenant goes in front of it). */
	private readonly basePath: string;

	constructor(private readonly options: ProvisioningClientOptions) {
		this.routing = options.routing ?? 'direct';
		this.basePath = this.routing === 'haproxy' && options.url ? new URL(options.url).pathname.replace(/\/+$/, '') : '';
		this.request = options.request ?? ((method, path, body) => this.send(method, path, body));
	}

	/**
	 * The request path for a route about `conference`. With haproxy routing it is absolute on the API's origin:
	 * `/<tenant>/<base path>/<route>?…&room=<room>`, the form HAProxy keys its stick table on: the tenant from the
	 * path and the room from the parameter, both lower-cased, `%25` normalised to `%` and nothing else decoded. So
	 * the room must be spelled byte for byte as the meeting's own connection spells it (see [conferenceRoute]).
	 */
	private route(path: string, conference: string): string {
		if (this.routing !== 'haproxy') {
			return path;
		}
		if (/@breakout\./.test(conference)) {
			// A breakout room's JID names nothing HAProxy knows; the main room is not on this leg's URL.
			this.options.logger.warn(`haproxy routing cannot place breakout room ${conference}: routed by its own id`);
		}
		const { tenant, room } = conferenceRoute(conference);
		const [pathname, query = ''] = path.split('?');
		// The tenant stays one path segment whatever the name holds; the room is a form field, as jitsi-meet sends it.
		return `${tenant ? `/${encodeURIComponent(tenant)}` : ''}${this.basePath}/${pathname}?${query ? `${query}&` : ''}${new URLSearchParams({ room })}`;
	}

	/**
	 * Whether a 404 says the room, not the agent, is unknown. Under haproxy routing that most likely means the call
	 * reached a shard without the room (a breakout room, or a spelling HAProxy keys differently from the meeting's),
	 * worth saying with the path that was tried; the shard that held a meeting answers the same once the meeting is
	 * over, which cannot be told apart here. One prosody answers it only in that last case, when the agent is gone
	 * too, so under direct routing it is not looked at.
	 */
	private roomNotFound(label: string, response: ProvisioningResponse, path: string): boolean {
		if (this.routing !== 'haproxy') {
			return false;
		}
		let error: unknown;
		try {
			error = (JSON.parse(response.body) as { error?: unknown })?.error;
		} catch {
			return false;
		}
		if (typeof error !== 'string' || !/room not found/i.test(error)) {
			return false;
		}
		this.options.logger.warn(`${label}: ${path} answered 404 ${JSON.stringify(error)}, the shard reached does not hold the room (or the meeting is over)`);
		return true;
	}

	get enabled(): boolean {
		return this.options.url !== '';
	}

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
		let path: string;
		try {
			path = this.route(`dial?conference=${encodeURIComponent(conference)}&agentId=${encodeURIComponent(agentId)}`, conference);
		} catch (error) {
			// Nothing a retry would change, and a status report could not be routed either.
			const reason = error instanceof Error ? error.message : String(error);
			this.options.logger.warn(`Dial config fetch for ${label} cannot be routed: ${reason}`);
			return { status: 'unroutable', reason: `conference cannot be routed: ${reason}` };
		}
		let response: ProvisioningResponse;
		try {
			response = await this.request('GET', path);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.options.logger.warn(`Dial config fetch for ${label} failed: ${reason}`);
			return { status: 'unavailable', reason: `provisioning API unreachable: ${reason}` };
		}
		if (response.status === 404) {
			if (this.roomNotFound(label, response, path)) {
				return { status: 'unavailable', reason: 'provisioning API does not know the room on the shard reached' };
			}
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
			return { status: 'unavailable', reason: 'provisioning API answered without JSON' };
		}
		const url = parsed?.endpoint?.url;
		if (typeof url !== 'string') {
			this.options.logger.warn(`Dial config for ${label} has no endpoint.url`);
			return { status: 'unavailable', reason: 'provisioning API answered without endpoint.url' };
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
		let path: string;
		try {
			path = this.route('status', conference);
		} catch (error) {
			// A conference that cannot be routed never will be; retrying would only repeat the log line.
			this.options.logger.warn(`Status report for ${label} cannot be routed: ${error instanceof Error ? error.message : String(error)}`);
			this.options.onReportGivenUp?.(state);
			return;
		}
		// The route is idempotent and forward-only, so retrying is safe; a report that gives up leaves the agent in
		// the wrong state for good (connecting with media flowing, or active after it ended), so try for a while.
		const maxAttempts = this.options.maxAttempts ?? 5;
		const baseDelayMs = this.options.retryDelayMs ?? 1000;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			let response: ProvisioningResponse | undefined;
			try {
				response = await this.request('POST', path, body);
			} catch (error) {
				this.options.logger.warn(`Status report for ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			const status = response?.status ?? -1;
			if (status >= 200 && status < 300) {
				return;
			}
			if (response?.status === 404) {
				if (this.roomNotFound(label, response, path)) {
					// The same token reaches the same shard again; the give-up is what makes the misroute countable.
					this.options.onReportGivenUp?.(state);
				} else {
					this.options.logger.info(`Status report for ${label}: agent no longer exists`);
				}
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
		// A relative route resolves under the base path; an absolute one (haproxy routing) under the origin.
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

/**
 * The tenant and room of a conference, spelled for HAProxy's stick token: the tenant lower-cased, the room as
 * jitsi-meet puts it on the meeting's own `?room=` (decoded, a malformed escape kept as typed, NFKC-normalised,
 * lower-cased; the caller form-encodes it the way `URLSearchParams` does there). The MUC JID's node is that
 * name percent-encoded, so it is decoded here. Accepts the JID jicofo sends (`room@conference.<domain>`,
 * `[tenant]room@…` on a multi-tenant deployment) and the public form (`<tenant>/<room>` or `<room>`).
 */
export function conferenceRoute(conference: string): { tenant?: string; room: string } {
	let tenant: string | undefined;
	let room: string;
	const trimmed = conference.trim();
	const at = trimmed.indexOf('@');
	if (at !== -1) {
		const node = trimmed.slice(0, at);
		const match = /^\[([^\]]*)\](.*)$/.exec(node);
		[tenant, room] = match ? [match[1], match[2]] : [undefined, node];
	} else {
		const path = trimmed.replace(/^\/+|\/+$/g, '');
		const slash = path.indexOf('/');
		[tenant, room] = slash === -1 ? [undefined, path] : [path.slice(0, slash), path.slice(slash + 1)];
		if (room.includes('/')) {
			// Which slash separates the tenant is anyone's guess; a room's own slash arrives encoded in a JID.
			throw new Error(`conference ${JSON.stringify(conference)} does not name one room`);
		}
	}
	room = normalizeRoom(room);
	if (!room) {
		throw new Error(`conference ${JSON.stringify(conference)} does not name one room`);
	}
	tenant = tenant?.toLowerCase();
	// A tenant is one path segment; `.` and `..` would change the request, not pick a shard.
	if (tenant !== undefined && (!tenant || tenant === '.' || tenant === '..')) {
		throw new Error(`conference ${JSON.stringify(conference)} does not name a tenant`);
	}
	return tenant === undefined ? { room } : { tenant, room };
}

/** jitsi-meet's `getNormalizedRoomName`: decoded when it decodes, then NFKC and lower case. */
function normalizeRoom(spelled: string): string {
	let room = spelled;
	try {
		room = decodeURIComponent(spelled);
	} catch {
		// Not an encoded name, only one that looks like it; jitsi-meet keeps it as typed too.
	}
	return room.normalize('NFKC').toLowerCase();
}
