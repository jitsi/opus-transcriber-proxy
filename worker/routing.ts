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

import type { Env } from './env';

/**
 * Choose which container instance to route this request to.
 * Multiple routing strategies are available depending on your use case.
 */
export async function selectContainerInstance(request: Request, env: Env): Promise<string> {
	const url = new URL(request.url);
	const sessionId = url.searchParams.get('sessionId');
	const routingMode = env.ROUTING_MODE || 'session'; // 'pool', 'session', 'shared', or 'autoscale'

	switch (routingMode) {
		case 'autoscale':
			// Auto-scaling with coordinator: Automatically creates containers as needed
			// Use when: Variable traffic, want automatic scaling
			// Scaling: Dynamic based on load (coordinator manages)
			if (!sessionId) {
				throw new Error('sessionId required for autoscale mode');
			}
			const coordinator = env.CONTAINER_COORDINATOR.get(env.CONTAINER_COORDINATOR.idFromName('global'));
			const assignResponse = await coordinator.fetch(new URL('http://coordinator/assign'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId }),
			});
			const { containerId } = await assignResponse.json<{ containerId: string }>();
			return containerId;

		case 'session':
			// Session affinity: Each sessionId gets its own container
			// Use when: You need persistent state per session
			// Scaling: One container per unique session (can be expensive)
			return sessionId || 'default';

		case 'shared':
			// Single shared container for all sessions
			// Use when: Low traffic, simple setup, minimal cold starts
			// Scaling: Fixed at 1 container
			return 'shared';

		case 'pool':
		default:
			// Pool-based routing: Distribute across a pool of containers
			// Use when: Many short-lived sessions, no per-session state needed
			// Scaling: Fixed pool size, containers stay warm, good for high throughput
			const poolSize = parseInt(env.CONTAINER_POOL_SIZE || '5', 10);

			// Hash the sessionId for consistent routing (optional)
			// If you want true randomness, use: Math.floor(Math.random() * poolSize)
			if (sessionId) {
				// Consistent hashing: Same sessionId → Same container (within pool)
				let hash = 0;
				for (let i = 0; i < sessionId.length; i++) {
					hash = (hash << 5) - hash + sessionId.charCodeAt(i);
					hash = hash & hash; // Convert to 32bit integer
				}
				const poolIndex = Math.abs(hash) % poolSize;
				return `pool-${poolIndex}`;
			} else {
				// No sessionId: Random load balancing
				const poolIndex = Math.floor(Math.random() * poolSize);
				return `pool-${poolIndex}`;
			}
	}
}
