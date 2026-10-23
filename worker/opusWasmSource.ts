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

// Worker WASM source: supplies the Opus decoder/encoder with their Emscripten glue + compiled
// WebAssembly.Module via workerd's static imports (no filesystem), registering them with the shared
// WASM impls. Mirrors src/OpusDecoder/wasmSourceNode.ts, but for the Worker runtime.

import decoderWasm from '../dist/opus-decoder.wasm';
import encoderWasm from '../dist/opus-encoder.wasm';
import decoderGlue from '../dist/opus-decoder.cjs';
import encoderGlue from '../dist/opus-encoder.cjs';
import { provideDecoderWasm } from '../src/OpusDecoder/OpusDecoderWasm';
import { provideEncoderWasm } from '../src/OpusEncoder/OpusEncoderWasm';

let registered = false;

/** Idempotently register the Worker (import-loaded) WASM binding for the decoder and encoder. */
export function registerWorkerOpusWasm(): void {
	if (registered) return;
	registered = true;
	provideDecoderWasm(decoderGlue, decoderWasm);
	provideEncoderWasm(encoderGlue, encoderWasm);
}
