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

/** What the log lines report of a WebSocket close event; a runtime may leave any of it out. */
export interface CloseEventLike {
	code?: number;
	reason?: string;
	wasClean?: boolean;
}

/** A close event for a log line; the reason is the peer's string, quoted so it cannot split the line. */
export function describeClose(event: CloseEventLike | undefined): string {
	return `code=${event?.code ?? 'none'} reason=${JSON.stringify(event?.reason ?? '')} wasClean=${event?.wasClean ?? 'unknown'}`;
}
