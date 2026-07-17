import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/store/MemoryStore.js';

const v = (...xs: number[]): Float32Array => Float32Array.from(xs);

describe('MemoryStore', () => {
  it('upserts and queries by tenant', async () => {
    const s = new MemoryStore();
    await s.upsert('t1', 'alice', v(1, 0, 0));
    await s.upsert('t1', 'bob', v(0, 1, 0));
    await s.upsert('t2', 'carol', v(0, 0, 1));
    expect((await s.query('t1')).map((x) => x.identity).sort()).toEqual(['alice', 'bob']);
    expect((await s.query('t2')).map((x) => x.identity)).toEqual(['carol']);
  });

  it('rolls the centroid toward repeated samples and keeps it normalized', async () => {
    const s = new MemoryStore();
    await s.upsert('t1', 'alice', v(1, 0, 0));
    await s.upsert('t1', 'alice', v(0, 1, 0));
    const [a] = await s.query('t1');
    expect(a.vector[0]).toBeCloseTo(0.707, 2);
    expect(a.vector[1]).toBeCloseTo(0.707, 2);
    let n = 0;
    for (const x of a.vector) n += x * x;
    expect(Math.sqrt(n)).toBeCloseTo(1, 3);
  });

  it('deletes an identity across tenants', async () => {
    const s = new MemoryStore();
    await s.upsert('t1', 'alice', v(1, 0, 0));
    await s.delete('alice');
    expect(await s.query('t1')).toEqual([]);
  });
});
