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

// Loader for the native libopus N-API addon (build/Release/opus_native.node).
//
// The addon is compiled by node-gyp (`npm run build:native`). It is loaded via
// createRequire so this works both under tsx/ESM during development and inside
// the esbuild-produced bundle in the container (where a static `import` of a
// .node file is not possible). We probe a small set of known locations rather
// than depend on the `bindings` package so resolution is fully predictable.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NativeOpusDecoder {
	/**
	 * @param packet    Opus packet, or null for packet-loss concealment (PLC).
	 * @param frameSize Maximum output samples per channel to produce.
	 * @param fec       Recover the previous frame via in-band FEC.
	 * @returns Little-endian interleaved int16 PCM.
	 * @throws Error carrying the libopus error string on a negative return code.
	 */
	decode(packet: Buffer | null, frameSize: number, fec: boolean): Buffer;
	reset(): void;
	destroy(): void;
}

export interface NativeOpusEncoder {
	/**
	 * @param pcm       Little-endian interleaved int16 PCM for exactly one frame.
	 * @param frameSize Samples per channel in `pcm`.
	 * @returns The encoded Opus packet plus whether libopus treated it as a DTX frame (only
	 *          meaningful when DTX is enabled via {@link setDtx}).
	 */
	encode(pcm: Buffer, frameSize: number): { packet: Buffer; inDtx: boolean };
	setBitrate(bitrate: number): void;
	setComplexity(complexity: number): void;
	/** Enable/disable Opus DTX (OPUS_SET_DTX). */
	setDtx(enable: boolean): void;
	destroy(): void;
}

export interface NativeOpusModule {
	OpusDecoder: new (sampleRate: number, channels: number) => NativeOpusDecoder;
	OpusEncoder: new (sampleRate: number, channels: number, application: number) => NativeOpusEncoder;
}

/** libopus OPUS_APPLICATION_* constants. */
export const OPUS_APPLICATION = {
	voip: 2048,
	audio: 2049,
	restricted_lowdelay: 2051,
} as const;

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const candidates = [
	path.resolve(process.cwd(), 'build/Release/opus_native.node'),
	// src/OpusDecoder/ -> project root
	path.resolve(moduleDir, '../../build/Release/opus_native.node'),
	// dist/bundle/ or dist/ -> project root (bundled / compiled layouts)
	path.resolve(moduleDir, '../../../build/Release/opus_native.node'),
];

function loadNativeOpus(): NativeOpusModule {
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return require(candidate) as NativeOpusModule;
		}
	}
	throw new Error(`Native Opus addon not found. Run "npm run build:native". Searched:\n  ${candidates.join('\n  ')}`);
}

export const nativeOpus: NativeOpusModule = loadNativeOpus();
