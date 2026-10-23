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

// Worker-safe timer helper shared by the translation core and the Node backends. Lives under
// src/translate/ so the Worker bundle can import it (no node-only deps) — see check-worker-safe.mjs.

/**
 * Don't let a timer keep the process alive. `unref` exists on Node's Timeout but not on the
 * Worker's numeric timer id, so probe for it; the cast bridges both return types.
 */
export function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
	(timer as unknown as { unref?: () => void }).unref?.();
}
