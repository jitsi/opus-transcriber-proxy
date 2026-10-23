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

// Minimal event emitter so the translation core doesn't depend on node:events (unavailable in a
// Worker without nodejs_compat). Covers just the on/emit surface TranslatorProxy needs.

type Handler = (...args: any[]) => void;

export class Emitter {
	private readonly handlers = new Map<string, Handler[]>();

	on(event: string, handler: Handler): this {
		const list = this.handlers.get(event);
		if (list) {
			list.push(handler);
		} else {
			this.handlers.set(event, [handler]);
		}
		return this;
	}

	emit(event: string, ...args: any[]): void {
		const list = this.handlers.get(event);
		if (list === undefined) return;
		// Copy so a handler that (un)subscribes during dispatch doesn't disturb this pass.
		for (const handler of [...list]) {
			try {
				handler(...args);
			} catch (err) {
				// A throwing handler must not prevent the others from running, but log it so the
				// failure is traceable rather than silently swallowed.
				console.error(`Emitter handler for "${event}" threw:`, err);
			}
		}
	}
}
