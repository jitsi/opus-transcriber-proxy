/*
 * Copyright @ 2026 - present 8x8, Inc.
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

import type { MixGain, MixLimiter } from '../mixConfig';

const PCM16_MAX = 32767;
const PCM16_MIN = -32768;

/** The sample value of a level in dBFS (0 dBFS is full scale). */
export function kneeFromDb(db: number): number {
	return Math.round(PCM16_MAX * Math.pow(10, db / 20));
}

/**
 * The factor the sum of `sources` streams is scaled by. `unity` leaves every speaker at the level of their own
 * stream, whoever else talks; the other two lower everyone as sources join, which is what makes a mix pump when
 * the set of sources changes often. They exist to be compared against `unity`, not as recommendations.
 */
export function mixGain(mode: MixGain, sources: number): number {
	if (mode === 'unity' || sources <= 1) {
		return 1;
	}
	return mode === 'sqrt' ? 1 / Math.sqrt(sources) : 1 / sources;
}

/** Scales `sum` in place by a gain that moves in a straight line from `from` to `to` across the frame (no step, so no click). */
export function applyGainRamp(sum: Float64Array, from: number, to: number): void {
	if (from === 1 && to === 1) {
		return;
	}
	const step = (to - from) / sum.length;
	for (let i = 0; i < sum.length; i++) {
		sum[i] *= from + step * (i + 1);
	}
}

/**
 * Writes `sum` to `out` as PCM16, keeping it within 16 bits, and says whether any sample had to be changed.
 *
 * `soft` leaves every sample below the knee as it is and bends the rest towards full scale, which it approaches
 * but never passes: `knee + (max - knee) * tanh((|x| - knee) / (max - knee))`. The curve has slope 1 at the knee,
 * so there is no corner, and it has no state: a loud moment changes those samples only, never the gain of what
 * follows. `clamp` cuts at full scale.
 */
export function limitToPcm16(sum: Float64Array, out: Int16Array, limiter: MixLimiter, knee: number): boolean {
	const soft = limiter === 'soft' && knee < PCM16_MAX;
	const range = PCM16_MAX - knee;
	let limited = false;
	for (let i = 0; i < sum.length; i++) {
		let x = sum[i];
		if (soft) {
			const magnitude = Math.abs(x);
			if (magnitude > knee) {
				limited = true;
				x = Math.sign(x) * (knee + range * Math.tanh((magnitude - knee) / range));
			}
		}
		if (x > PCM16_MAX) {
			limited = true;
			x = PCM16_MAX;
		} else if (x < PCM16_MIN) {
			limited = true;
			x = PCM16_MIN;
		}
		out[i] = Math.round(x);
	}
	return limited;
}
