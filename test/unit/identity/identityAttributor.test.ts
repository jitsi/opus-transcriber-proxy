import { describe, it, expect } from 'vitest';
import { IdentityAttributor } from '../../../src/identity/IdentityAttributor';
import type { SidecarClient, AnalyzeResult } from '../../../src/identity/SidecarClient';
import type { Word } from '../../../src/identity/RoomAttributor';

function fakeSidecar(turns: AnalyzeResult['turns'], seen: { bytes?: number }): SidecarClient {
  return {
    async analyze(_s: string, _st: string, _t: string, pcm: Buffer) {
      seen.bytes = pcm.length;
      return { speakerCount: turns.length, multiple: turns.length > 1, turns };
    },
  } as unknown as SidecarClient;
}

const pcmSeconds = (sec: number): Uint8Array => new Uint8Array(sec * 16000 * 2);

describe('IdentityAttributor', () => {
  it('slices the window, reports speakerCount, and attributes words (absolute time)', async () => {
    const seen: { bytes?: number } = {};
    const turns = [
      { sessionSpeakerId: 0, handle: 'Purple Otter', identity: 'alice', score: 0.9, start: 0, end: 2 },
      { sessionSpeakerId: 1, handle: 'Amber Falcon', identity: null, score: 0, start: 2, end: 4 },
    ];
    const att = new IdentityAttributor(fakeSidecar(turns, seen), { sessionId: 's', streamId: 'st' });
    att.appendPcm(pcmSeconds(5));

    const words: Word[] = [
      { text: 'hello', start: 0.1, end: 0.5 },
      { text: 'there', start: 0.5, end: 1.0 },
      { text: 'hi', start: 2.5, end: 3.0 },
    ];
    const a = await att.analyze(words, 't1');
    expect(a).not.toBeNull();
    expect(a!.speakerCount).toBe(2);
    expect(a!.segments.map((s) => s.identity)).toEqual(['alice', null]);
    expect(a!.segments[0].text).toBe('hello there');
    expect(seen.bytes! % 2).toBe(0);
    expect(a!.windowSec).toBeGreaterThan(0);
  });

  it('returns null when the sidecar yields no turns', async () => {
    const att = new IdentityAttributor(fakeSidecar([], {}), { sessionId: 's', streamId: 'st' });
    att.appendPcm(pcmSeconds(3));
    expect(await att.analyze([{ text: 'x', start: 0, end: 1 }], 't1')).toBeNull();
  });

  it('returns null for an empty utterance', async () => {
    const att = new IdentityAttributor(fakeSidecar([], {}), { sessionId: 's', streamId: 'st' });
    expect(await att.analyze([], 't1')).toBeNull();
  });

  it('slices from the retained tail after the ring drops old audio', async () => {
    const seen: { bytes?: number } = {};
    const turns = [{ sessionSpeakerId: 0, handle: 'Purple Otter', identity: 'alice', score: 0.9, start: 0, end: 1 }];
    const att = new IdentityAttributor(fakeSidecar(turns, seen), { sessionId: 's', streamId: 'st', maxBufferSec: 2 });
    att.appendPcm(pcmSeconds(2));
    att.appendPcm(pcmSeconds(2)); // drops first → buffer covers 2..4
    const a = await att.analyze([{ text: 'y', start: 3.0, end: 3.5 }], 't1');
    expect(a).not.toBeNull();
    expect(a!.segments[0].identity).toBe('alice');
  });
});
