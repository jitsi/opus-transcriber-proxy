import { describe, it, expect } from 'vitest';
import { SidecarWsClient, type WsLike } from '../../../src/identity/SidecarWsClient';

const tick = () => new Promise((r) => setTimeout(r, 0));

class MockWs implements WsLike {
  readyState = 0;
  sent: string[] = [];
  private listeners: Record<string, ((ev: any) => void)[]> = {};
  addEventListener(t: string, cb: (ev: any) => void) {
    (this.listeners[t] ??= []).push(cb);
  }
  emit(t: string, ev: any) {
    (this.listeners[t] || []).forEach((f) => f(ev));
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
  open() {
    this.readyState = 1;
    this.emit('open', {});
  }
  reply(obj: object) {
    this.emit('message', { data: JSON.stringify(obj) });
  }
}

describe('SidecarWsClient', () => {
  it('normalizes the URL to ws(s)://host/ws (token rides the Authorization header, not the query) and multiplexes a request', async () => {
    const mock = new MockWs();
    let seenUrl = '';
    const c = new SidecarWsClient({
      url: 'http://sidecar:8090/',
      token: 'tok',
      timeoutMs: 1000,
      wsFactory: (u) => {
        seenUrl = u;
        return mock;
      },
    });
    const p = c.identify('ten', Buffer.from([1, 2, 3, 4]));
    mock.open();
    await tick();
    // Token is no longer in the URL (it would land in access/proxy logs) — it's an Authorization
    // header set by the default factory; the injected wsFactory only sees the URL.
    expect(seenUrl).toBe('ws://sidecar:8090/ws');
    const sent = JSON.parse(mock.sent[0]);
    expect(sent.type).toBe('identify');
    expect(sent.tenant).toBe('ten');
    mock.reply({ id: sent.id, type: 'result', result: { identity: 'alice', score: 0.9, name: 'Alice' } });
    expect(await p).toEqual({ identity: 'alice', score: 0.9, name: 'Alice' });
  });

  it('enroll resolves true on ack', async () => {
    const mock = new MockWs();
    const c = new SidecarWsClient({ url: 'ws://x/', token: 't', wsFactory: () => mock });
    const p = c.enroll('alice', 'ten', Buffer.from([0, 0]));
    mock.open();
    await tick();
    const sent = JSON.parse(mock.sent[0]);
    mock.reply({ id: sent.id, type: 'ack' });
    expect(await p).toBe(true);
  });

  it('returns null on timeout', async () => {
    const mock = new MockWs();
    const c = new SidecarWsClient({ url: 'ws://x/', token: 't', timeoutMs: 40, wsFactory: () => mock });
    const p = c.identify('ten', Buffer.from([0, 0]));
    mock.open();
    expect(await p).toBeNull(); // never replied
  });

  it('returns null when the connect hangs (never opens) — bounded by the connect timeout', async () => {
    const mock = new MockWs(); // never .open()ed → no open/error/close ever fires
    const c = new SidecarWsClient({ url: 'ws://x/', token: 't', timeoutMs: 30, wsFactory: () => mock });
    expect(await c.identify('ten', Buffer.from([0, 0]))).toBeNull();
  });

  it('retries after a synchronous factory throw (the connect memo is cleared, not latched)', async () => {
    const mock = new MockWs();
    let calls = 0;
    const c = new SidecarWsClient({
      url: 'ws://x/',
      token: 't',
      timeoutMs: 1000,
      wsFactory: () => {
        calls++;
        if (calls === 1) throw new Error('refused'); // first attempt throws synchronously
        return mock;
      },
    });
    expect(await c.identify('ten', Buffer.from([0, 0]))).toBeNull(); // first → null
    const p = c.identify('ten', Buffer.from([1, 2, 3, 4])); // second must retry, not return latched null
    mock.open();
    await tick();
    expect(calls).toBe(2); // factory invoked again → memo was cleared
    const sent = JSON.parse(mock.sent[0]);
    mock.reply({ id: sent.id, type: 'result', result: { identity: 'alice', score: 0.9, name: 'Alice' } });
    expect(await p).toEqual({ identity: 'alice', score: 0.9, name: 'Alice' });
  });

  it('returns null when the socket fails to connect', async () => {
    const c = new SidecarWsClient({
      url: 'ws://x/',
      token: 't',
      wsFactory: () => {
        throw new Error('refused');
      },
    });
    expect(await c.identify('ten', Buffer.from([0, 0]))).toBeNull();
  });
});
