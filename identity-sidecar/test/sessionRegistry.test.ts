import { describe, it, expect } from 'vitest';
import { SessionRegistry } from '../src/pipeline/SessionRegistry.js';

describe('SessionRegistry', () => {
  it('creates then returns the same state instance', () => {
    const r = new SessionRegistry(() => 0, 1000, 0.5);
    const a = r.get('s', 'stream');
    const b = r.get('s', 'stream');
    expect(a).toBe(b);
  });

  it('end() removes the state', () => {
    const r = new SessionRegistry(() => 0, 1000, 0.5);
    const a = r.get('s', 'stream');
    r.end('s', 'stream');
    expect(r.get('s', 'stream')).not.toBe(a);
  });

  it('evictExpired drops entries older than ttl', () => {
    let now = 0;
    const r = new SessionRegistry(() => now, 1000, 0.5);
    r.get('s', 'stream');
    now = 500;
    expect(r.evictExpired()).toBe(0);
    now = 2000;
    expect(r.evictExpired()).toBe(1);
  });
});
