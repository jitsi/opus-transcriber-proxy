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
  it('normalizes the URL to ws(s)://host/ws?token= and multiplexes a request', async () => {
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
    expect(seenUrl).toBe('ws://sidecar:8090/ws?token=tok');
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
