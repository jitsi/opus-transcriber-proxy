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

// Runtime-neutral base64, so the translation core doesn't depend on Node's Buffer (unavailable in a
// Worker without nodejs_compat).
//
// This sits on the per-frame hot path (every Opus frame in and out is base64), so the portable
// atob/btoa implementation — 20-100x slower than Buffer — is only the fallback:
//  - where Uint8Array.toBase64/fromBase64 exist (workerd, Node >= 24) they are used directly;
//  - the Node runtime injects Buffer-based implementations via provideBase64() (nodeRuntime.ts),
//    covering the container's node:22, which has neither toBase64 nor (here) a reason to avoid Buffer.
// This module stays Buffer-free so it remains Worker-safe (enforced by check-worker-safe.mjs).

type Encode = (bytes: Uint8Array) => string;
type Decode = (b64: string) => Uint8Array;

function encodePortable(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000; // stay well under the String.fromCharCode argument-count limit
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function decodePortable(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

const hasNative = typeof (Uint8Array.prototype as any).toBase64 === 'function' && typeof (Uint8Array as any).fromBase64 === 'function';

let encodeImpl: Encode = hasNative ? (bytes) => (bytes as any).toBase64() : encodePortable;
let decodeImpl: Decode = hasNative ? (b64) => (Uint8Array as any).fromBase64(b64) : decodePortable;

/** Override the base64 implementation (the Node runtime injects Buffer-based ones — see nodeRuntime.ts). */
export function provideBase64(encode: Encode, decode: Decode): void {
	encodeImpl = encode;
	decodeImpl = decode;
}

export function bytesToBase64(bytes: Uint8Array): string {
	return encodeImpl(bytes);
}

export function base64ToBytes(b64: string): Uint8Array {
	return decodeImpl(b64);
}
