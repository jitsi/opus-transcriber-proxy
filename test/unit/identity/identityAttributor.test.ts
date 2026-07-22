import { describe, it, expect } from 'vitest';
import { IdentityAttributor } from '../../../src/identity/IdentityAttributor';
import type { ISidecarClient, IdentifyResult } from '../../../src/identity/SidecarClient';
import type { Word } from '../../../src/identity/RoomAttributor';

// Sidecar mock exposing only identify (embed+match) — the new attributor uses backend diarization
// (word.speaker) and calls identify once per distinct speaker.
function fakeSidecar(identify: (pcm: Buffer) => IdentifyResult | null, seen: { calls: number[] }): ISidecarClient {
  return {
    async identify(_tenant: string, pcm: Buffer) {
      seen.calls.push(pcm.length);
      return identify(pcm);
    },
  } as unknown as ISidecarClient;
}

const pcmSeconds = (sec: number): Uint8Array => new Uint8Array(sec * 16000 * 2);
const alice: IdentifyResult = { identity: 'alice', name: 'Alice', score: 0.9 };

describe('IdentityAttributor', () => {
  it('groups consecutive words by backend speaker, identifies each distinct speaker, and orders runs', async () => {
    const seen = { calls: [] as number[] };
    const att = new IdentityAttributor(fakeSidecar(() => alice, seen), { sessionId: 's', streamId: 'st' });
    att.appendPcm(pcmSeconds(6));

    const words: Word[] = [
      { text: 'hello', start: 0.1, end: 0.6, speaker: 0 },
      { text: 'there', start: 0.6, end: 1.2, speaker: 0 },
      { text: 'hi', start: 2.5, end: 3.3, speaker: 1 },
      { text: 'bye', start: 3.5, end: 4.2, speaker: 0 },
    ];
    const a = await att.analyze(words, 't1');
    expect(a).not.toBeNull();
    expect(a!.speakerCount).toBe(2); // two distinct backend speakers
    expect(a!.segments.map((s) => s.text)).toEqual(['hello there', 'hi', 'bye']); // consecutive runs, in order
    expect(a!.segments.map((s) => s.sessionSpeakerId)).toEqual([0, 1, 0]);
    expect(a!.segments.every((s) => s.identity === 'alice')).toBe(true);
    expect(seen.calls.length).toBe(2); // identify called once per distinct speaker, not per run
    expect(seen.calls.every((n) => n % 2 === 0)).toBe(true); // even byte (s16le) slices
  });

  it('collapses to a single speaker when words carry no backend speaker label', async () => {
    const seen = { calls: [] as number[] };
    const att = new IdentityAttributor(fakeSidecar(() => alice, seen), { sessionId: 's', streamId: 'st' });
    att.appendPcm(pcmSeconds(3));
    const a = await att.analyze(
      [
        { text: 'one', start: 0.1, end: 0.9 },
        { text: 'two', start: 0.9, end: 1.6 },
      ],
      't1',
    );
    expect(a!.speakerCount).toBe(1);
    expect(a!.segments).toHaveLength(1);
    expect(a!.segments[0].text).toBe('one two');
    expect(a!.segments[0].identity).toBe('alice');
    expect(seen.calls.length).toBe(1);
  });

  it('leaves identity null when the sidecar does not match', async () => {
    const att = new IdentityAttributor(fakeSidecar(() => null, { calls: [] }), { sessionId: 's', streamId: 'st' });
    att.appendPcm(pcmSeconds(3));
    const a = await att.analyze([{ text: 'x', start: 0.1, end: 1.0, speaker: 0 }], 't1');
    expect(a!.segments[0].identity).toBeNull();
    expect(a!.segments[0].name).toBeNull();
  });

  it('returns null for an empty utterance', async () => {
    const att = new IdentityAttributor(fakeSidecar(() => alice, { calls: [] }), { sessionId: 's', streamId: 'st' });
    expect(await att.analyze([], 't1')).toBeNull();
  });

  it('recentWindow returns the last N seconds of buffered audio without calling identify', async () => {
    const seen = { calls: [] as number[] };
    const att = new IdentityAttributor(fakeSidecar(() => alice, seen), { sessionId: 's', streamId: 'st' });
    att.appendPcm(pcmSeconds(12)); // 12s buffered
    const w = att.recentWindow(8);
    expect(w).not.toBeNull();
    expect(seen.calls.length).toBe(0); // no identify — individual endpoint, owner already known
    expect(w!.windowSec).toBeCloseTo(8.0, 2); // trailing 8s, independent of any final span
    expect(w!.pcm.length % 2).toBe(0);
  });

  it('recentWindow returns all buffered audio when less than requested (short session)', async () => {
    const att = new IdentityAttributor(fakeSidecar(() => alice, { calls: [] }), { sessionId: 's', streamId: 'st' });
    att.appendPcm(pcmSeconds(3)); // only 3s so far
    const w = att.recentWindow(8);
    expect(w).not.toBeNull();
    expect(w!.windowSec).toBeCloseTo(3.0, 2); // caller's enrollMinSpeechSec gate then skips enroll
  });

  it('recentWindow returns null when nothing is buffered', () => {
    const att = new IdentityAttributor(fakeSidecar(() => alice, { calls: [] }), { sessionId: 's', streamId: 'st' });
    expect(att.recentWindow(8)).toBeNull();
  });

  it('appendSilence advances the media clock (mirrors provider-injected idle silence)', () => {
    const att = new IdentityAttributor(fakeSidecar(() => alice, { calls: [] }), { sessionId: 's', streamId: 'st' });
    att.appendPcm(pcmSeconds(2));
    att.appendSilence(1); // xAI forceCommit injected 1s of silence the ring never saw
    const w = att.recentWindow(60);
    expect(w!.windowSec).toBeCloseTo(3.0, 2); // 2s audio + 1s silence
  });

  it('reset drops all buffered audio (realign after a backend reconnect)', () => {
    const att = new IdentityAttributor(fakeSidecar(() => alice, { calls: [] }), { sessionId: 's', streamId: 'st' });
    att.appendPcm(pcmSeconds(5));
    att.reset();
    expect(att.recentWindow(8)).toBeNull();
    // A fresh append after reset starts a new timeline from 0.
    att.appendPcm(pcmSeconds(2));
    expect(att.recentWindow(60)!.windowSec).toBeCloseTo(2.0, 2);
  });

  it('slices from the retained tail after the ring drops old audio', async () => {
    const seen = { calls: [] as number[] };
    const att = new IdentityAttributor(fakeSidecar(() => alice, seen), { sessionId: 's', streamId: 'st', maxBufferSec: 2 });
    att.appendPcm(pcmSeconds(2));
    att.appendPcm(pcmSeconds(2)); // drops first → buffer covers 2..4
    const a = await att.analyze([{ text: 'y', start: 3.0, end: 3.8, speaker: 0 }], 't1');
    expect(a).not.toBeNull();
    expect(a!.segments[0].identity).toBe('alice');
    expect(seen.calls[0]).toBeGreaterThan(0);
  });
});
