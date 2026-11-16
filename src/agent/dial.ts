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

import { AgentFanIn, isAgentFanIn } from './fanIn';
import { AgentEncoding, isAgentEncoding } from './mediaFormat';
import { MixConfig, parseInlineMix } from './mixConfig';
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
	/** The inline options of the `mix` fan-in: the ones the dial config set, checked. */
	mix?: Partial<MixConfig>;
	/** Fields of the dial config's `mix` this relay does not know; ignored, and said once by the caller. */
	unknownMixOptions?: string[];
}

/**
 * How an /agent upgrade is answered. A transient failure (the provisioning API unavailable or answering garbage)
 * refuses the upgrade with HTTP 400, which the bridge retries. A permanent one (the agent gone, a conference the
 * relay cannot route, an agent config the relay cannot act on) is accepted and closed with the terminal code, so the
 * bridge stops redialing, and is reported `failed` once when it is the agent's config that is wrong.
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
		case 'unroutable':
			// A status report could not be routed either, so none is attempted.
			return { kind: 'permanent', reason: result.reason, report: false };
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
	// Read only for the fan-in it belongs to: a `mix` left on an agent that asks for another fan-in is not an error.
	let mix: Partial<MixConfig> | undefined;
	let unknownMixOptions: string[] | undefined;
	if (fanIn === 'mix') {
		if (encoding === 'audio/opus') {
			// A mix is decoded audio; encoding it again is not offered.
			return permanent('the mix fan-in needs audio/l16, not audio/opus');
		}
		const inline = parseInlineMix(dial.mix);
		if (!inline.ok) {
			return permanent(`invalid ${inline.error}`);
		}
		mix = inline.values;
		unknownMixOptions = inline.unknownOptions;
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
			...(mix !== undefined && Object.keys(mix).length > 0 ? { mix } : {}),
			...(unknownMixOptions !== undefined && unknownMixOptions.length > 0 ? { unknownMixOptions } : {}),
		},
	};
}
