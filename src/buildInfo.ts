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

// Build-time information baked into the bundle.
//
// `__GIT_HASH__` is replaced at bundle time by esbuild (see build.mjs) with the git commit the
// build was made from. When running unbundled (tsx dev), the identifier is undefined, so we fall
// back to the GIT_HASH env var and finally to 'dev'. This makes the running commit observable at
// runtime regardless of how the image was built (docker:build or wrangler/Cloudflare).
//
// `process` is accessed via globalThis so this module also typechecks/runs in the Worker bundle
// (worker/translationRuntime.ts imports it for the /translate info message).
declare const __GIT_HASH__: string;

export const GIT_HASH: string =
	typeof __GIT_HASH__ !== 'undefined' ? __GIT_HASH__ : ((globalThis as any).process?.env?.GIT_HASH ?? 'dev');
