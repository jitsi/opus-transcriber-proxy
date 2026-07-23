import { describe, it, expect } from 'vitest';
import { buildDispatcherMessages, type DispatcherBase } from '../../../src/identity/dispatcherMessages';
import type { AttributedSegment } from '../../../src/identity/types';

const base: DispatcherBase = { sessionId: 's', endpointId: 'orig-a0', timestamp: 111, language: 'en' };
const seg = (identity: string | null, handle: string | null, text: string, name: string | null = null): AttributedSegment => ({
  sessionSpeakerId: identity ? 0 : 1,
  handle,
  identity,
  name,
  score: identity ? 0.9 : 0,
  text,
  start: 0,
  end: 1,
});

describe('buildDispatcherMessages', () => {
  it('no attribution → one message, no override, original text', () => {
    const msgs = buildDispatcherMessages(base, 'hello world', null);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].endpointId).toBe('orig-a0');
    expect(msgs[0].text).toBe('hello world');
    expect(msgs[0].resolvedParticipant).toBeUndefined();
  });

  it('single resolved speaker → override to identity', () => {
    const msgs = buildDispatcherMessages(base, 'orig', [seg('alice', 'Purple Otter', 'hi there')]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].endpointId).toBe('alice');
    expect(msgs[0].text).toBe('hi there');
    expect(msgs[0].resolvedParticipant).toEqual({ id: 'alice', name: 'alice' });
  });

  it('single UNresolved speaker → no override (fall back to KV via original)', () => {
    const msgs = buildDispatcherMessages(base, 'orig text', [seg(null, 'Amber Falcon', 'mumble')]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].endpointId).toBe('orig-a0');
    expect(msgs[0].text).toBe('orig text');
    expect(msgs[0].resolvedParticipant).toBeUndefined();
  });

  it('uses the resolved display name when present', () => {
    const msgs = buildDispatcherMessages(base, 'orig', [seg('u-123', 'Purple Otter', 'hi', 'Alice Smith')]);
    expect(msgs[0].resolvedParticipant).toEqual({ id: 'u-123', name: 'Alice Smith' });
  });

  it('room (multiple speakers) → resolved overrides, unresolved falls back to mic owner', () => {
    const msgs = buildDispatcherMessages(base, 'orig', [
      seg('alice', 'Purple Otter', 'first part'),
      seg(null, 'Amber Falcon', 'second part'),
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ endpointId: 'alice', text: 'first part', resolvedParticipant: { id: 'alice', name: 'alice' } });
    // Unresolved speaker → mic-owner endpoint, no synthetic unknown:<handle>, no override.
    expect(msgs[1].endpointId).toBe('orig-a0');
    expect(msgs[1].resolvedParticipant).toBeUndefined();
    expect(msgs[1].text).toBe('second part');
  });
});
