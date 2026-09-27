import { describe, expect, it } from 'vitest';
import { KeyedBuckets, SECURITY, SecurityLog, SlidingWindow, TokenBucket, ipKey, ipTag, netKey, resolveSecurity } from '../server/src/security';
import { httpGet, startApp } from './helpers/app';

describe('TokenBucket', () => {
  it('libera a capacidade, recusa o excedente e recarrega pelo relógio', () => {
    const b = new TokenBucket(20, 10, 0);
    for (let i = 0; i < 20; i++) expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(100)).toBe(true);
    expect(b.take(100)).toBe(false);
  });

  it('com recarga 0 nunca recarrega', () => {
    const b = new TokenBucket(2, 0, 0);
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(true);
    expect(b.take(1_000_000)).toBe(false);
  });
});

describe('KeyedBuckets', () => {
  it('chaves independentes, sweep remove os cheios e o teto tira a mais antiga', () => {
    const k = new KeyedBuckets(1, 1, 3);
    expect(k.take('a', 0)).toBe(true);
    expect(k.take('a', 0)).toBe(false);
    expect(k.take('b', 0)).toBe(true);
    expect(k.size).toBe(2);
    k.sweep(5000);
    expect(k.size).toBe(0);

    k.take('a', 0);
    k.take('b', 0);
    k.take('c', 0);
    k.take('d', 0);
    expect(k.size).toBe(3);
    // 'a' saiu: volta como balde novo (cheio).
    expect(k.take('a', 0)).toBe(true);
    expect(k.take('d', 0)).toBe(false);
  });
});

describe('SlidingWindow', () => {
  it('conta na janela e esquece depois dela', () => {
    const w = new SlidingWindow(60_000, 10);
    for (let i = 0; i < 10; i++) w.hit('x', 1000);
    expect(w.count('x', 1000)).toBe(10);
    expect(w.count('x', 61_001)).toBe(0);
    for (let i = 0; i < 50; i++) w.hit('y', 0);
    expect(w.count('y', 0)).toBe(11); // no máximo max+1 marcas
  });
});

describe('SecurityLog', () => {
  const mk = () => {
    let t = 0;
    const lines: string[] = [];
    const log = new SecurityLog({ now: () => t, write: (l) => lines.push(l), throttleMs: 60_000, summaryMs: 60_000, salt: 'sal' });
    return { log, lines, at: (v: number) => (t = v) };
  };

  it('agrupa eventos iguais e conta os suprimidos', () => {
    const { log, lines, at } = mk();
    for (let i = 0; i < 1000; i++) log.event('ws_rate_limited', '203.0.113.7');
    expect(lines).toHaveLength(1);
    at(60_000);
    log.event('ws_rate_limited', '203.0.113.7');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ ev: 'sec', kind: 'ws_rate_limited', n: 999 });
  });

  it('escreve sempre uma linha só e nunca o IP cru', () => {
    const { log, lines } = mk();
    log.event('http_error', '203.0.113.7', 'a\nb' + 'x'.repeat(200));
    expect(lines).toHaveLength(1);
    expect(lines[0].split('\n')).toHaveLength(1);
    expect(lines[0]).not.toContain('203.0.113');
    expect(JSON.parse(lines[0]).d.length).toBe(80);
    expect(ipTag('203.0.113.7', 'sal')).toMatch(/^[0-9a-f]{10}$/);
    expect(ipTag('203.0.113.7', 'sal')).not.toContain('203.0.113');
  });

  it('summary soma os agregados e tick escreve o resumo', () => {
    const { log, lines, at } = mk();
    log.event('http_rate_limited', 'a');
    log.event('ws_handshake_rate', 'a');
    log.event('lobby_join_bruteforce', 'b');
    log.event('ws_ip_limit', 'c');
    log.event('ws_origin_rejected', 'd');
    log.event('ws_origin_rejected', 'e');
    const s = log.summary();
    expect(s.rateLimited).toBe(3);
    expect(s.rejectedConnections).toBe(2);
    expect(s.originRejected).toBe(2);
    expect(s.byKind.ws_origin_rejected).toBe(2);
    at(60_000);
    log.tick(60_000);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ev: 'sec_summary', rateLimited: 3 });
  });
});

describe('resolveSecurity', () => {
  it('faz merge profundo sem mutar o padrão', () => {
    const c = resolveSecurity({ ws: { maxPerIp: 2, msg: { capacity: 5 } } });
    expect(c.ws.maxPerIp).toBe(2);
    expect(c.ws.msg).toEqual({ capacity: 5, refillPerSec: SECURITY.ws.msg.refillPerSec });
    expect(c.ws.maxClients).toBe(SECURITY.ws.maxClients);
    expect(SECURITY.ws.maxPerIp).toBe(16);
    expect(SECURITY.ws.msg.capacity).toBe(20);
  });
});

describe('createApp (smoke)', () => {
  it('responde /health e fecha sem deixar nada pendurado', async () => {
    const { port, close } = await startApp();
    const r = await httpGet(port, '/health');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
    await close();
  });
});

describe('KeyedBuckets.refund e netKey', () => {
  it('refund devolve a ficha sem passar da capacidade', () => {
    const b = new KeyedBuckets(2, 0);
    expect(b.take('a', 0)).toBe(true);
    expect(b.take('a', 0)).toBe(true);
    expect(b.take('a', 0)).toBe(false);
    b.refund('a', 0);
    expect(b.take('a', 0)).toBe(true);
    b.refund('a', 0);
    b.refund('a', 0);
    b.refund('a', 0);
    expect(b.take('a', 0) && b.take('a', 0)).toBe(true);
    expect(b.take('a', 0)).toBe(false);
    b.refund('sem-balde', 0);
    expect(b.size).toBe(1);
  });

  it('netKey agrupa /64 em /48 e ignora IPv4', () => {
    expect(netKey(ipKey('2001:db8:1:2::5'))).toBe('2001:db8:1::/48');
    expect(netKey(ipKey('2001:db8:1:ffff::5'))).toBe(netKey(ipKey('2001:db8:1:2::9')));
    expect(netKey(ipKey('2001:db8:2:2::5'))).not.toBe(netKey(ipKey('2001:db8:1:2::5')));
    expect(netKey('203.0.113.1')).toBeNull();
    expect(netKey('local')).toBeNull();
  });
});
