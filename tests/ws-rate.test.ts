import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMsg } from '@vb/shared';
import { makeSender, type SendTarget } from '../server/src/app';
import { SECURITY } from '../server/src/security';
import { PUBLIC_ORIGIN, sleep, startApp, within, wsClient } from './helpers/app';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

describe('rate limit de mensagens por conexão', () => {
  const opts = { security: { ws: { msg: { capacity: 5, refillPerSec: 0 }, abuse: { maxDropped: 10, maxInvalid: 10 } } } };

  it('flood fecha com 1008 e não atrapalha quem está jogando', async () => {
    const s = await startApp(opts);
    close = s.close;
    const good = (await wsClient(s.port, { ip: '198.51.100.1', origin: PUBLIC_ORIGIN })).client!;
    good.send({ t: 'hello', name: 'Boa', mode: 'quick' });
    await good.waitFor((m) => m.t === 'lobby');

    const bad = (await wsClient(s.port, { ip: '198.51.100.2', origin: PUBLIC_ORIGIN })).client!;
    for (let i = 0; i < 30; i++) bad.send({ t: 'leave' });
    expect((await bad.closed).code).toBe(1008);

    const before = good.msgs.length;
    await good.waitFor((m) => m.t === 'lobby' && good.msgs.length > before, 2500);
    expect(good.ws.readyState).toBe(good.ws.OPEN);
    good.ws.close();
  });

  it('quem manda poucas mensagens espaçadas não é fechado', async () => {
    const s = await startApp(opts);
    close = s.close;
    const c = (await wsClient(s.port, { ip: '198.51.100.3', origin: PUBLIC_ORIGIN })).client!;
    for (let i = 0; i < 5; i++) {
      c.send({ t: 'leave' });
      await sleep(20);
    }
    expect(await within(c.closed, 200)).toBe('timeout');
    c.ws.close();
  });

  it('mensagens inválidas em sequência fecham com 1008', async () => {
    const s = await startApp();
    close = s.close;
    const c = (await wsClient(s.port, { ip: '198.51.100.4', origin: PUBLIC_ORIGIN })).client!;
    for (let i = 0; i < 12; i++) c.send('{');
    expect((await c.closed).code).toBe(1008);
  });
});

describe('frames de controle (ping/pong)', () => {
  it('flood de pings é limitado, contado e fecha com 1008', async () => {
    const lines: string[] = [];
    const s = await startApp({ log: (l) => lines.push(l) });
    close = s.close;
    const c = (await wsClient(s.port, { ip: '198.51.100.5', origin: PUBLIC_ORIGIN })).client!;
    let pongs = 0;
    c.ws.on('pong', () => pongs++);
    const payload = Buffer.alloc(125, 1);
    for (let i = 0; i < 5000 && c.ws.readyState === c.ws.OPEN; i++) c.ws.ping(payload);
    expect((await c.closed).code).toBe(1008);
    // Só o balde de controle (5) é respondido; o resto é descartado e contado.
    expect(pongs).toBeLessThanOrEqual(SECURITY.ws.ctrl.capacity + 1);
    const sum = s.app.security.summary();
    expect(sum.byKind.ws_abuse_closed).toBe(1);
    expect(sum.rateLimited).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('ws_abuse_closed') && l.includes('ctrl'))).toBe(true);
  });

  it('flood de pongs não solicitados também fecha', async () => {
    const s = await startApp();
    close = s.close;
    const c = (await wsClient(s.port, { ip: '198.51.100.6', origin: PUBLIC_ORIGIN })).client!;
    for (let i = 0; i < 2000 && c.ws.readyState === c.ws.OPEN; i++) c.ws.pong();
    expect((await c.closed).code).toBe(1008);
  });

  it('poucos pings espaçados recebem pong e a conexão segue', async () => {
    const s = await startApp();
    close = s.close;
    const c = (await wsClient(s.port, { ip: '198.51.100.7', origin: PUBLIC_ORIGIN })).client!;
    let pongs = 0;
    c.ws.on('pong', () => pongs++);
    for (let i = 0; i < 3; i++) c.ws.ping();
    await sleep(100);
    expect(pongs).toBe(3);
    expect(c.ws.readyState).toBe(c.ws.OPEN);
    c.ws.close();
  });

  it('o heartbeat do servidor continua funcionando (pong do cliente marca vivo)', async () => {
    const s = await startApp({ security: { ws: { heartbeatMs: 40, helloTimeoutMs: 10_000 } } });
    close = s.close;
    const c = (await wsClient(s.port, { ip: '198.51.100.8', origin: PUBLIC_ORIGIN })).client!;
    expect(await within(c.closed, 400)).toBe('timeout');
    c.ws.close();
  });
});

describe('makeSender (backpressure)', () => {
  const snap = { t: 'snap' } as ServerMsg;
  const bstart = { t: 'b_start' } as ServerMsg;
  const fake = (bufferedAmount: number) => ({ readyState: 1, OPEN: 1, bufferedAmount, send: vi.fn(), terminate: vi.fn() }) satisfies SendTarget;

  it('pula snapshot com buffer cheio, mas entrega eventos de batalha', () => {
    const ws = fake(200 * 1024);
    const onEvent = vi.fn();
    const send = makeSender(ws, SECURITY.ws.backpressure, onEvent);
    send(snap);
    expect(ws.send).not.toHaveBeenCalled();
    send(bstart);
    expect(ws.send).toHaveBeenCalledOnce();
  });

  it('derruba quem não consome', () => {
    const ws = fake(2 * 1024 * 1024);
    const onEvent = vi.fn();
    makeSender(ws, SECURITY.ws.backpressure, onEvent)(bstart);
    expect(ws.terminate).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith('ws_slow_consumer');
  });

  it('buffer vazio envia tudo', () => {
    const ws = fake(0);
    makeSender(ws, SECURITY.ws.backpressure, () => {})(snap);
    expect(ws.send).toHaveBeenCalledWith('{"t":"snap"}');
  });
});
