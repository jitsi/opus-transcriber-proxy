import { describe, it, expect } from 'vitest';
import { IdentityAttributor } from '../../../src/identity/IdentityAttributor';
import type { SidecarClient, AnalyzeResult } from '../../../src/identity/SidecarClient';
import type { Word } from '../../../src/identity/RoomAttributor';

// Fake sidecar: returns two turns (relative to the sliced buffer) and records the pcm length it got.
function fakeSidecar(turns: AnalyzeResult['turns'], seen: { bytes?: number }): SidecarClient {
  return {
    async analyze(_s: string, _st: string, _t: string, pcm: Buffer) {
      seen.bytes = pcm.length;
      return { speakerCount: turns.length, multiple: turns.length > 1, turns };
    },
  } as unknown as SidecarClient;
}

const pcmSeconds = (sec: number): Uint8Array => new Uint8Array(sec * 16000 * 2); // silence, right length

describe('IdentityAttributor', () => {
  it('slices the utterance PCM and attributes words to sidecar turns (absolute time)', async () => {
    const seen: { bytes?: number } = {};
    const turns = [
      { sessionSpeakerId: 0, handle: 'Purple Otter', identity: 'alice', score: 0.9, start: 0, end: 2 },
      { sessionSpeakerId: 1, handle: 'Amber Falcon', identity: null, score: 0, start: 2, end: 4 },
    ];
    const att = new IdentityAttributor(fakeSidecar(turns, seen), { sessionId: 's', streamId: 'st', tenant: 't1' });
    att.appendPcm(pcmSeconds(5)); // 0..5s buffered

    const words: Word[] = [
      { text: 'hello', start: 0.1, end: 0.5 },
      { text: 'there', start: 0.5, end: 1.0 },
      { text: 'hi', start: 2.5, end: 3.0 },
    ];
    const segs = await att.attributeFinal(words);
    expect(segs).not.toBeNull();
    // turns shifted by uStart=0.1 -> turn0 [0.1,2.1], turn1 [2.1,4.1]
    expect(segs!.map((s) => s.identity)).toEqual(['alice', null]);
    expect(segs![0].text).toBe('hello there');
    expect(segs![1].text).toBe('hi');
    // sliced [0.1,3.0] ~= 2.9s -> ~92800 bytes (even)
    expect(seen.bytes).toBeGreaterThan(90000);
    expect(seen.bytes! % 2).toBe(0);
  });

  it('returns null when the sidecar yields no turns', async () => {
    const att = new IdentityAttributor(fakeSidecar([], {}), { sessionId: 's', streamId: 'st', tenant: 't1' });
    att.appendPcm(pcmSeconds(3));
    expect(await att.attributeFinal([{ text: 'x', start: 0, end: 1 }])).toBeNull();
  });

  it('returns null for an empty utterance', async () => {
    const att = new IdentityAttributor(fakeSidecar([], {}), { sessionId: 's', streamId: 'st', tenant: 't1' });
    expect(await att.attributeFinal([])).toBeNull();
  });

  it('drops old audio past the ring cap but keeps the media clock consistent', async () => {
    const seen: { bytes?: number } = {};
    const turns = [{ sessionSpeakerId: 0, handle: 'Purple Otter', identity: 'alice', score: 0.9, start: 0, end: 1 }];
    const att = new IdentityAttributor(fakeSidecar(turns, seen), { sessionId: 's', streamId: 'st', tenant: 't1', maxBufferSec: 2 });
    att.appendPcm(pcmSeconds(2)); // 0..2
    att.appendPcm(pcmSeconds(2)); // drops first -> buffer now covers 2..4, bufStartSec=2
    // utterance at 3.0-3.5 must still slice correctly from the retained tail
    const segs = await att.attributeFinal([{ text: 'y', start: 3.0, end: 3.5 }]);
    expect(segs).not.toBeNull();
    expect(segs![0].identity).toBe('alice');
  });
});
