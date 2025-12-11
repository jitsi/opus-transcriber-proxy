import { DurableObject, RpcTarget } from 'cloudflare:workers';

export class Transcriptionator extends DurableObject<Env> {
	private observers: Set<WebSocket>;

	// Debug audio buffers (per participant tag)
	private sessionId: string = '';
	private debugPcmChunks: Map<string, Int16Array[]> = new Map();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		this.observers = new Set();
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		// Only handle observer connections now
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		server.accept();

		console.log('New observer WebSocket connection');

		this.observers.add(server);
		server.addEventListener('close', () => {
			this.observers.delete(server);
			server.close();
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	// RPC method to broadcast messages to all observers
	broadcastMessage(data: string): void {
		this.observers.forEach((observer) => {
			try {
				observer.send(data);
			} catch (error) {
				console.error('Failed to send to observer:', error);
				// Remove failed observers
				this.observers.delete(observer);
			}
		});
	}

	// RPC method to handle session closure
	async notifySessionClosed(): Promise<void> {
		console.log('Transcription session closed');
		// Write debug audio to R2 before closing
		await this.writeDebugAudioToR2();
	}

	// RPC method to set session ID for debug files
	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
		console.log(`Debug audio session ID set: ${sessionId}`);
	}

	// RPC method to receive decoded PCM samples
	appendPcmSamples(tag: string, samples: Int16Array): void {
		if (!this.debugPcmChunks.has(tag)) {
			this.debugPcmChunks.set(tag, []);
		}
		this.debugPcmChunks.get(tag)!.push(samples);
	}

	// Write all accumulated debug audio to R2
	private async writeDebugAudioToR2(): Promise<void> {
		console.log(`writeDebugAudioToR2 called, sessionId=${this.sessionId}, chunks=${this.debugPcmChunks.size}`);

		const bucket = (this.env as any).DEBUG_AUDIO_BUCKET as R2Bucket | undefined;
		if (!bucket) {
			console.warn('DEBUG_AUDIO_BUCKET not configured, skipping debug audio write');
			return;
		}

		if (this.debugPcmChunks.size === 0) {
			console.warn('No PCM chunks to write');
			return;
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const sessionPrefix = this.sessionId || 'unknown-session';

		// Write PCM samples for each participant as raw 16-bit PCM @ 24kHz mono
		for (const [tag, chunks] of this.debugPcmChunks) {
			if (chunks.length === 0) continue;

			const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0);
			const combined = new Int16Array(totalSamples);
			let offset = 0;
			for (const chunk of chunks) {
				combined.set(chunk, offset);
				offset += chunk.length;
			}

			// Naming: {session}_{timestamp}_{tag}.pcm
			const safeTag = tag.replace(/[^a-zA-Z0-9-_]/g, '_');
			const key = `${sessionPrefix}_${timestamp}_${safeTag}.pcm`;
			await bucket.put(key, combined.buffer);
			console.log(`Wrote ${totalSamples} PCM samples (${combined.byteLength} bytes) to ${key}`);
		}

		// Clear buffers after writing
		this.debugPcmChunks.clear();
	}
}
