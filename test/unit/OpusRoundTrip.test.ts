/**
 * End-to-end integration test for the opus encoder ↔ decoder round trip.
 *
 * Loads the real WASM artefacts (both opus-decoder.cjs and opus-encoder.cjs)
 * and validates that a sine wave round-trips through encode → decode with
 * matching-energy PCM output. Phase-aligned SNR is too sensitive to opus's
 * ~6.5 ms algorithmic delay for a build-time check, so we measure RMS
 * energy plus opus packet-size sanity bounds — that catches the real bugs
 * (silent encoder, garbage decoder, wrong sample-rate path) without
 * depending on cross-correlation tuning.
 *
 * Requires `npm run build:wasm` to have produced both dist artefacts.
 * Skipped if either is missing so unit-test runs in environments that
 * haven't built WASM stay green.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Type-only imports: the concrete modules (which statically import the real dist/*.cjs WASM) are loaded
// dynamically in beforeAll so that, when the WASM artefacts are absent (e.g. CI without `build:wasm`), this
// suite skips cleanly instead of failing at collection time on the missing modules.
import type { OpusEncoder } from '../../src/OpusEncoder/OpusEncoder';
import type { OpusDecoder } from '../../src/OpusDecoder/OpusDecoder';

// Matches the rate the TranslatorConnection pipeline uses end-to-end.
const SAMPLE_RATE = 24000;
const TONE_HZ = 440;
const TONE_AMPLITUDE = 16000; // ~half scale; well clear of clipping
const TOTAL_DURATION_SEC = 1;
const TOTAL_SAMPLES = SAMPLE_RATE * TOTAL_DURATION_SEC;

// Loose energy bounds — see file-header comment.
const MIN_ENERGY_RATIO = 0.25;
const MAX_ENERGY_RATIO = 4.0;

const wasmDistExists =
	fs.existsSync(path.join(__dirname, '../../dist/opus-decoder.wasm'))
	&& fs.existsSync(path.join(__dirname, '../../dist/opus-decoder.cjs'))
	&& fs.existsSync(path.join(__dirname, '../../dist/opus-encoder.wasm'))
	&& fs.existsSync(path.join(__dirname, '../../dist/opus-encoder.cjs'));

const describeIfWasm = wasmDistExists ? describe : describe.skip;

function generateSineWavePcm16(samples: number, sampleRate: number, freq: number, amplitude: number): Uint8Array {
	const out = new Uint8Array(samples * 2);
	const view = new DataView(out.buffer);
	const twoPi = 2 * Math.PI;
	for (let i = 0; i < samples; i++) {
		view.setInt16(i * 2, Math.round(amplitude * Math.sin((twoPi * freq * i) / sampleRate)), true);
	}
	return out;
}

function int16FromBytes(bytes: Uint8Array): Int16Array {
	return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

function meanSquareEnergy(samples: Int16Array): number {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples.length; i++) {
		sum += samples[i] * samples[i];
	}
	return sum / samples.length;
}

describeIfWasm('Opus round trip (encoder → decoder)', () => {
	let encoder: OpusEncoder;
	let decoder: OpusDecoder<24000>;
	let OpusEncoderClass: typeof import('../../src/OpusEncoder/OpusEncoder').OpusEncoder;

	beforeAll(async () => {
		const { OpusEncoder } = await import('../../src/OpusEncoder/OpusEncoder');
		const { OpusDecoder } = await import('../../src/OpusDecoder/OpusDecoder');
		OpusEncoderClass = OpusEncoder;

		encoder = new OpusEncoder({
			sampleRate: SAMPLE_RATE,
			channels: 1,
			application: 'voip',
			bitrate: 32000,
		});
		decoder = new OpusDecoder<24000>({ sampleRate: SAMPLE_RATE, channels: 1 });
		await Promise.all([encoder.ready, decoder.ready]);
	}, 30000);

	it('round-trips a 440 Hz tone with comparable energy and sane opus packet sizes', () => {
		const pcm = generateSineWavePcm16(TOTAL_SAMPLES, SAMPLE_RATE, TONE_HZ, TONE_AMPLITUDE);

		// Encoder accumulates internally and returns one opus frame per 20 ms of PCM.
		const opusFrames = encoder.encodeFrame(pcm);
		expect(opusFrames.length).toBeGreaterThan(0);

		// At 32 kbps mono with 20 ms frames the average payload is ~80 bytes.
		// Allow generous bounds for VBR.
		const avgOpusBytes = opusFrames.reduce((s, f) => s + f.length, 0) / opusFrames.length;
		expect(avgOpusBytes).toBeGreaterThan(20);
		expect(avgOpusBytes).toBeLessThan(400);

		const decodedFrames: Int16Array[] = [];
		for (const opusFrame of opusFrames) {
			const decoded = decoder.decodeFrame(opusFrame);
			expect(decoded.errors).toHaveLength(0);
			expect(decoded.samplesDecoded).toBeGreaterThan(0);
			decodedFrames.push(int16FromBytes(decoded.audioData));
		}

		// Concatenate, skip first 5 frames (100 ms) for codec warm-up.
		const totalDecodedSamples = decodedFrames.reduce((n, f) => n + f.length, 0);
		const concatenated = new Int16Array(totalDecodedSamples);
		let offset = 0;
		for (const f of decodedFrames) {
			concatenated.set(f, offset);
			offset += f.length;
		}

		const skipSamples = Math.min(5 * (SAMPLE_RATE / 50), concatenated.length);
		const reference = int16FromBytes(generateSineWavePcm16(concatenated.length, SAMPLE_RATE, TONE_HZ, TONE_AMPLITUDE))
			.subarray(skipSamples);
		const measured = concatenated.subarray(skipSamples);

		const referenceEnergy = meanSquareEnergy(reference);
		const measuredEnergy = meanSquareEnergy(measured);
		const ratio = measuredEnergy / referenceEnergy;
		expect(ratio).toBeGreaterThan(MIN_ENERGY_RATIO);
		expect(ratio).toBeLessThan(MAX_ENERGY_RATIO);
	});

	it('accumulates non-frame-aligned input across calls and emits exactly one frame per 20 ms', async () => {
		// Feed the same 1 s tone in 700-byte chunks — deliberately NOT a multiple of the 1920-byte frame
		// (480 samples * 2 * 2... actually 960 bytes at 24 kHz mono) so most calls leave a partial-frame
		// remainder that must carry over to the next call. Exercises the cross-call buffering path.
		const chunkEncoder = new OpusEncoderClass({ sampleRate: SAMPLE_RATE, channels: 1, application: 'voip', bitrate: 32000 });
		await chunkEncoder.ready;
		try {
			const pcm = generateSineWavePcm16(TOTAL_SAMPLES, SAMPLE_RATE, TONE_HZ, TONE_AMPLITUDE);
			const frameBytes = (SAMPLE_RATE / 50) * 2; // 960 bytes = 20 ms mono @24kHz

			const frames: Uint8Array[] = [];
			for (let off = 0; off < pcm.length; off += 700) {
				frames.push(...chunkEncoder.encodeFrame(pcm.subarray(off, Math.min(off + 700, pcm.length))));
			}

			// Total bytes = TOTAL_SAMPLES*2; whole 20 ms frames produced = floor(total / frameBytes).
			expect(frames.length).toBe(Math.floor(pcm.length / frameBytes));
			// Every emitted frame is a valid, non-empty opus packet.
			for (const f of frames) {
				expect(f.length).toBeGreaterThan(0);
				expect(f.length).toBeLessThan(400);
			}
		} finally {
			chunkEncoder.free();
		}
	});

	it('frees both wrappers cleanly', () => {
		encoder.free();
		decoder.free();
	});
});
