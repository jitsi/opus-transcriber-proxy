import { describe, it, expect } from 'vitest';
import { DEFAULT_AGENT_FAN_IN, isAgentFanIn } from '../../src/agent/fanIn';

describe('agent fanIn', () => {
	it('knows the two fan-in policies, per-source being the default', () => {
		expect(DEFAULT_AGENT_FAN_IN).toBe('per-source');
		expect(isAgentFanIn('per-source')).toBe(true);
		expect(isAgentFanIn('dominant')).toBe(true);
		expect(isAgentFanIn('loudest')).toBe(false);
		expect(isAgentFanIn('Dominant')).toBe(false);
		expect(isAgentFanIn(undefined)).toBe(false);
	});
});
