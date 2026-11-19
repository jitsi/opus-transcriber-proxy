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

import { describe, it, expect } from 'vitest';
import { defaultAgentFanIn, isAgentFanIn } from '../../src/agent/fanIn';

describe('agent fanIn', () => {
	it('defaults to the mix, and to per-source for Opus, which cannot be mixed', () => {
		expect(defaultAgentFanIn()).toBe('mix');
		expect(defaultAgentFanIn('audio/l16')).toBe('mix');
		expect(defaultAgentFanIn('audio/opus')).toBe('per-source');
	});

	it('knows the three fan-in policies', () => {
		expect(isAgentFanIn('per-source')).toBe(true);
		expect(isAgentFanIn('dominant')).toBe(true);
		expect(isAgentFanIn('mix')).toBe(true);
		expect(isAgentFanIn('Mix')).toBe(false);
		expect(isAgentFanIn('loudest')).toBe(false);
		expect(isAgentFanIn('Dominant')).toBe(false);
		expect(isAgentFanIn(undefined)).toBe(false);
	});
});
