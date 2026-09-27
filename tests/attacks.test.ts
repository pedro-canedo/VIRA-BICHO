import { afterEach, describe, expect, it } from 'vitest';
import type { ServerMsg } from '@vb/shared';
import { PUBLIC_ORIGIN, httpGet, sleep, startApp, within, wsClient, type TestClient } from './helpers/app';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

const tunnel = (ip: string) => ({ ip, origin: PUBLIC_ORIGIN });
const isErr = (text: string) => (m: ServerMsg) => m.t === 'error' && m.msg.includes(text);

describe('ataques pelo túnel, de ponta a ponta', () => {
  it('hello sem parar é freado sem derrubar a conexão', async () => {
    const s = await startApp();
    close = s.close;
    const c = (await wsClient(s.port, tunnel('198.51.100.10'))).client!;
    for (let i = 0; i < 6; i++) c.send({ t: 'hello', name: 'Spam', mode: 'quick' });
    await c.waitFor(isErr('Calma!'));
    expect(await within(c.closed, 100)).toBe('timeout');
    c.ws.close();
  });

  it('criação de salas em excesso pelo mesmo IP é barrada, e outro IP segue criando', async () => {
    const s = await startApp();
    close = s.close;
    const ip = '198.51.100.20';
    // Duas salas ao mesmo tempo passam; a terceira não.
    const a = (await wsClient(s.port, tunnel(ip))).client!;
    const b = (await wsClient(s.port, tunnel(ip))).client!;
    a.send({ t: 'hello', name: 'A', mode: 'create' });
    b.send({ t: 'hello', name: 'B', mode: 'create' });
    await Promise.all([a.waitFor((m) => m.t === 'lobby'), b.waitFor((m) => m.t === 'lobby')]);
    const c = (await wsClient(s.port, tunnel(ip))).client!;
    c.send({ t: 'hello', name: 'C', mode: 'create' });
    await c.waitFor(isErr('salas demais ao mesmo tempo'));

    // Criar, começar e sair em ciclo esgota a taxa de criação (4 no total, 2 já foram).
    for (const x of [a, b]) {
      x.send({ t: 'startnow' });
      await x.waitFor((m) => m.t === 'start', 3000);
      x.send({ t: 'leave' });
    }
    await sleep(250); // salas abandonadas somem no tick
    for (let i = 0; i < 2; i++) {
      const x = (await wsClient(s.port, tunnel(ip))).client!;
      x.send({ t: 'hello', name: 'X', mode: 'create' });
      await x.waitFor((m) => m.t === 'lobby');
      x.send({ t: 'startnow' });
      await x.waitFor((m) => m.t === 'start', 3000);
      x.send({ t: 'leave' });
      x.ws.close();
    }
    await sleep(250);
    const d = (await wsClient(s.port, tunnel(ip))).client!;
    d.send({ t: 'hello', name: 'D', mode: 'create' });
    await d.waitFor(isErr('criou salas demais'));

    const other = (await wsClient(s.port, tunnel('198.51.100.21'))).client!;
    other.send({ t: 'hello', name: 'O', mode: 'create' });
    await other.waitFor((m) => m.t === 'lobby');
    for (const x of [a, b, c, d, other]) x.ws.close();
  });

  it('sozinho, Jogar agora / Sair várias vezes na mesma conexão nunca trava na taxa de criação', async () => {
    const s = await startApp({ security: { lobby: { helloPerConn: { capacity: 100, refillPerSec: 1 } } } });
    close = s.close;
    const c = (await wsClient(s.port, tunnel('192.0.2.50'))).client!;
    for (let i = 0; i < 8; i++) {
      const n = c.msgs.length;
      c.send({ t: 'hello', name: 'Solo', mode: 'quick' });
      const m = await c.waitFor((x) => c.msgs.indexOf(x) >= n && (x.t === 'lobby' || x.t === 'error'));
      expect(m.t).toBe('lobby');
      c.send({ t: 'leave' });
      await sleep(10);
    }
    expect(s.app.security.summary().byKind.lobby_create_rate).toBeUndefined();
    c.ws.close();
  });

  it('força bruta de código de sala é travada por IP', async () => {
    const s = await startApp();
    close = s.close;
    const conns: TestClient[] = [];
    for (let i = 0; i < 4; i++) conns.push((await wsClient(s.port, tunnel('198.51.100.30'))).client!);
    let n = 0;
    // 3 hellos por conexão (limite por conexão) × 4 conexões = 12 tentativas.
    for (const c of conns) for (let i = 0; i < 3; i++) c.send({ t: 'hello', name: 'B', mode: 'join', code: `Z${n++ % 10}ZZ` });
    const all = () => conns.flatMap((c) => c.msgs);
    await conns[3].waitFor(isErr('Muitas tentativas'));
    expect(all().filter(isErr('Sala não encontrada')).length).toBe(10);
    for (const c of conns) c.ws.close();
  });

  it('/health público não tem códigos de sala', async () => {
    const s = await startApp();
    close = s.close;
    const c = (await wsClient(s.port, tunnel('198.51.100.40'))).client!;
    c.send({ t: 'hello', name: 'P', mode: 'create' });
    const m = await c.waitFor((x) => x.t === 'lobby');
    const code = m.t === 'lobby' ? m.code : '????';
    const r = await httpGet(s.port, '/health', { 'cf-connecting-ip': '198.51.100.41' });
    expect(r.body).toBe('{"ok":true}');
    expect(r.body).not.toContain(code);
    c.ws.close();
  });

  it('eventos de segurança chegam ao log sem IP cru', async () => {
    const lines: string[] = [];
    const s = await startApp({ log: (l) => lines.push(l) });
    close = s.close;
    await wsClient(s.port, { ip: '198.51.100.50', origin: 'https://evil.example/caminho?x=TEXTO-LIVRE-DO-ATACANTE' });
    await wsClient(s.port, { ip: '198.51.100.51', origin: 'nao eh url TEXTO-LIVRE' });
    expect(s.app.security.summary().originRejected).toBe(2);
    const origin = lines.map((l) => JSON.parse(l)).filter((l) => l.kind === 'ws_origin_rejected');
    // Só o host (ou um rótulo), nunca o valor cru do cabeçalho.
    expect(origin.map((l) => l.d).sort()).toEqual(['bad_origin', 'evil.example']);
    expect(lines.join('\n')).not.toContain('TEXTO-LIVRE');
    expect(lines.join('\n')).not.toContain('198.51.100.50');
  });
});

describe('jogador legítimo', () => {
  it('entra, começa a partida, anda e recebe snapshots pelo túnel', async () => {
    const s = await startApp();
    close = s.close;
    const c = (await wsClient(s.port, tunnel('198.51.100.60'))).client!;
    c.send({ t: 'hello', name: 'Pedro', mode: 'quick' });
    await c.waitFor((m) => m.t === 'lobby');
    c.send({ t: 'startnow' });
    const start = await c.waitFor((m) => m.t === 'start', 3000);
    const snap = await c.waitFor((m) => m.t === 'snap' && !!m.me, 3000);
    if (start.t !== 'start' || snap.t !== 'snap' || !snap.me) throw new Error('sem start/snap');
    const from = { x: snap.me.x, y: snap.me.y };
    // Toques espaçados como no cliente (pointerup), bem abaixo dos limites.
    for (let i = 0; i < 3; i++) {
      c.send({ t: 'move', x: from.x + 3, y: from.y });
      await sleep(150);
    }
    const n = c.msgs.length;
    await c.waitFor((m) => m.t === 'snap' && c.msgs.length > n + 5, 3000);
    // Andou de verdade: algum snapshot depois do comando tem outra posição.
    const moved = await c.waitFor((m) => m.t === 'snap' && !!m.me && (m.me.x !== from.x || m.me.y !== from.y), 3000);
    expect(moved.t).toBe('snap');
    const last = c.msgs.findLast((m) => m.t === 'snap');
    expect(last?.t === 'snap' && last.me?.alive).toBe(true);
    expect(await within(c.closed, 50)).toBe('timeout');
    c.ws.close();
  });
});
