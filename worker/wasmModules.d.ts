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

// workerd/wrangler import types for the prebuilt Opus artifacts.
// `.wasm` imports resolve to a compiled WebAssembly.Module; the `.cjs` Emscripten glue resolves to
// its module factory function.
declare module '*.wasm' {
	const module: WebAssembly.Module;
	export default module;
}
declare module '*.cjs' {
	const factory: any;
	export default factory;
}
