import { describe, it, expect } from 'vitest';
import { handleForIndex } from '../src/pipeline/handles.js';

describe('handleForIndex', () => {
  it('is deterministic', () => {
    expect(handleForIndex(0)).toBe(handleForIndex(0));
  });

  it('gives distinct handles for distinct indices', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) seen.add(handleForIndex(i));
    expect(seen.size).toBe(16);
  });

  it('produces a two-word friendly handle', () => {
    expect(handleForIndex(0).split(' ')).toHaveLength(2);
  });
});
