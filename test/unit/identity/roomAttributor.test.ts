import { describe, it, expect } from 'vitest';
import { attribute, type Word } from '../../../src/identity/RoomAttributor';
import type { AnalyzeTurn } from '../../../src/identity/SidecarClient';

const turn = (id: number, handle: string, identity: string | null, start: number, end: number): AnalyzeTurn => ({
  sessionSpeakerId: id,
  handle,
  identity,
  score: identity ? 0.9 : 0,
  start,
  end,
});

describe('RoomAttributor.attribute', () => {
  const words: Word[] = [
    { text: 'hello', start: 0.0, end: 0.5 },
    { text: 'there', start: 0.5, end: 1.0 },
    { text: 'hi', start: 5.0, end: 5.4 },
    { text: 'indeed', start: 5.4, end: 6.0 },
  ];
  const turns = [turn(0, 'Purple Otter', 'alice', 0, 2), turn(1, 'Amber Falcon', null, 4, 7)];

  it('splits an utterance into per-speaker segments', () => {
    const segs = attribute(words, turns);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ identity: 'alice', text: 'hello there', sessionSpeakerId: 0 });
    expect(segs[1]).toMatchObject({ identity: null, handle: 'Amber Falcon', text: 'hi indeed', sessionSpeakerId: 1 });
    expect(segs[0].start).toBe(0);
    expect(segs[1].end).toBe(6);
  });

  it('returns a single unattributed segment when there are no turns', () => {
    const segs = attribute(words, []);
    expect(segs).toHaveLength(1);
    expect(segs[0].sessionSpeakerId).toBeNull();
    expect(segs[0].identity).toBeNull();
    expect(segs[0].text).toBe('hello there hi indeed');
  });

  it('returns nothing for an empty utterance', () => {
    expect(attribute([], turns)).toEqual([]);
  });

  it('keeps one segment when all words map to the same speaker', () => {
    const single = [turn(0, 'Purple Otter', 'alice', 0, 10)];
    const segs = attribute(words, single);
    expect(segs).toHaveLength(1);
    expect(segs[0].identity).toBe('alice');
  });

  it('merges a single-word island flanked by the same speaker', () => {
    const w: Word[] = [
      { text: 'made', start: 0.5, end: 1.0 },
      { text: 'whilst', start: 2.4, end: 2.6 }, // stray word landing on the other speaker
      { text: 'filmed', start: 3.5, end: 4.0 },
    ];
    const t = [
      turn(0, 'Purple Otter', 'alice', 0, 2),
      turn(1, 'Amber Falcon', null, 2, 3),
      turn(0, 'Purple Otter', 'alice', 3, 5),
    ];
    const segs = attribute(w, t);
    expect(segs).toHaveLength(1);
    expect(segs[0].identity).toBe('alice');
    expect(segs[0].text).toBe('made whilst filmed');
  });
});
