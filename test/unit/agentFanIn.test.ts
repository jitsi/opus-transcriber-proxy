/*
 * Copyright @ 2025 - Present, 8x8 Inc
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
