import { describe, it, expect } from 'vitest';
import { LocalIdentityClient } from '../../../src/identity/LocalIdentityClient';
import type { Embedder } from '../../../src/identity/embedder';

// Records the sample count handed to the embedder so we can assert the PCM cap. Never touches
// the native CAM++ addon (injected via embedderFactory).
function spyClient(maxEmbedSec: number, seen: { samples: number[] }) {
  const embedder: Embedder = {
    dim: 192,
    async embed(audio: Float32Array) {
      seen.samples.push(audio.length);
      return Float32Array.from([1, 0, 0]);
    },
  };
  return new LocalIdentityClient({
    embeddingModel: 'm',
    vectorize: { accountId: 'a', indexName: 'i', apiToken: 't' },
    matchThreshold: 0.5,
    maxEmbedSec,
    embedderFactory: async () => embedder,
  });
}

const pcmSeconds = (sec: number) => Buffer.alloc(sec * 16000 * 2); // s16le mono @16k

describe('LocalIdentityClient embed cap', () => {
  it('truncates a long slice to maxEmbedSec before the (synchronous native) embed', async () => {
    const seen = { samples: [] as number[] };
    await spyClient(4, seen).embed(pcmSeconds(30)); // 30s in → capped to 4s
    expect(seen.samples[0]).toBe(4 * 16000); // 64000 samples, not 480000
  });

  it('leaves a short slice untouched (no padding, no cap)', async () => {
    const seen = { samples: [] as number[] };
    await spyClient(4, seen).embed(pcmSeconds(2)); // 2s < 4s cap
    expect(seen.samples[0]).toBe(2 * 16000);
  });

  it('maxEmbedSec <= 0 disables the cap', async () => {
    const seen = { samples: [] as number[] };
    await spyClient(0, seen).embed(pcmSeconds(30));
    expect(seen.samples[0]).toBe(30 * 16000);
  });
});
