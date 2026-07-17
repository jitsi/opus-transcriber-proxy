export interface Config {
  port: number;
  bearerToken: string;
  matchThreshold: number;
  segClusterThreshold: number;
  minSpeakerDurationSec: number;
  minSpeakerShare: number;
  store: 'memory' | 'vectorize';
  embeddingModel: string;
  segModel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parseInt(env.PORT ?? '8090', 10),
    bearerToken: env.SIDECAR_BEARER_TOKEN ?? 'dev-token',
    matchThreshold: parseFloat(env.MATCH_THRESHOLD ?? '0.5'),
    segClusterThreshold: parseFloat(env.SEG_CLUSTER_THRESHOLD ?? '0.8'),
    minSpeakerDurationSec: parseFloat(env.MIN_SPEAKER_DURATION_SEC ?? '2.0'),
    minSpeakerShare: parseFloat(env.MIN_SPEAKER_SHARE ?? '0.1'),
    store: env.STORE === 'vectorize' ? 'vectorize' : 'memory',
    embeddingModel: env.EMBEDDING_MODEL ?? 'models/campplus.onnx',
    segModel: env.SEG_MODEL ?? 'models/segmentation-3.0.onnx',
  };
}
