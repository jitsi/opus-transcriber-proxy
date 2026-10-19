import { AgentFanIn, isAgentFanIn } from './fanIn';
import { AgentEncoding, isAgentEncoding } from './mediaFormat';
import type { AgentDialConfig, DialConfigResult } from './ProvisioningClient';

/** What an /agent connection dials, as resolved from the dial config. */
export interface ResolvedDial {
	url: string;
	authorization?: string;
	customParameters?: Record<string, unknown>;
	/** The room as the customer names it; the only form the agent ever sees. */
	publicConference?: string;
	encoding?: AgentEncoding;
	fanIn?: AgentFanIn;
}

/**
 * How an /agent upgrade is answered. A transient failure (the provisioning API unavailable) refuses the upgrade with
 * HTTP 400, which the bridge retries. A permanent one (the agent gone, a dial config the relay cannot act on) is
 * accepted and closed with the terminal code, so the bridge stops redialing, and is reported `failed` once when it
 * is the agent's config that is wrong.
 */
export type DialResolution =
	| { kind: 'dial'; dial: ResolvedDial }
	| { kind: 'transient'; reason: string }
	| { kind: 'permanent'; reason: string; report: boolean };

export function resolveDial(result: DialConfigResult, requireWss: boolean): DialResolution {
	switch (result.status) {
		case 'unavailable':
			return { kind: 'transient', reason: result.reason };
		case 'gone':
			return { kind: 'permanent', reason: 'agent no longer exists', report: false };
		case 'invalid':
			return { kind: 'permanent', reason: `invalid dial config: ${result.reason}`, report: true };
		case 'ok':
			return resolveDialConfig(result.config, requireWss);
	}
}

export function resolveDialConfig(dial: AgentDialConfig, requireWss: boolean): DialResolution {
	const permanent = (reason: string): DialResolution => ({ kind: 'permanent', reason, report: true });
	const encoding = dial.mediaFormat?.encoding;
	if (encoding !== undefined && !isAgentEncoding(encoding)) {
		// Speaking another format than the agent asked for would play noise to the meeting.
		return permanent(`unsupported media format ${encoding}`);
	}
	const fanIn = dial.fanIn;
	if (fanIn !== undefined && !isAgentFanIn(fanIn)) {
		return permanent(`unsupported fan-in ${fanIn}`);
	}
	let parsed: URL;
	try {
		parsed = new URL(dial.endpoint.url);
	} catch {
		return permanent('invalid agent endpoint URL');
	}
	if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && !requireWss)) {
		return permanent('agent endpoint must be wss:// (set AGENT_REQUIRE_WSS=false to allow ws:// in dev)');
	}
	return {
		kind: 'dial',
		dial: {
			url: parsed.toString(),
			...(dial.endpoint.authorization !== undefined ? { authorization: dial.endpoint.authorization } : {}),
			...(dial.customParameters !== undefined ? { customParameters: dial.customParameters } : {}),
			...(dial.conference !== undefined ? { publicConference: dial.conference } : {}),
			...(encoding !== undefined ? { encoding } : {}),
			...(fanIn !== undefined ? { fanIn } : {}),
		},
	};
}
