import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_ORIGIN, sleep, startApp, within, wsClient, type TestClient } from './helpers/app';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

const tight = {
  ws: { maxPerIp: 2, maxClients: 3, helloTimeoutMs: 100, idleNoRoomMs: 200, idleNeverJoinedMs: 200, sweepMs: 20, handshake: { capacity: 50, refillPerSec: 0 } },
};

async function boot(over: Parameters<typeof startApp>[0] = {}) {
  const s = await startApp({ security: tight, ...over });
  close = s.close;
  return s;
}

const viaTunnel = (ip: string) => ({ ip, origin: PUBLIC_ORIGIN });

describe('admissão de conexões WebSocket', () => {
  it('limita conexões simultâneas por IP (4029) e libera a vaga ao fechar', async () => {
    // Sem prazo de hello curto: a4 só pode fechar por causa do limite, não por corrida com o sweep.
    const { port } = await boot({ security: { ...tight, ws: { ...tight.ws, helloTimeoutMs: 10_000 } } });
    const a1 = (await wsClient(port, viaTunnel('203.0.113.1'))).client!;
    const a2 = (await wsClient(port, viaTunnel('203.0.113.1'))).client!;
    const a3 = (await wsClient(port, viaTunnel('203.0.113.1'))).client!;
    expect((await a3.waitFor((m) => m.t === 'error')).t).toBe('error');
    expect((await a3.closed).code).toBe(4029);
    a1.ws.close();
    await a1.closed;
    await sleep(30);
    const a4 = (await wsClient(port, viaTunnel('203.0.113.1'))).client!;
    expect(await within(a4.closed, 100)).toBe('timeout');
    a2.ws.close();
    a4.ws.close();
  });

  it('teto global de conexões → 503', async () => {
    const { port } = await boot();
    await wsClient(port, viaTunnel('203.0.113.1'));
    await wsClient(port, viaTunnel('203.0.113.1'));
    const b = await wsClient(port, viaTunnel('203.0.113.2'));
    expect(b.client).toBeDefined();
    const c = await wsClient(port, viaTunnel('203.0.113.3'));
    expect(c.status).toBe(503);
  });

  it('Origin: estranho ou ausente pelo túnel → 403; ausente sem túnel abre', async () => {
    const { port } = await boot();
    expect((await wsClient(port, { ip: '203.0.113.1', origin: 'https://evil.example' })).status).toBe(403);
    expect((await wsClient(port, { ip: '203.0.113.1' })).status).toBe(403);
    const local = await wsClient(port);
    expect(local.client).toBeDefined();
    local.client!.ws.close();
  });

  it('taxa de handshakes por IP → 429', async () => {
    const { port } = await boot({ security: { ...tight, ws: { ...tight.ws, handshake: { capacity: 3, refillPerSec: 0 } } } });
    for (let i = 0; i < 3; i++) {
      const r = await wsClient(port, viaTunnel('203.0.113.8'));
      expect(r.client).toBeDefined();
      r.client!.ws.close();
      await r.client!.closed;
    }
    expect((await wsClient(port, viaTunnel('203.0.113.8'))).status).toBe(429);
    expect((await wsClient(port, viaTunnel('203.0.113.9'))).client).toBeDefined();
  });

  it('sem hello → 4001 rapidamente', async () => {
    const { port } = await boot();
    const c = (await wsClient(port, viaTunnel('203.0.113.1'))).client!;
    const r = await within(c.closed, 500);
    expect(r !== 'timeout' && r.code).toBe(4001);
  });

  it('fora de sala por tempo demais → 4002; dentro de sala continua aberta', async () => {
    const { port } = await boot({ security: { ...tight, ws: { ...tight.ws, maxPerIp: 16, maxClients: 50 } } });
    const lost = (await wsClient(port, viaTunnel('203.0.113.1'))).client!;
    lost.send({ t: 'hello', name: 'X', mode: 'join', code: 'ZZZZ' });
    const r = await within(lost.closed, 1000);
    expect(r !== 'timeout' && r.code).toBe(4002);

    const inRoom = (await wsClient(port, viaTunnel('203.0.113.2'))).client!;
    inRoom.send({ t: 'hello', name: 'Y', mode: 'quick' });
    await inRoom.waitFor((m) => m.t === 'lobby');
    expect(await within(inRoom.closed, 1000)).toBe('timeout');
    inRoom.ws.close();
  });

  it('guarda de memória (heap) recusa novos handshakes com 503 e libera quando o heap cai', async () => {
    let heap = 9999;
    const { port } = await boot({ heapMB: () => heap });
    await sleep(60);
    expect((await wsClient(port, viaTunnel('203.0.113.1'))).status).toBe(503);
    heap = 50;
    await sleep(60);
    const ok = await wsClient(port, viaTunnel('203.0.113.1'));
    expect(ok.client).toBeDefined();
    ok.client!.ws.close();
  });

  it('RSS alto retido pelo V8 não trava a entrada (a guarda olha o heap)', async () => {
    const { port } = await boot({ rssMB: () => 9999, heapMB: () => 40 });
    await sleep(60);
    const r = await wsClient(port, viaTunnel('203.0.113.1'));
    expect(r.client).toBeDefined();
    r.client!.ws.close();
  });

  it('IPv6: vários /64 do mesmo /48 somam no teto de conexões (4029)', async () => {
    const { port } = await boot({ security: { ...tight, ws: { ...tight.ws, maxClients: 50, maxPerNet: 3, helloTimeoutMs: 10_000 } } });
    const cs: TestClient[] = [];
    for (let i = 1; i <= 3; i++) cs.push((await wsClient(port, viaTunnel(`2001:db8:7:${i}::1`))).client!);
    const over = (await wsClient(port, viaTunnel('2001:db8:7:9::1'))).client!;
    expect((await over.closed).code).toBe(4029);
    const otherNet = (await wsClient(port, viaTunnel('2001:db8:8:1::1'))).client!;
    expect(await within(otherNet.closed, 100)).toBe('timeout');
    for (const c of [...cs, otherNet]) c.ws.close();
  });

  it('IPv6: taxa de handshakes também por /48', async () => {
    const { port } = await boot({
      security: { ...tight, ws: { ...tight.ws, maxClients: 50, handshake: { capacity: 50, refillPerSec: 0 }, handshakeNet: { capacity: 3, refillPerSec: 0 } } },
    });
    for (let i = 1; i <= 3; i++) {
      const r = await wsClient(port, viaTunnel(`2001:db8:9:${i}::1`));
      expect(r.client).toBeDefined();
      r.client!.ws.close();
    }
    expect((await wsClient(port, viaTunnel('2001:db8:9:77::1'))).status).toBe(429);
    const other = await wsClient(port, viaTunnel('2001:db8:a:1::1'));
    expect(other.client).toBeDefined();
    other.client!.ws.close();
  });

  it('nunca entrou numa sala: prazo curto; já jogou nesta conexão: prazo longo', async () => {
    const { port } = await boot({ security: { ...tight, ws: { ...tight.ws, maxClients: 50, maxPerIp: 16, idleNeverJoinedMs: 150, idleNoRoomMs: 5_000 } } });
    const lost = (await wsClient(port, viaTunnel('203.0.113.20'))).client!;
    lost.send({ t: 'hello', name: 'X', mode: 'join', code: 'ZZZZ' });
    const r = await within(lost.closed, 1000);
    expect(r !== 'timeout' && r.code).toBe(4002);

    const played = (await wsClient(port, viaTunnel('203.0.113.21'))).client!;
    played.send({ t: 'hello', name: 'Y', mode: 'quick' });
    await played.waitFor((m) => m.t === 'lobby');
    played.send({ t: 'leave' });
    expect(await within(played.closed, 600)).toBe('timeout');
    played.ws.close();
  });

  it('vivo e parado na partida → 4003 e vira bot; quem joga continua', async () => {
    const { port, app } = await boot({ security: { ...tight, ws: { ...tight.ws, maxClients: 50, maxPerIp: 16, idleInPlayMs: 300 } } });
    const afk = (await wsClient(port, viaTunnel('203.0.113.30'))).client!;
    afk.send({ t: 'hello', name: 'Parado', mode: 'create' });
    await afk.waitFor((m) => m.t === 'lobby');
    afk.send({ t: 'startnow' });
    await afk.waitFor((m) => m.t === 'start', 3000);
    const r = await within(afk.closed, 2000);
    expect(r !== 'timeout' && r.code).toBe(4003);
    expect(app.security.summary().byKind.ws_idle_in_play).toBe(1);
    await sleep(250);
    // Sem humanos a sala foi abandonada e liberou a vaga.
    expect(app.lobby.rooms.size).toBe(0);

    const active = (await wsClient(port, viaTunnel('203.0.113.31'))).client!;
    active.send({ t: 'hello', name: 'Ativo', mode: 'create' });
    await active.waitFor((m) => m.t === 'lobby');
    active.send({ t: 'startnow' });
    await active.waitFor((m) => m.t === 'start', 3000);
    for (let i = 0; i < 8; i++) {
      active.send({ t: 'act', a: 'ataque' });
      await sleep(100);
    }
    expect(await within(active.closed, 50)).toBe('timeout');
    active.ws.close();
  });

  it('peer que não responde ao close por abuso é derrubado logo (terminate), sem ficar em CLOSING', async () => {
    const { port, app } = await boot({
      security: { ...tight, ws: { ...tight.ws, maxClients: 50, helloTimeoutMs: 10_000, closeGraceMs: 150, msg: { capacity: 2, refillPerSec: 0 }, abuse: { windowMs: 10_000, maxDropped: 3, maxInvalid: 10 } } },
    });
    const c = (await wsClient(port, viaTunnel('203.0.113.40'))).client!;
    // Para de ler o socket: o close frame do servidor nunca é respondido.
    (c.ws as unknown as { _socket: import('node:net').Socket })._socket.pause();
    for (let i = 0; i < 10; i++) c.send({ t: 'leave' });
    await sleep(80);
    expect(app.security.summary().byKind.ws_abuse_closed).toBe(1);
    const t0 = Date.now();
    while (app.wss.clients.size > 0 && Date.now() - t0 < 2000) await sleep(20);
    expect(app.wss.clients.size).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1000);
    c.ws.terminate();
  });

  it('upgrade fora de /ws não abre', async () => {
    const { port } = await boot();
    const r = await wsClient(port, { path: '/outro' });
    expect(r.client).toBeUndefined();
    expect(r.status).toBe(404);
  });

  it('chave confiável (VB_TRUSTED_IPS) passa do limite por IP', async () => {
    const { port } = await boot({ trustedKeys: ['203.0.113.7'], security: { ...tight, ws: { ...tight.ws, maxClients: 50, helloTimeoutMs: 10_000 } } });
    const cs: TestClient[] = [];
    for (let i = 0; i < 4; i++) cs.push((await wsClient(port, viaTunnel('203.0.113.7'))).client!);
    for (const c of cs) c.send({ t: 'hello', name: 'T', mode: 'quick' });
    await Promise.all(cs.map((c) => c.waitFor((m) => m.t === 'lobby')));
    expect(cs.every((c) => c.ws.readyState === c.ws.OPEN)).toBe(true);
    for (const c of cs) c.ws.close();
  });
});
