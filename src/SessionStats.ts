import logger from './logger';

// Session stats tracker - keeps track of audio/transcription metrics for monitoring
export class SessionStats {
	private sessionId: string;
	private provider: string;
	private startTime: number;

	// audio stuff
	private packetsReceived = 0;
	private packetsDecoded = 0;
	private packetsQueued = 0;
	private packetsLost = 0;
	private decodeErrors = 0;

	// transcription counters
	private interimTranscriptions = 0;
	private finalTranscriptions = 0;
	private lastTranscriptionTime = 0;
	private totalTranscriptionLatency = 0;

	// connection tracking
	private activeConnections = 0;
	private connectionErrors = 0;

	constructor(sessionId: string, provider: string) {
		this.sessionId = sessionId;
		this.provider = provider;
		this.startTime = Date.now();
	}

	incrementPacketsReceived() {
		this.packetsReceived++;
	}

	incrementPacketsDecoded() {
		this.packetsDecoded++;
	}

	incrementPacketsQueued() {
		this.packetsQueued++;
	}

	incrementPacketsLost(count = 1) {
		this.packetsLost += count;
	}

	incrementDecodeErrors() {
		this.decodeErrors++;
	}

	incrementInterimTranscriptions() {
		this.interimTranscriptions++;
	}

	incrementFinalTranscriptions(latencyMs?: number) {
		this.finalTranscriptions++;
		this.lastTranscriptionTime = Date.now();
		if (latencyMs && latencyMs > 0) {
			this.totalTranscriptionLatency += latencyMs;
		}
	}

	setActiveConnections(count: number) {
		this.activeConnections = count;
	}

	incrementConnectionErrors() {
		this.connectionErrors++;
	}

	// Figure out if the session is healthy based on error rates

	getHealthStatus(): 'healthy' | 'degraded' | 'unhealthy' {
		// need at least some packets to determine health
		if (this.packetsReceived < 10) {
			return 'healthy';
		}

		const decodeErrorRate = this.packetsReceived > 0 ? this.decodeErrors / this.packetsReceived : 0;
		const packetLossRate = this.packetsReceived > 0 ? this.packetsLost / this.packetsReceived : 0;

		// too many errors = unhealthy
		// TODO: maybe make these thresholds configurable?
		if (decodeErrorRate > 0.1 || packetLossRate > 0.2 || this.connectionErrors > 3) {
			return 'unhealthy';
		}

		// some errors = degraded
		if (decodeErrorRate > 0.05 || packetLossRate > 0.1 || this.connectionErrors > 0) {
			return 'degraded';
		}

		return 'healthy';
	}

	getAverageLatency() {
		if (this.finalTranscriptions === 0) return 0;
		return Math.round(this.totalTranscriptionLatency / this.finalTranscriptions);
	}

	getUptimeSeconds() {
		return Math.floor((Date.now() - this.startTime) / 1000);
	}

	// Export stats as JSON for the HTTP endpoint
	toJSON() {
		const lossRate = this.packetsReceived > 0
			? (this.packetsLost / this.packetsReceived).toFixed(3)
			: '0.000';

		const lastTranscriptionAgo = this.lastTranscriptionTime > 0
			? Math.floor((Date.now() - this.lastTranscriptionTime) / 1000)
			: null;

		return {
			sessionId: this.sessionId,
			provider: this.provider,
			health: this.getHealthStatus(),
			uptime: this.getUptimeSeconds(),
			audio: {
				packetsReceived: this.packetsReceived,
				packetsDecoded: this.packetsDecoded,
				packetsQueued: this.packetsQueued,
				packetsLost: this.packetsLost,
				decodeErrors: this.decodeErrors,
				lossRate: lossRate,
			},
			transcription: {
				interim: this.interimTranscriptions,
				final: this.finalTranscriptions,
				averageLatencyMs: this.getAverageLatency(),
				lastTranscriptionAgo: lastTranscriptionAgo,
			},
			connections: {
				active: this.activeConnections,
				errors: this.connectionErrors,
			},
		};
	}
}
