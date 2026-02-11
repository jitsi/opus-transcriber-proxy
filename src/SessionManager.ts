import { WebSocket } from 'ws';
import { config } from './config';
import logger from './logger';
import type { TranscriberProxy } from './transcriberproxy';
import { getInstruments } from './telemetry/instruments';

interface DetachedSession {
	transcriberProxy: TranscriberProxy;
	detachedAt: number;
	gracePeriodTimer: NodeJS.Timeout;
	originalConnectionId: number;
}

/**
 * SessionManager manages the lifecycle of transcription sessions,
 * allowing sessions to be detached from WebSocket connections and
 * resumed within a grace period.
 */
class SessionManager {
	private static instance: SessionManager;
	private detachedSessions: Map<string, DetachedSession>;
	private activeSessions: Map<string, TranscriberProxy>;

	private constructor() {
		this.detachedSessions = new Map();
		this.activeSessions = new Map();
	}

	static getInstance(): SessionManager {
		if (!SessionManager.instance) {
			SessionManager.instance = new SessionManager();
		}
		return SessionManager.instance;
	}

	/**
	 * Register a newly created active session
	 */
	registerSession(sessionId: string | undefined, proxy: TranscriberProxy): void {
		if (!sessionId) return;
		this.activeSessions.set(sessionId, proxy);

		// Metrics
		const instruments = getInstruments();
		instruments.sessionsActive.add(1);
		instruments.sessionStartsTotal.add(1, { provider: proxy.getOptions().provider || 'unknown' });

		logger.debug(`Session ${sessionId} registered in active sessions (total: ${this.activeSessions.size})`);
	}

	/**
	 * Check if an active (non-detached) session exists
	 */
	hasActiveSession(sessionId: string | undefined): boolean {
		if (!sessionId) return false;
		return this.activeSessions.has(sessionId);
	}

	/**
	 * Get an active session by ID
	 */
	getActiveSession(sessionId: string): TranscriberProxy | undefined {
		return this.activeSessions.get(sessionId);
	}

	/**
	 * Unregister a session from tracking (called on final cleanup)
	 */
	unregisterSession(sessionId: string | undefined): void {
		if (!sessionId) return;
		const wasActive = this.activeSessions.has(sessionId);
		this.activeSessions.delete(sessionId);

		// Metrics: decrement active if it was tracked
		if (wasActive) {
			const instruments = getInstruments();
			instruments.sessionsActive.add(-1);
		}

		logger.debug(`Session ${sessionId} unregistered from active sessions (total: ${this.activeSessions.size})`);
	}

	/**
	 * Detach a session from its WebSocket connection and start grace period timer
	 */
	detachSession(sessionId: string | undefined, proxy: TranscriberProxy, connectionId: number): void {
		if (!sessionId) {
			// No sessionId - cannot resume, close immediately
			logger.debug('No sessionId provided, closing session immediately');
			proxy.close();
			return;
		}

		if (!config.sessionResumeEnabled) {
			// Resume disabled - close immediately
			logger.debug(`Session resumption disabled, closing session ${sessionId} immediately`);
			this.unregisterSession(sessionId);
			proxy.close();
			return;
		}

		// Remove from active sessions (it's now detached)
		this.activeSessions.delete(sessionId);

		// Metrics: decrement active, increment detached
		const instruments = getInstruments();
		instruments.sessionsActive.add(-1);
		instruments.sessionsDetached.add(1);

		// Create grace period timer
		const timer = setTimeout(() => {
			this.cleanupSession(sessionId);
		}, config.sessionResumeGracePeriod * 1000);

		// Store detached session
		this.detachedSessions.set(sessionId, {
			transcriberProxy: proxy,
			detachedAt: Date.now(),
			gracePeriodTimer: timer,
			originalConnectionId: connectionId,
		});

		logger.info(
			`[WS-${connectionId}] Session ${sessionId} detached, grace period: ${config.sessionResumeGracePeriod}s (detached: ${this.detachedSessions.size}, active: ${this.activeSessions.size})`,
		);
	}

	/**
	 * Check if a detached/resumable session exists
	 */
	hasSession(sessionId: string | undefined): boolean {
		if (!sessionId) return false;
		return this.detachedSessions.has(sessionId);
	}

	/**
	 * Reattach a detached session to a new WebSocket connection
	 */
	reattachSession(sessionId: string, newWs: WebSocket): TranscriberProxy {
		const session = this.detachedSessions.get(sessionId);
		if (!session) {
			throw new Error(`No detached session found for ${sessionId}`);
		}

		// Cancel the grace period timer
		clearTimeout(session.gracePeriodTimer);

		// Remove from detached sessions
		this.detachedSessions.delete(sessionId);

		// Add back to active sessions
		this.activeSessions.set(sessionId, session.transcriberProxy);

		// Metrics: decrement detached, increment active, count reattachment
		const instruments = getInstruments();
		instruments.sessionsDetached.add(-1);
		instruments.sessionsActive.add(1);
		instruments.sessionReattachmentsTotal.add(1);

		const elapsedMs = Date.now() - session.detachedAt;
		logger.info(
			`Session ${sessionId} resumed after ${elapsedMs}ms (detached: ${this.detachedSessions.size}, active: ${this.activeSessions.size})`,
		);

		// Rebind the WebSocket
		session.transcriberProxy.reattachWebSocket(newWs);

		return session.transcriberProxy;
	}

	/**
	 * Clean up a session after grace period expires
	 */
	private cleanupSession(sessionId: string): void {
		const session = this.detachedSessions.get(sessionId);
		if (!session) {
			logger.warn(`Attempted to cleanup session ${sessionId} but it was not found`);
			return;
		}

		const elapsedMs = Date.now() - session.detachedAt;
		logger.info(
			`[WS-${session.originalConnectionId}] Session ${sessionId} grace period expired after ${elapsedMs}ms, cleaning up`,
		);

		// Remove from detached sessions
		this.detachedSessions.delete(sessionId);

		// Metrics: decrement detached, record session duration
		const instruments = getInstruments();
		instruments.sessionsDetached.add(-1);
		const sessionDurationSec = session.transcriberProxy.getSessionDurationSec();
		if (sessionDurationSec > 0) {
			instruments.sessionDurationSeconds.record(sessionDurationSec);
		}

		// Close the session (closes all backend connections, etc.)
		session.transcriberProxy.close();
	}

	/**
	 * Shutdown all detached sessions (called on SIGTERM)
	 */
	shutdown(): void {
		const detachedCount = this.detachedSessions.size;
		const activeCount = this.activeSessions.size;

		logger.info(`Shutting down SessionManager (detached: ${detachedCount}, active: ${activeCount})`);

		// Clean up all detached sessions
		for (const [sessionId, session] of this.detachedSessions) {
			logger.info(`Cleaning up detached session ${sessionId} during shutdown`);
			clearTimeout(session.gracePeriodTimer);
			session.transcriberProxy.close();
		}
		this.detachedSessions.clear();

		// Note: Active sessions will be cleaned up by server.ts through normal close handlers
		// Just clear our tracking
		this.activeSessions.clear();

		logger.info('SessionManager shutdown complete');
	}

	/**
	 * Get statistics about sessions (for debugging/monitoring)
	 */
	getStats(): { detached: number; active: number } {
		return {
			detached: this.detachedSessions.size,
			active: this.activeSessions.size,
		};
	}
}

// Export singleton instance
export const sessionManager = SessionManager.getInstance();
