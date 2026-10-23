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

import type { TextTranslationRequest, TextTranslator } from './TextTranslator';

/**
 * A translator that does no translation: it prefixes the text with the upper-cased target language,
 * e.g. "hello" -> "[FR] hello".
 *
 * This exists to exercise the full signalling path (client language selection -> jicofo aggregation
 * -> colibri2 connect `requests` -> bridge `sources` event -> here -> back to the client) without a
 * translation provider. Real providers implement the same {@link TextTranslator} interface.
 *
 * It deliberately ignores `history` and the speaker label, exactly as a real provider must never
 * put them in its output.
 */
export class StubTextTranslator implements TextTranslator {
	async translate(request: TextTranslationRequest): Promise<string> {
		return `[${request.targetLanguage.toUpperCase()}] ${request.turn.text}`;
	}
}
