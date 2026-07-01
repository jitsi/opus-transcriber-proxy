// Node-only WASM source: loads the Emscripten glue and compiles the WASM modules from disk, then
// registers them with the shared WASM decoder/encoder (provideDecoderWasm / provideEncoderWasm).
//
// This module imports `fs` and the `dist/opus-*.cjs` glue, so it must NEVER enter the Cloudflare
// Worker's import graph. It is loaded only via dynamic import() on the Node facade's wasm path, so a
// native container never touches it either; the Worker supplies its own binding instead.

import OpusDecoderModule from '../../dist/opus-decoder.cjs';
import OpusEncoderModuleFactory from '../../dist/opus-encoder.cjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { provideDecoderWasm } from './OpusDecoderWasm';
import { provideEncoderWasm } from '../OpusEncoder/OpusEncoderWasm';

const dir = path.dirname(fileURLToPath(import.meta.url));
let registered = false;

/** Idempotently register the Node (filesystem-loaded) WASM binding for the decoder and encoder. */
export function registerNodeOpusWasm(): void {
	if (registered) return;
	registered = true;
	const decoderModule = new WebAssembly.Module(fs.readFileSync(path.join(dir, '../../dist/opus-decoder.wasm')));
	const encoderModule = new WebAssembly.Module(fs.readFileSync(path.join(dir, '../../dist/opus-encoder.wasm')));
	provideDecoderWasm(OpusDecoderModule as any, decoderModule);
	provideEncoderWasm(OpusEncoderModuleFactory as any, encoderModule);
}
