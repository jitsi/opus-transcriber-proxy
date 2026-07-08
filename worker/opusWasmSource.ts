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
