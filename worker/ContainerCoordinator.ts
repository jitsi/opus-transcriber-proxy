import { DurableObject } from 'cloudflare:workers';

/**
 * Container metadata tracked by the coordinator
 */
interface ContainerInfo {
	id: string;
	activeConnections: number;
	lastActivity: number;
	createdAt: number;
}

/**
 * Configuration for the coordinator
 */
interface CoordinatorConfig {
	maxConnectionsPerContainer: number;
	minContainers: number;
	scaleDownIdleTime: number; // milliseconds
}

/**
 * ContainerCoordinator manages container lifecycle and load balancing
 * - Assigns sessions to least-loaded containers
 * - Auto-scales up when containers reach capacity
 * - Tracks active connections per container
 */
export class ContainerCoordinator extends DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private containers: Map<string, ContainerInfo>;
	private sessionToContainer: Map<string, string>;
	private nextContainerId: number;
	private config: CoordinatorConfig;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.state = state;
		this.env = env;
		this.containers = new Map();
		this.sessionToContainer = new Map();
		this.nextContainerId = 0;

		// Load configuration from env with defaults
		this.config = {
			maxConnectionsPerContainer: parseInt(env.MAX_CONNECTIONS_PER_CONTAINER || '10', 10),
			minContainers: parseInt(env.MIN_CONTAINERS || '2', 10),
			scaleDownIdleTime: parseInt(env.SCALE_DOWN_IDLE_TIME || '600000', 10), // 10 minutes
		};

		// Initialize from durable storage
		this.state.blockConcurrencyWhile(async () => {
			const stored = await this.state.storage.get<{
				containers: Array<[string, ContainerInfo]>;
				sessionToContainer: Array<[string, string]>;
				nextContainerId: number;
			}>('state');

			if (stored) {
				this.containers = new Map(stored.containers);
				this.sessionToContainer = new Map(stored.sessionToContainer);
				this.nextContainerId = stored.nextContainerId;
			} else {
				// Initialize minimum containers
				this.initializeMinimumContainers();
			}
		});
	}

	/**
	 * Create the minimum number of containers on first run
	 */
	private initializeMinimumContainers() {
		for (let i = 0; i < this.config.minContainers; i++) {
			const containerId = `container-${this.nextContainerId++}`;
			this.containers.set(containerId, {
				id: containerId,
				activeConnections: 0,
				lastActivity: Date.now(),
				createdAt: Date.now(),
			});
		}
		this.persistState();
	}

	/**
	 * Persist state to durable storage
	 */
	private async persistState() {
		await this.state.storage.put('state', {
			containers: Array.from(this.containers.entries()),
			sessionToContainer: Array.from(this.sessionToContainer.entries()),
			nextContainerId: this.nextContainerId,
		});
	}

	/**
	 * Assign a container to a session
	 * Returns the container ID to use
	 */
	async assignContainer(sessionId: string): Promise<string> {
		// Check if session already assigned
		const existing = this.sessionToContainer.get(sessionId);
		if (existing && this.containers.has(existing)) {
			return existing;
		}

		// Find least-loaded container
		let targetContainer = this.findLeastLoadedContainer();

		// If no container available or all at capacity, create new one
		if (!targetContainer || targetContainer.activeConnections >= this.config.maxConnectionsPerContainer) {
			targetContainer = this.createNewContainer();
			console.log(`Created new container: ${targetContainer.id} (total: ${this.containers.size})`);
		}

		// Assign session to container
		this.sessionToContainer.set(sessionId, targetContainer.id);
		await this.persistState();

		console.log(
			`Assigned session ${sessionId} to ${targetContainer.id} (load: ${targetContainer.activeConnections}/${this.config.maxConnectionsPerContainer})`,
		);

		return targetContainer.id;
	}

	/**
	 * Find the container with the least load
	 */
	private findLeastLoadedContainer(): ContainerInfo | null {
		let leastLoaded: ContainerInfo | null = null;
		let minLoad = Infinity;

		for (const container of this.containers.values()) {
			if (container.activeConnections < minLoad) {
				minLoad = container.activeConnections;
				leastLoaded = container;
			}
		}

		return leastLoaded;
	}

	/**
	 * Create a new container
	 */
	private createNewContainer(): ContainerInfo {
		const containerId = `container-${this.nextContainerId++}`;
		const container: ContainerInfo = {
			id: containerId,
			activeConnections: 0,
			lastActivity: Date.now(),
			createdAt: Date.now(),
		};

		this.containers.set(containerId, container);
		return container;
	}

	/**
	 * Report that a connection has opened
	 */
	async connectionOpened(sessionId: string, containerId: string): Promise<void> {
		const container = this.containers.get(containerId);
		if (!container) {
			console.error(`Container ${containerId} not found for session ${sessionId}`);
			return;
		}

		container.activeConnections++;
		container.lastActivity = Date.now();

		// Update session mapping
		this.sessionToContainer.set(sessionId, containerId);

		await this.persistState();

		console.log(`Connection opened: ${sessionId} on ${containerId} (load: ${container.activeConnections})`);
	}

	/**
	 * Report that a connection has closed
	 */
	async connectionClosed(sessionId: string, containerId: string): Promise<void> {
		const container = this.containers.get(containerId);
		if (!container) {
			console.warn(`Container ${containerId} not found for session ${sessionId}`);
			return;
		}

		container.activeConnections = Math.max(0, container.activeConnections - 1);
		container.lastActivity = Date.now();

		// Remove session mapping
		this.sessionToContainer.delete(sessionId);

		await this.persistState();

		console.log(`Connection closed: ${sessionId} on ${containerId} (load: ${container.activeConnections})`);

		// Check if we should scale down
		await this.considerScaleDown();
	}

	/**
	 * Consider scaling down idle containers
	 */
	private async considerScaleDown() {
		const now = Date.now();
		const idleContainers: string[] = [];

		// Find idle containers
		for (const [id, container] of this.containers.entries()) {
			if (
				container.activeConnections === 0 &&
				now - container.lastActivity > this.config.scaleDownIdleTime &&
				this.containers.size > this.config.minContainers
			) {
				idleContainers.push(id);
			}
		}

		// Remove idle containers (but keep minimum)
		for (const id of idleContainers) {
			if (this.containers.size > this.config.minContainers) {
				this.containers.delete(id);
				console.log(`Scaled down container: ${id} (remaining: ${this.containers.size})`);
			}
		}

		if (idleContainers.length > 0) {
			await this.persistState();
		}
	}

	/**
	 * Get current container statistics
	 */
	getStats(): {
		totalContainers: number;
		totalConnections: number;
		containers: Array<{ id: string; connections: number; utilization: number }>;
		config: CoordinatorConfig;
	} {
		const containers = Array.from(this.containers.values()).map((c) => ({
			id: c.id,
			connections: c.activeConnections,
			utilization: (c.activeConnections / this.config.maxConnectionsPerContainer) * 100,
		}));

		const totalConnections = containers.reduce((sum, c) => sum + c.connections, 0);

		return {
			totalContainers: this.containers.size,
			totalConnections,
			containers,
			config: this.config,
		};
	}

	/**
	 * HTTP fetch handler for the Durable Object
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			if (path === '/assign' && request.method === 'POST') {
				const { sessionId } = await request.json<{ sessionId: string }>();
				const containerId = await this.assignContainer(sessionId);
				return Response.json({ containerId });
			} else if (path === '/connection-opened' && request.method === 'POST') {
				const { sessionId, containerId } = await request.json<{ sessionId: string; containerId: string }>();
				await this.connectionOpened(sessionId, containerId);
				return Response.json({ success: true });
			} else if (path === '/connection-closed' && request.method === 'POST') {
				const { sessionId, containerId } = await request.json<{ sessionId: string; containerId: string }>();
				await this.connectionClosed(sessionId, containerId);
				return Response.json({ success: true });
			} else if (path === '/stats' && request.method === 'GET') {
				const stats = this.getStats();
				return Response.json(stats);
			} else {
				return new Response('Not Found', { status: 404 });
			}
		} catch (error) {
			console.error('Coordinator error:', error);
			return Response.json(
				{
					error: error instanceof Error ? error.message : String(error),
				},
				{ status: 500 },
			);
		}
	}
}
