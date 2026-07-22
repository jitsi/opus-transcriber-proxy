import type { ISidecarClient, IdentifyResult } from './SidecarClient';
import { VectorizeStore } from './vectorize';
import { decideMatch } from './matcher';
import { pcm16ToFloat32 } from './vecmath';
import type { Embedder } from './embedder';
import logger from '../logger';

/**
 * In-process identity client: runs the CAM++ embedding + Vectorize match/enroll directly in the
 * transcriber container — no identity-sidecar hop. Only the CAM++ embedder is needed (diarization
 * comes from the transcription backend), so no pyannote. The embedder (sherpa-onnx-node, native) is
 * loaded lazily on first use, so nothing native loads when identity is off, and it never enters the
 * Worker bundle (container-only path). Never throws to the caller — degrades to null/false.
 */
export interface LocalIdentityOptions {
	embeddingModel: string;
	vectorize: { accountId: string; indexName: string; apiToken: string };
	matchThreshold: number;
	/** Max seconds of audio fed to a single embed; longer slices are truncated. Bounds the
	 *  synchronous native compute() so it can't stall the event loop. <= 0 disables. Default 4. */
	maxEmbedSec?: number;
	/** Embed input sample rate (s16le mono). CAM++ path is 16 kHz. Default 16000. */
	sampleRate?: number;
	/** Test seam: override how the embedder is created (default = lazy dynamic import of ./embedder). */
	embedderFactory?: (modelPath: string) => Promise<Embedder>;
}

export class LocalIdentityClient implements ISidecarClient {
	private store: VectorizeStore;
	private embedderP?: Promise<Embedder | null>;

	constructor(private o: LocalIdentityOptions) {
		this.store = new VectorizeStore({
			accountId: o.vectorize.accountId,
			indexName: o.vectorize.indexName,
			apiToken: o.vectorize.apiToken,
		});
	}

	private getEmbedder(): Promise<Embedder | null> {
		if (!this.embedderP) {
			// Dynamic import so sherpa-onnx-node (native) loads only when identity actually runs.
			const create = this.o.embedderFactory ?? ((mp: string) => import('./embedder').then((m) => m.createEmbedder(mp)));
			this.embedderP = create(this.o.embeddingModel).catch((err) => {
				logger.error(`[identity] embedder init failed: ${(err as Error).message}`);
				return null;
			});
		}
		return this.embedderP;
	}

	async embed(pcm: Buffer): Promise<Float32Array | null> {
		const emb = await this.getEmbedder();
		if (!emb) return null;
		try {
			return await emb.embed(pcm16ToFloat32(this.capPcm(pcm)));
		} catch (err) {
			logger.debug(`[identity] embed failed: ${(err as Error).message}`);
			return null;
		}
	}

	/** Truncate to the first maxEmbedSec of audio so the synchronous native compute() stays bounded
	 *  (a long turn or the full enroll window would otherwise block the event loop for seconds). */
	private capPcm(pcm: Buffer): Buffer {
		const maxSec = this.o.maxEmbedSec ?? 4;
		if (!(maxSec > 0)) return pcm;
		const maxBytes = (Math.floor(maxSec * (this.o.sampleRate ?? 16000)) * 2) & ~1; // even (s16le)
		return pcm.length > maxBytes ? pcm.subarray(0, maxBytes) : pcm;
	}

	async identify(tenant: string, pcm: Buffer): Promise<IdentifyResult | null> {
		const vec = await this.embed(pcm);
		if (!vec) return null;
		try {
			const candidates = await this.store.query(tenant, vec);
			const m = decideMatch(vec, candidates, this.o.matchThreshold);
			return { identity: m.identity, score: m.score, name: m.name };
		} catch (err) {
			logger.debug(`[identity] identify failed: ${(err as Error).message}`);
			return null;
		}
	}

	async enroll(identity: string, tenant: string, pcm: Buffer, name?: string): Promise<boolean> {
		const vec = await this.embed(pcm);
		if (!vec) return false;
		try {
			await this.store.upsert(tenant, identity, vec, name);
			return true;
		} catch (err) {
			logger.debug(`[identity] enroll failed: ${(err as Error).message}`);
			return false;
		}
	}

	async sessionEnd(): Promise<void> {
		/* stateless — nothing to clean up */
	}
}
