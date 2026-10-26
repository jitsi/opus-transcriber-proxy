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

/**
 * A close code workerd will put in a close frame: 1000-1003, 1007-1014 and 3000-4999. Its `close()`
 * throws on anything else, notably 1005 (no status received) and 1006 (abnormal closure), which are
 * exactly what a socket *reports* when the peer sent no code or vanished. Forwarding one of those
 * unchanged turned a plain client disconnect into an error cascade that closed the container side
 * with 1011. `fallback` is what a peer's unsendable code should mean to the other side: a container
 * that vanished (1006) is reported to the bridge as 1011 so a crash stays visible, a client that
 * sent no code is reported to the container as 1000. Application codes (the agent protocol's 4xxx)
 * pass through.
 */
export function sendableCloseCode(code: number, fallback: number): number {
	const sendable = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
	return sendable ? code : fallback;
}
