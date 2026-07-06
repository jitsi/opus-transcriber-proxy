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
let registerPromise: Promise<void> | undefined;

/**
 * Idempotently register the Node (filesystem-loaded) WASM binding for the decoder and encoder.
 * Reads and compiles the WASM asynchronously (WebAssembly.compile) so it does not block the event
 * loop; called from the async decoder/encoder init paths. Concurrent callers share one registration.
 */
export function registerNodeOpusWasm(): Promise<void> {
	if (!registerPromise) {
		registerPromise = (async () => {
			const [decoderBytes, encoderBytes] = await Promise.all([
				fs.promises.readFile(path.join(dir, '../../dist/opus-decoder.wasm')),
				fs.promises.readFile(path.join(dir, '../../dist/opus-encoder.wasm')),
			]).then(bufs => bufs.map(b => new Uint8Array(b)));
			const [decoderModule, encoderModule] = await Promise.all([
				WebAssembly.compile(decoderBytes),
				WebAssembly.compile(encoderBytes),
			]);
			provideDecoderWasm(OpusDecoderModule as any, decoderModule);
			provideEncoderWasm(OpusEncoderModuleFactory as any, encoderModule);
		})();
	}
	return registerPromise;
}
