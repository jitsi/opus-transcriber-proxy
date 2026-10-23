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

/**
 * How several participants' audio reaches the agent, chosen per agent at invite time (`fanIn`):
 * every exported source as its own stream, or only the dominant speaker's (as the bridge ranks them).
 */
export type AgentFanIn = 'per-source' | 'dominant';

export const DEFAULT_AGENT_FAN_IN: AgentFanIn = 'per-source';

export function isAgentFanIn(value: unknown): value is AgentFanIn {
	return value === 'per-source' || value === 'dominant';
}
