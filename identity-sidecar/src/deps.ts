import { loadConfig } from './config.js';
import { createEmbedder } from './embedder.js';
import { createDiarizer } from './diarizer.js';
import { MemoryStore } from './store/MemoryStore.js';
import { VectorizeStore } from './store/VectorizeStore.js';
import type { Deps } from './app.js';
import type { FingerprintStore } from './store/FingerprintStore.js';

export function buildDeps(): Deps {
  const config = loadConfig();
  const embedder = createEmbedder(config.embeddingModel);
  const diarizer = createDiarizer({
    segModel: config.segModel,
    embeddingModel: config.embeddingModel,
    clusterThreshold: config.segClusterThreshold,
  });
  let store: FingerprintStore;
  if (config.store === 'vectorize') {
    store = new VectorizeStore({
      accountId: process.env.VECTORIZE_ACCOUNT_ID!,
      indexName: process.env.VECTORIZE_INDEX!,
      apiToken: process.env.VECTORIZE_API_TOKEN!,
    });
  } else {
    store = new MemoryStore();
  }
  return {
    embedder,
    diarizer,
    store,
    threshold: config.matchThreshold,
    guard: { minDurationSec: config.minSpeakerDurationSec, minShare: config.minSpeakerShare },
    bearerToken: config.bearerToken,
  };
}
