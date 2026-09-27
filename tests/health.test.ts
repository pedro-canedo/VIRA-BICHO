import { afterEach, describe, expect, it } from 'vitest';
import { healthPayload } from '../server/src/app';
import { isTrustedLocal } from '../server/src/security';
import { httpGet, startApp, wsClient } from './helpers/app';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

describe('/health', () => {
  it('público recebe só {"ok":true}; LAN recebe números, nunca códigos de sala', async () => {
    const s = await startApp();
    close = s.close;
    const c = (await wsClient(s.port)).client!;
    c.send({ t: 'hello', name: 'Dono', mode: 'create' });
    const lobby = await c.waitFor((m) => m.t === 'lobby');
    const code = lobby.t === 'lobby' ? lobby.code : '';
    expect(code).toMatch(/^[A-Z]{4}$/);

    const pub = await httpGet(s.port, '/health', { 'cf-connecting-ip': '203.0.113.5' });
    expect(pub.status).toBe(200);
    expect(pub.body).toBe('{"ok":true}');
    expect(pub.headers['cache-control']).toBe('no-store');

    const ray = await httpGet(s.port, '/health', { 'cf-ray': '8abc-GRU' });
    expect(ray.body).toBe('{"ok":true}');

    const lan = await httpGet(s.port, '/health');
    expect(lan.body).toContain('players');
    expect(lan.body).toContain('rssMB');
    expect(lan.body).not.toContain(code);
    expect(JSON.parse(lan.body)).toMatchObject({ ok: true, rooms: 1, privateRooms: 1, players: 1, conns: 1 });
    c.ws.close();
  });

  it('healthPayload é pura e mínima para o público', () => {
    const lobby = { stats: () => ({ rooms: 2, privateRooms: 1, lobbyRooms: 1, playRooms: 1, players: 3 }) };
    const extra = { uptimeS: 1, rssMB: 50, conns: 3, security: {} };
    expect(healthPayload(false, lobby, extra)).toBe('{"ok":true}');
    expect(JSON.parse(healthPayload(true, lobby, extra))).toMatchObject({ ok: true, rooms: 2, players: 3, conns: 3 });
  });
});

describe('isTrustedLocal', () => {
  it('só confia em loopback/LAN sem cabeçalhos da Cloudflare', () => {
    expect(isTrustedLocal('127.0.0.1', {})).toBe(true);
    expect(isTrustedLocal('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' })).toBe(false);
    expect(isTrustedLocal('127.0.0.1', { 'cf-ray': 'x' })).toBe(false);
    expect(isTrustedLocal('192.168.3.19', {})).toBe(true);
    expect(isTrustedLocal('::ffff:192.168.3.19', {})).toBe(true);
    expect(isTrustedLocal('fe80::1', {})).toBe(true);
    expect(isTrustedLocal('8.8.8.8', {})).toBe(false);
    expect(isTrustedLocal(undefined, {})).toBe(false);
  });
});
