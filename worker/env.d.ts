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

// Environment types for the Cloudflare Worker

import type { TranscriberContainer } from './TranscriberContainer';
import type { TranscriptionDispatcher, DispatcherTranscriptionMessage } from './types';
import type { ContainerCoordinator } from './ContainerCoordinator';
import type { WorkerVars } from './vars';

/**
 * The Worker's bindings, plus every string variable declared in worker/vars.ts (`WorkerVars`).
 * Declare a new variable there, not here: the table also says how it reaches the container and
 * whether it may be overridden from KV.
 */
export interface Env extends WorkerVars {
	// Durable Object binding for the container
	TRANSCRIBER: DurableObjectNamespace<TranscriberContainer>;

	// Dispatcher Durable Object (for WebSocket connection - preferred)
	// This avoids the 1000 subrequest limit by using WebSocket messages
	DISPATCHER_DO?: DurableObjectNamespace;

	// Service bindings (kept for backwards compatibility)
	TRANSCRIPTION_DISPATCHER?: Service<TranscriptionDispatcher>;

	// Queue binding for transcription dispatch (fallback)
	TRANSCRIPTION_QUEUE?: Queue<DispatcherTranscriptionMessage>;

	// Durable Object for auto-scaling
	CONTAINER_COORDINATOR: DurableObjectNamespace<ContainerCoordinator>;

	// Deployed Worker version metadata (wrangler `version_metadata` binding). Optional so the
	// worker still runs if the binding is not configured.
	CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };

	// Operator-controlled runtime config, read per request: the provider overrides
	// (worker/providerOverride.ts) and the config overrides of the variables worker/vars.ts marks
	// KV-overridable (worker/configOverride.ts). Optional: with no binding, no override is applied.
	CONFIG_KV?: KVNamespace;
}
