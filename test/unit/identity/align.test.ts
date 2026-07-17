import { describe, it, expect } from 'vitest';
import { alignWordsToTurns } from '../../../src/identity/align';

describe('alignWordsToTurns', () => {
  const turns = [
    { start: 0, end: 5 },
    { start: 5, end: 10 },
  ];

  it('assigns a word inside a turn to that turn', () => {
    expect(alignWordsToTurns([{ start: 1, end: 2 }], turns)).toEqual([0]);
    expect(alignWordsToTurns([{ start: 6, end: 7 }], turns)).toEqual([1]);
  });

  it('assigns a straddling word to the greater-overlap turn', () => {
    // 4-5.5: overlap turn0=1.0, turn1=0.5 -> turn0
    expect(alignWordsToTurns([{ start: 4, end: 5.5 }], turns)).toEqual([0]);
  });

  it('assigns a word past the end to the nearest turn', () => {
    expect(alignWordsToTurns([{ start: 20, end: 21 }], turns)).toEqual([1]);
  });

  it('returns -1 when there are no turns', () => {
    expect(alignWordsToTurns([{ start: 0, end: 1 }], [])).toEqual([-1]);
  });
});
