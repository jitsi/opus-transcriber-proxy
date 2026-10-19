/**
 * How several participants' audio reaches the agent, chosen per agent at invite time (`fanIn`):
 * every exported source as its own stream, or only the dominant speaker's (as the bridge ranks them).
 */
export type AgentFanIn = 'per-source' | 'dominant';

export const DEFAULT_AGENT_FAN_IN: AgentFanIn = 'per-source';

export function isAgentFanIn(value: unknown): value is AgentFanIn {
	return value === 'per-source' || value === 'dominant';
}
