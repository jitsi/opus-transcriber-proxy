/*
 * Copyright @ 2026 - present 8x8, Inc.
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

/**
 * The Node translation runtime reads its settings from the environment: a dropped line here would leave a
 * variable documented but inert, which no proxy test (they build the config by hand) would notice.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('createNodeTranslationRuntime', () => {
	beforeEach(() => vi.resetModules());
	afterEach(() => vi.unstubAllEnvs());

	it('parses XAI_TRANSLATION_VOICES into the runtime config, deduplicated', async () => {
		vi.stubEnv('XAI_API_KEY', 'k');
		vi.stubEnv('XAI_TRANSLATION_VOICES', 'ara, rex,ara');
		const { createNodeTranslationRuntime } = await import('../../src/translate/nodeRuntime');
		expect(createNodeTranslationRuntime().config.xaiVoices).toEqual(['ara', 'rex']);
	});

	it('leaves xaiVoices unset when the variable is unset or names nothing', async () => {
		vi.stubEnv('XAI_API_KEY', 'k');
		vi.stubEnv('XAI_TRANSLATION_VOICES', ' , ');
		const { createNodeTranslationRuntime } = await import('../../src/translate/nodeRuntime');
		expect(createNodeTranslationRuntime().config.xaiVoices).toBeUndefined();
	});
});
