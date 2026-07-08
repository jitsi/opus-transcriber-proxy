/**
 * Regression test for provideDecoderWasm's module-cache reset: previously the cached
 * `_opusModule` promise from a prior registration would survive a re-registration, so
 * getOpusModule() kept resolving to the stale binding instead of the newly-provided one
 * (a latent test-ordering hazard flagged in PR review).
 */
import { describe, it, expect } from 'vitest';
import { provideDecoderWasm, OpusDecoderWasm } from '../../src/OpusDecoder/OpusDecoderWasm';

/**
 * A minimal fake Emscripten module factory: getOpusModule() only awaits the factory's return value
 * and reads fields off it — it never inspects how (or whether) the factory calls the `instantiateWasm`
 * option it's given, so this stubs it out entirely rather than doing a real WebAssembly.Instance.
 */
function fakeFactory(marker: string) {
	return async () => ({
		marker,
		_opus_frame_decoder_create: () => 0,
		_opus_frame_decoder_destroy: () => {},
		_opus_frame_decoder_reset: () => {},
		_opus_frame_decode: () => 0,
		_malloc: () => 0,
		_free: () => {},
		wasmMemory: { buffer: new ArrayBuffer(0) },
	});
}

// A throwaway compiled module is fine — instantiateWasm is faked above and never touches it for real.
const fakeModule = {} as WebAssembly.Module;

describe('provideDecoderWasm module cache reset', () => {
	it('re-registration is reflected by the next getOpusModule() call, not the stale one', async () => {
		provideDecoderWasm(fakeFactory('first'), fakeModule);
		const first = await OpusDecoderWasm.getOpusModule();
		expect((first as any).module.marker).toBe('first');

		provideDecoderWasm(fakeFactory('second'), fakeModule);
		const second = await OpusDecoderWasm.getOpusModule();
		expect((second as any).module.marker).toBe('second');
	});

	it('resetModule() clears the cache so the next call re-resolves from the current binding', async () => {
		provideDecoderWasm(fakeFactory('a'), fakeModule);
		await OpusDecoderWasm.getOpusModule();

		OpusDecoderWasm.resetModule();
		provideDecoderWasm(fakeFactory('b'), fakeModule);
		const resolved = await OpusDecoderWasm.getOpusModule();
		expect((resolved as any).module.marker).toBe('b');
	});
});
