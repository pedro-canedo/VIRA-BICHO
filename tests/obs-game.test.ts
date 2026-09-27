import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BALANCE, OBS_STATS_PATH, OBS_TOKEN_HEADER, isWalkable, type ObsEvent, type ObsStats, type ServerMsg, type Vec } from '@vb/shared';
import { GameCollector, normalizeStats } from '../observer/src/collector';
import type { StoredEvent } from '../observer/src/events';
import type { AppOptions } from '../server/src/app';
import type { Entity } from '../server/src/entities';
import type { Room } from '../server/src/room';
import { ipKey } from '../server/src/security';
import { PUBLIC_ORIGIN, httpGet, rawHttp, sleep, startApp, wsClient, type TestClient } from './helpers/app';

const TOKEN = 'token-interno-de-teste-0123456789';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; moto g) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.restoreAllMocks();
});

/** App real + endpoint interno numa porta livre de 127.0.0.1. */
async function startObs(over: Partial<AppOptions> = {}) {
  const lines: string[] = [];
  const s = await startApp({ log: (l) => lines.push(l), obs: { token: TOKEN, rate: { capacity: 1000, refillPerSec: 1000 } }, ...over });
  const obsPort = await s.app.listenInternal(0);
  cleanup = s.close;
  const stats = async (since = 0): Promise<ObsStats> => {
    const r = await httpGet(obsPort, `${OBS_STATS_PATH}?since=${since}`, { [OBS_TOKEN_HEADER]: TOKEN });
    expect(r.status).toBe(200);
    return JSON.parse(r.body) as ObsStats;
  };
  return { ...s, obsPort, lines, stats };
}

/** Espera uma condição (com prazo), opcionalmente fazendo algo a cada volta (ex.: avançar o relógio e o tick). */
async function until(pred: () => boolean | Promise<boolean>, step: () => void = () => {}, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('condição não aconteceu a tempo');
    step();
    await sleep(5);
  }
}

const QUANT = ['max', 'p50', 'p99'];

/** Todos os campos do contrato, com os tipos certos, e nada além deles. */
function expectContract(x: ObsStats): void {
  const keys = (o: object) => Object.keys(o).sort();
  expect(keys(x)).toEqual(['breakdown', 'connections', 'counters', 'events', 'nextSeq', 'now', 'players', 'process', 'rooms', 'startedAt', 'version']);
  expect(typeof x.version).toBe('string');
  expect(x.version.length).toBeGreaterThan(0);
  expect(x.now).toBeGreaterThanOrEqual(x.startedAt);
  expect(keys(x.process)).toEqual(['cpuPct', 'eventLoopLagMs', 'heapUsedMB', 'rssMB', 'tickMs']);
  expect(keys(x.process.eventLoopLagMs)).toEqual(QUANT);
  expect(keys(x.process.tickMs)).toEqual(QUANT);
  expect(keys(x.connections)).toEqual(['open', 'total']);
  expect(keys(x.players)).toEqual(['lobby', 'online', 'playing', 'spectating']);
  expect(keys(x.counters)).toEqual(['battles', 'eliminations', 'errors', 'joins', 'matchesEnded', 'matchesStarted', 'originRejected', 'rateLimited', 'rejectedConnections']);
  expect(keys(x.counters.battles)).toEqual(['final', 'pvp', 'wild']);
  expect(keys(x.breakdown)).toEqual(['countries', 'devices']);
  expect(keys(x.breakdown.devices)).toEqual(['desktop', 'mobile']);
  for (const r of x.rooms) expect(keys(r)).toEqual(['alive', 'bots', 'code', 'elapsedMs', 'humans', 'phase', 'private', 'state']);
  for (const e of x.events) expect(keys(e)).toEqual(['data', 'seq', 't', 'type']);
  const nums = (o: unknown): void => {
    if (typeof o === 'number') expect(Number.isFinite(o) && o >= 0).toBe(true);
    else if (o && typeof o === 'object' && !Array.isArray(o)) Object.values(o).forEach(nums);
  };
  nums({ ...x, events: [], rooms: [] });
  // O observador aceita a resposta sem cortar nem zerar nada.
  expect(normalizeStats(JSON.parse(JSON.stringify(x)))).toEqual(x);
}

const ofType = (events: ObsEvent[], type: string) => events.filter((e) => e.type === type).map((e) => e.data);

describe('endpoint interno: só local e autenticado', () => {
  it('sem OBS_INTERNAL_TOKEN (ou com menos de 16 caracteres) o endpoint não existe e o log não mostra o valor', async () => {
    for (const token of [undefined, 'curtinho-123']) {
      const lines: string[] = [];
      const s = await startApp({ log: (l) => lines.push(l), obs: { token } });
      expect(s.app.internal).toBeNull();
      await expect(s.app.listenInternal(0)).rejects.toThrow();
      expect(lines.some((l) => l.includes('obs_internal_off'))).toBe(true);
      expect(lines.join('\n')).not.toContain('curtinho');
      // O jogo segue normal.
      expect((await httpGet(s.port, '/health')).status).toBe(200);
      await s.close();
    }
  });

  it('escuta só em 127.0.0.1 e não existe no servidor público', async () => {
    const s = await startObs();
    const addr = s.app.internal!.address();
    expect(addr).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    // Nenhuma outra interface (IPv6 de loopback, LAN) responde nessa porta.
    const others = ['::1', ...Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal).map((i) => i!.address)];
    for (const host of others) {
      const ok = await new Promise<boolean>((resolve) => {
        const sock = connect({ host, port: s.obsPort });
        sock.setTimeout(500, () => (sock.destroy(), resolve(false)));
        sock.once('connect', () => (sock.destroy(), resolve(true)));
        sock.once('error', () => resolve(false));
      });
      expect(ok, `porta interna aberta em ${host}`).toBe(false);
    }
    // O servidor público (o que o túnel alcança) não conhece a rota, nem com o token.
    const pub = await httpGet(s.port, OBS_STATS_PATH, { [OBS_TOKEN_HEADER]: TOKEN });
    expect(pub.status).toBe(404);
    expect(pub.body).not.toContain('startedAt');
  });

  it('401 sem token ou com token errado; nada de dados sem autenticação', async () => {
    const s = await startObs();
    const get = (headers: Record<string, string>, path = OBS_STATS_PATH) => httpGet(s.obsPort, path, headers);
    const cases: Record<string, string>[] = [{}, { [OBS_TOKEN_HEADER]: '' }, { [OBS_TOKEN_HEADER]: 'x' }, { [OBS_TOKEN_HEADER]: TOKEN.slice(0, -1) + 'X' }, { [OBS_TOKEN_HEADER]: `${TOKEN}a` }, { authorization: `Bearer ${TOKEN}` }];
    for (const headers of cases) {
      const r = await get(headers);
      expect(r.status).toBe(401);
      expect(r.body).not.toContain('startedAt');
    }
    // Rota desconhecida também não responde nada sem o token.
    expect((await get({}, '/internal/outra')).status).toBe(401);
    expect((await get({ [OBS_TOKEN_HEADER]: TOKEN }, '/internal/outra')).status).toBe(404);
    const ok = await get({ [OBS_TOKEN_HEADER]: TOKEN });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/json');
    expect(ok.headers['cache-control']).toBe('no-store');
    // O log registra a falha sem o token.
    expect(s.lines.some((l) => l.includes('obs_internal_unauthorized'))).toBe(true);
    expect(s.lines.join('\n')).not.toContain(TOKEN);
  });

  it('resiste a entradas estranhas: método, alvo malformado, since inválido, cabeçalhos de proxy e excesso', async () => {
    const s = await startObs({ obs: { token: TOKEN, rate: { capacity: 12, refillPerSec: 0 } } });
    const auth = { [OBS_TOKEN_HEADER]: TOKEN };
    expect((await httpGet(s.obsPort, OBS_STATS_PATH, auth, 'POST')).status).toBe(405);
    expect((await rawHttp(s.obsPort, '/internal/%zz', auth)).status).toBe(400);
    expect((await rawHttp(s.obsPort, 'http://evil/internal/stats', auth)).status).toBe(400);
    expect((await rawHttp(s.obsPort, `/${'a'.repeat(400)}`, auth)).status).toBe(414);
    expect((await httpGet(s.obsPort, `${OBS_STATS_PATH}?since=abc`, auth)).status).toBe(400);
    expect((await httpGet(s.obsPort, `${OBS_STATS_PATH}?since=-1`, auth)).status).toBe(400);
    // Algo repassado pelo túnel ou por proxy nunca é atendido, mesmo com o token.
    expect((await httpGet(s.obsPort, OBS_STATS_PATH, { ...auth, 'cf-connecting-ip': '203.0.113.5' })).status).toBe(403);
    expect((await httpGet(s.obsPort, OBS_STATS_PATH, { ...auth, 'x-forwarded-for': '203.0.113.5' })).status).toBe(403);
    // Lixo no socket não derruba nada.
    await new Promise<void>((resolve) => {
      const sock = connect(s.obsPort, '127.0.0.1', () => sock.end('\x00\x01GARBAGE\r\n\r\n'));
      sock.on('close', () => resolve());
      sock.on('error', () => resolve());
      sock.resume();
    });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await httpGet(s.obsPort, OBS_STATS_PATH, auth)).status);
    expect(statuses).toContain(200);
    expect(statuses.at(-1)).toBe(429);
    // O jogo segue de pé.
    expect((await httpGet(s.port, '/health')).status).toBe(200);
  });

  it('falhas de autenticação têm balde próprio: sem o token não dá para deixar o observador sem dados', async () => {
    const s = await startObs({ obs: { token: TOKEN, rate: { capacity: 3, refillPerSec: 0 }, failRate: { capacity: 5, refillPerSec: 0 } } });
    const bad: number[] = [];
    for (let i = 0; i < 60; i++) bad.push((await httpGet(s.obsPort, OBS_STATS_PATH, { [OBS_TOKEN_HEADER]: 'errado-errado-errado' })).status);
    expect(bad.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(new Set(bad.slice(5))).toEqual(new Set([429]));
    const good: number[] = [];
    for (let i = 0; i < 4; i++) good.push((await httpGet(s.obsPort, OBS_STATS_PATH, { [OBS_TOKEN_HEADER]: TOKEN })).status);
    expect(good).toEqual([200, 200, 200, 429]);
  });

  it('o monitor do event loop só liga na primeira leitura autenticada', async () => {
    const s = await startObs();
    const spy = vi.spyOn(s.app.metrics, 'enableLoopMonitor');
    expect((await httpGet(s.obsPort, OBS_STATS_PATH, { [OBS_TOKEN_HEADER]: 'x' })).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    await s.stats();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('porta interna ocupada: o jogo sobe, o erro sai uma vez só e o endpoint tenta de novo até conseguir', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = (blocker.address() as AddressInfo).port;
    const lines: string[] = [];
    const s = await startApp({ log: (l) => lines.push(l), obs: { token: TOKEN } });
    cleanup = async () => {
      await s.close();
      await new Promise<void>((r) => blocker.close(() => r()));
    };
    s.app.serveInternal(busy, 40);
    await sleep(300);
    const errs = lines.filter((l) => l.includes('obs_internal_'));
    expect(errs).toHaveLength(1);
    expect(JSON.parse(errs[0])).toMatchObject({ ev: 'obs_internal_listen_error', code: 'EADDRINUSE', fails: 1, retryInMs: 40 });
    expect((await httpGet(s.port, '/health')).status).toBe(200);
    await new Promise<void>((r) => blocker.close(() => r()));
    cleanup = s.close;
    await until(() => lines.some((l) => l.includes('obs_internal_listening')));
    const ok = lines.find((l) => l.includes('obs_internal_listening'))!;
    expect(JSON.parse(ok)).toMatchObject({ host: '127.0.0.1', port: busy });
    expect(JSON.parse(ok).afterFails).toBeGreaterThanOrEqual(1);
    expect((await httpGet(busy, OBS_STATS_PATH, { [OBS_TOKEN_HEADER]: TOKEN })).status).toBe(200);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('close() para as novas tentativas de escutar a porta interna', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = (blocker.address() as AddressInfo).port;
    const s = await startApp({ obs: { token: TOKEN } });
    s.app.serveInternal(busy, 20);
    await sleep(60);
    await s.close();
    await new Promise<void>((r) => blocker.close(() => r()));
    await sleep(100);
    expect(s.app.internal!.listening).toBe(false);
  });

  it('fecha junto com o app', async () => {
    const s = await startObs();
    await s.stats();
    await s.close();
    cleanup = null;
    const refused = await new Promise<boolean>((resolve) => {
      const sock = connect(s.obsPort, '127.0.0.1');
      sock.once('connect', () => (sock.destroy(), resolve(false)));
      sock.once('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  });
});

describe('contrato ObsStats com o jogo real', () => {
  it('formato completo, since/nextSeq e startedAt estável', async () => {
    const s = await startObs();
    const empty = await s.stats();
    expectContract(empty);
    expect(empty.events).toEqual([]);
    expect(empty.nextSeq).toBe(0);

    const clients: TestClient[] = [];
    for (const name of ['Um', 'Dois', 'Tres']) {
      const c = (await wsClient(s.port)).client!;
      c.send({ t: 'hello', name, mode: 'create' });
      await c.waitFor((m) => m.t === 'lobby');
      clients.push(c);
    }
    const all = await s.stats();
    expectContract(all);
    expect(all.events.map((e) => [e.seq, e.type, e.data.name])).toEqual([
      [0, 'join', 'Um'],
      [1, 'join', 'Dois'],
      [2, 'join', 'Tres'],
    ]);
    expect(all.nextSeq).toBe(3);
    expect(all.startedAt).toBe(empty.startedAt);
    expect(all.counters.joins).toBe(3);
    expect(all.connections).toEqual({ open: 3, total: 3 });
    expect(all.players).toEqual({ online: 3, lobby: 3, playing: 0, spectating: 0 });
    expect(all.rooms).toHaveLength(3);
    expect(all.rooms.every((r) => r.private && r.state === 'lobby' && r.phase === 'lobby' && r.humans === 1)).toBe(true);
    const codes = all.events.map((e) => e.data.room);
    expect(all.rooms.map((r) => r.code).sort()).toEqual([...codes].sort());

    const tail = await s.stats(1);
    expect(tail.events.map((e) => e.seq)).toEqual([1, 2]);
    expect((await s.stats(all.nextSeq)).events).toEqual([]);
    // since no futuro (observador com cursor de um processo antigo): nada, e o nextSeq real.
    const future = await s.stats(999);
    expect(future.events).toEqual([]);
    expect(future.nextSeq).toBe(3);
    for (const c of clients) c.ws.close();
  });

  it('o coletor do observador lê o jogo real (up, eventos e cursor)', async () => {
    const s = await startObs();
    const c = (await wsClient(s.port)).client!;
    c.send({ t: 'hello', name: 'Coletado', mode: 'quick' });
    await c.waitFor((m) => m.t === 'lobby');
    let id = 1;
    const stored: StoredEvent[] = [];
    const col = new GameCollector({
      gameUrl: `http://127.0.0.1:${s.obsPort}`,
      internalToken: TOKEN,
      timeoutMs: 1500,
      addEvent: (e) => {
        const ev = { ...e, id: id++ };
        stored.push(ev);
        return ev;
      },
    });
    await col.poll();
    expect(col.state.status).toBe('up');
    expect(col.fresh()?.players.online).toBe(1);
    expect(stored.map((e) => [e.type, e.data.name])).toEqual([['join', 'Coletado']]);
    expect(col.cursor.nextSeq).toBe(1);

    const wrong = new GameCollector({ gameUrl: `http://127.0.0.1:${s.obsPort}`, internalToken: 'outro-token-qualquer-123', timeoutMs: 1500, addEvent: (e) => ({ ...e, id: 0 }) });
    await wrong.poll();
    expect(wrong.state.status).toBe('down');
    expect(wrong.state.lastError).toMatch(/401/);
    c.ws.close();
  });
});

/** Um tile andável vizinho (Chebyshev 1) de `p`. */
function neighbor(room: Room, p: Vec): Vec {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    if (isWalkable(room.map, p.x + dx, p.y + dy)) return { x: p.x + dx, y: p.y + dy };
  }
  throw new Error('sem vizinho andável');
}

function place(e: Entity, at: Vec): void {
  e.x = at.x;
  e.y = at.y;
  e.path = [];
  if (e.kind === 'wild') e.wanderAt = Number.POSITIVE_INFINITY;
}

describe('eventos de uma partida com clientes ws reais', () => {
  it('join, match_start, batalhas (selvagem, pvp, final), duel, match_end e leave', async () => {
    let t = 1_700_000_000_000;
    // Relógio falso: o teste avança as fases e faz ticks à mão. Sem prazos de ociosidade no caminho.
    const s = await startObs({ now: () => t, security: { ws: { idleInPlayMs: 1e12, idleNoRoomMs: 1e12, idleNeverJoinedMs: 1e12 } } });
    const tick = (ms: number = BALANCE.tickMs) => s.app.lobby.tick((t += ms));
    const tunnel = (ip: string, country: string, ua: string) => ({ ip, origin: PUBLIC_ORIGIN, headers: { 'cf-ipcountry': country, 'user-agent': ua } });

    const A = (await wsClient(s.port, tunnel('203.0.113.10', 'BR', ANDROID))).client!;
    A.send({ t: 'hello', name: 'Ana', mode: 'quick' });
    await A.waitFor((m) => m.t === 'lobby');
    const B = (await wsClient(s.port, tunnel('203.0.113.11', 'PT', WINDOWS))).client!;
    B.send({ t: 'hello', name: 'Bia', mode: 'quick' });
    await B.waitFor((m) => m.t === 'lobby');
    const room = [...s.app.lobby.rooms.values()][0];
    expect(room.members.size).toBe(2);

    let st = await s.stats();
    expect(st.players).toEqual({ online: 2, lobby: 2, playing: 0, spectating: 0 });
    expect(st.breakdown).toEqual({ countries: { BR: 1, PT: 1 }, devices: { mobile: 1, desktop: 1 } });
    expect(ofType(st.events, 'join')).toEqual([
      { name: 'Ana', mode: 'quick', room: room.code, country: 'BR', device: 'mobile' },
      { name: 'Bia', mode: 'quick', room: room.code, country: 'PT', device: 'desktop' },
    ]);

    // Início.
    A.send({ t: 'startnow' });
    await until(() => room.state === 'play', () => tick());
    const start = (await A.waitFor((m) => m.t === 'start')) as Extract<ServerMsg, { t: 'start' }>;
    const pa = room.players.get(start.you)!;
    const pb = [...room.members].find((m) => m.name === 'Bia')!.player!;
    st = await s.stats();
    expect(ofType(st.events, 'match_start')).toEqual([{ room: room.code, humans: 2, bots: 6, players: 8 }]);
    expect(st.players).toEqual({ online: 2, lobby: 0, playing: 2, spectating: 0 });
    expect(st.rooms[0]).toMatchObject({ code: room.code, state: 'play', phase: 'coleta', humans: 2, bots: 6, alive: 8 });

    // Batalha contra selvagem: um bicho ao lado da Ana e ela mira nele pelo WebSocket.
    await until(() => {
      if (pa.battle?.kind === 'wild') return true;
      const w = [...room.wilds.values()].find((x) => !x.battle);
      if (w && !pa.battle) {
        place(w, neighbor(room, pa));
        A.send({ t: 'target', id: w.id });
      }
      return false;
    }, () => tick());
    await until(() => pa.battle === null, () => tick(1000));

    // PvP na Caçada: Bia ao lado da Ana, que mira nela.
    room.startedAt = t - BALANCE.phases.coletaEnd - 1;
    tick();
    expect(room.phase).toBe('cacada');
    await until(() => {
      if (s.app.metrics.snapshot(0, { rooms: [], openConns: 0, security: { rateLimited: 0, rejectedConnections: 0, originRejected: 0 } }).counters.battles.pvp > 0) return true;
      if (!pa.battle && !pb.battle && pa.alive && pb.alive) {
        pa.shieldUntil = pb.shieldUntil = 0;
        place(pb, neighbor(room, pa));
        A.send({ t: 'target', id: pb.id });
      }
      return false;
    }, () => tick());

    // Duelo Final e fim.
    room.startedAt = t - BALANCE.phases.finalEnd;
    tick();
    expect(room.phase).toBe('duelo');
    st = await s.stats();
    expect(ofType(st.events, 'duel')).toEqual([{ room: room.code, a: room.duel!.a.name, b: room.duel!.b.name }]);
    expect(st.counters.battles.final).toBe(1);
    expect(st.rooms[0].phase).toBe('duelo');
    expect(st.players.online).toBe(2);
    expect(st.players.playing + st.players.spectating).toBe(2);
    const finalists = [room.duel!.a, room.duel!.b].filter((p) => p === pa || p === pb).length;
    expect(st.players.playing).toBe(finalists);

    await until(() => room.state === 'fim', () => tick(2000), 10_000);
    const winner = [...room.players.values()].find((p) => p.place === 1)!;
    st = await s.stats();
    expect(ofType(st.events, 'match_end')).toEqual([
      { room: room.code, winner: winner.name, form: room.look(winner).form, durationMs: room.endedAt - room.startedAt, humans: 2 },
    ]);
    expect(st.rooms[0]).toMatchObject({ state: 'fim', phase: 'fim' });
    expect(st.players).toEqual({ online: 2, lobby: 0, playing: 0, spectating: 2 });

    // Saídas: pelo menu e fechando a aba.
    A.send({ t: 'leave' });
    await until(async () => ofType((await s.stats()).events, 'leave').length === 1);
    // Na tela de fim, quem saiu passa a contar como bot: humans + bots continua sendo o total.
    st = await s.stats();
    expect(st.rooms[0]).toMatchObject({ state: 'fim', humans: 1, bots: 7 });
    B.ws.close(1001);
    await until(async () => ofType((await s.stats()).events, 'leave').length === 2);

    st = await s.stats();
    expect(ofType(st.events, 'leave')).toEqual([
      { name: 'Ana', room: room.code, reason: 'saiu', inMatch: false },
      { name: 'Bia', room: room.code, reason: 'fechou', inMatch: false },
    ]);
    const types = st.events.map((e) => e.type);
    expect(types[0]).toBe('join');
    expect(types.indexOf('match_start')).toBeLessThan(types.indexOf('duel'));
    expect(types.indexOf('duel')).toBeLessThan(types.indexOf('match_end'));
    expect(types.indexOf('match_end')).toBeLessThan(types.indexOf('leave'));
    expect(st.events.map((e) => e.seq)).toEqual(st.events.map((_, i) => i));
    expect(st.counters).toMatchObject({ joins: 2, matchesStarted: 1, matchesEnded: 1, eliminations: 7, errors: 0 });
    expect(st.counters.battles.wild).toBeGreaterThanOrEqual(1);
    expect(st.counters.battles.pvp).toBeGreaterThanOrEqual(1);
    expect(st.counters.battles.final).toBe(1);
    expect(st.players.online).toBe(0);
    expect(st.process.tickMs.max).toBeGreaterThanOrEqual(0);
    expectContract(st);

    // Os logs nunca levam IP cru, token nem código de sala.
    const log = s.lines.join('\n');
    for (const secret of ['203.0.113.10', '203.0.113.11', TOKEN, room.code]) expect(log).not.toContain(secret);
  });

  it('saída no meio da partida (vivo) e erro no tick da sala viram leave inMatch, error e match_end sem vencedor', async () => {
    const s = await startObs();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const A = (await wsClient(s.port)).client!;
    A.send({ t: 'hello', name: 'Ana', mode: 'quick' });
    await A.waitFor((m) => m.t === 'lobby');
    const B = (await wsClient(s.port)).client!;
    B.send({ t: 'hello', name: 'Bia', mode: 'quick' });
    await B.waitFor((m) => m.t === 'lobby');
    A.send({ t: 'startnow' });
    await A.waitFor((m) => m.t === 'start', 3000);
    B.ws.terminate();
    await until(async () => ofType((await s.stats()).events, 'leave').length === 1);
    const room = [...s.app.lobby.rooms.values()][0];
    let thrown = false;
    room.tick = () => {
      if (thrown) return;
      thrown = true;
      throw new Error('boom');
    };
    await until(async () => (await s.stats()).counters.errors === 1);
    const st = await s.stats();
    expect(ofType(st.events, 'leave')).toEqual([{ name: 'Bia', room: room.code, reason: 'caiu', inMatch: true }]);
    expect(ofType(st.events, 'error')).toEqual([{ message: 'tick: Error: boom' }]);
    expect(ofType(st.events, 'match_end')).toMatchObject([{ room: room.code, winner: null, form: null, humans: 2 }]);
    expect(st.counters.matchesEnded).toBe(1);
    // O log do servidor não leva o código da sala.
    expect(errSpy.mock.calls.flat().map(String).join('\n')).not.toContain(room.code);
    A.ws.close();
  });

  it('partida abandonada (todos os humanos saem no meio) gera match_end sem vencedor e a sala some', async () => {
    const s = await startObs();
    const A = (await wsClient(s.port)).client!;
    A.send({ t: 'hello', name: 'Ana', mode: 'quick' });
    await A.waitFor((m) => m.t === 'lobby');
    A.send({ t: 'startnow' });
    await A.waitFor((m) => m.t === 'start', 3000);
    const room = [...s.app.lobby.rooms.values()][0];
    expect(room.state).toBe('play');
    A.ws.terminate();
    await until(async () => (await s.stats()).rooms.length === 0);
    const st = await s.stats();
    expect(ofType(st.events, 'leave')).toEqual([{ name: 'Ana', room: room.code, reason: 'caiu', inMatch: true }]);
    const ends = ofType(st.events, 'match_end');
    expect(ends).toMatchObject([{ room: room.code, winner: null, form: null, humans: 1 }]);
    expect(ends[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(st.counters.matchesStarted).toBe(1);
    expect(st.counters.matchesEnded).toBe(1);
    const types = st.events.map((e) => e.type);
    expect(types.indexOf('leave')).toBeLessThan(types.indexOf('match_end'));
    expect(st.players.online).toBe(0);
  });

  it('match_end não se repete quando a partida já tinha acabado antes do abandono', async () => {
    const s = await startObs();
    const A = (await wsClient(s.port)).client!;
    A.send({ t: 'hello', name: 'Ana', mode: 'quick' });
    await A.waitFor((m) => m.t === 'lobby');
    A.send({ t: 'startnow' });
    await A.waitFor((m) => m.t === 'start', 3000);
    const room = [...s.app.lobby.rooms.values()][0];
    // Fim normal (sem vencedor humano) e, no mesmo tick, a sala marcada como abandonada.
    s.app.metrics.matchEnd(room, null);
    room.abandoned = true;
    await until(async () => (await s.stats()).rooms.length === 0);
    const st = await s.stats();
    expect(ofType(st.events, 'match_end')).toHaveLength(1);
    expect(st.counters.matchesEnded).toBe(1);
    A.ws.close();
  });

  it('erro ao tratar mensagem conta em errors e não vira evento de segurança', async () => {
    const s = await startObs();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    s.app.lobby.handle = () => {
      throw new Error('falhou');
    };
    const c = (await wsClient(s.port)).client!;
    c.send({ t: 'hello', name: 'X', mode: 'quick' });
    await c.closed;
    const st = await s.stats();
    expect(st.counters.errors).toBe(1);
    expect(ofType(st.events, 'error')).toEqual([{ message: 'handle hello: Error: falhou' }]);
    expect(ofType(st.events, 'security')).toEqual([]);
  });
});

describe('país e dispositivo', () => {
  it('CF-IPCountry só vale pelo túnel (loopback + CF-Connecting-IP); direto ou pela LAN vira XX', async () => {
    const s = await startObs();
    let fakeRemote: string | null = null;
    // Simula uma conexão vinda da LAN: o remoteAddress do socket é o que o servidor usa.
    s.app.server.prependListener('connection', (sock) => {
      if (fakeRemote) Object.defineProperty(sock, 'remoteAddress', { value: fakeRemote, configurable: true });
    });
    const join = async (name: string, o: Parameters<typeof wsClient>[1]) => {
      const c = (await wsClient(s.port, o)).client!;
      c.send({ t: 'hello', name, mode: 'create' });
      await c.waitFor((m) => m.t === 'lobby');
      return c;
    };
    const viaTunnel = await join('Tunel', { ip: '203.0.113.20', origin: PUBLIC_ORIGIN, headers: { 'cf-ipcountry': 'PT', 'user-agent': ANDROID } });
    const direct = await join('Direto', { headers: { 'cf-ipcountry': 'US', 'user-agent': WINDOWS } });
    fakeRemote = '192.168.3.40';
    const lan = await join('Lan', { headers: { 'cf-connecting-ip': '203.0.113.21', 'cf-ipcountry': 'AR', 'user-agent': ANDROID } });
    fakeRemote = null;
    const st = await s.stats();
    expect(ofType(st.events, 'join').map((d) => [d.name, d.country, d.device])).toEqual([
      ['Tunel', 'PT', 'mobile'],
      ['Direto', 'XX', 'desktop'],
      ['Lan', 'XX', 'mobile'],
    ]);
    expect(st.breakdown).toEqual({ countries: { PT: 1, XX: 2 }, devices: { mobile: 2, desktop: 1 } });
    for (const c of [viaTunnel, direct, lan]) c.ws.close();
  });
});

describe('contadores de segurança', () => {
  it('bloqueios aparecem nos contadores e como eventos com ipHash (nunca o IP)', async () => {
    const s = await startObs({ security: { ws: { maxClients: 1 } } });
    const ip = '203.0.113.30';
    // Origin recusado pelo túnel.
    const evil = await wsClient(s.port, { ip, origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    // Limite de requisições HTTP por IP.
    let limited = 0;
    for (let i = 0; i < 70; i++) if ((await httpGet(s.port, '/health', { 'cf-connecting-ip': '203.0.113.31' })).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    // Servidor cheio.
    const first = (await wsClient(s.port, { ip: '203.0.113.32', origin: PUBLIC_ORIGIN })).client!;
    const full = await wsClient(s.port, { ip: '203.0.113.33', origin: PUBLIC_ORIGIN });
    expect(full.status).toBe(503);

    const st = await s.stats();
    const sum = s.app.security.summary();
    expect(st.counters.originRejected).toBe(1);
    expect(st.counters.rateLimited).toBe(sum.rateLimited);
    expect(st.counters.rateLimited).toBeGreaterThanOrEqual(limited);
    expect(st.counters.rejectedConnections).toBe(1);
    const sec = ofType(st.events, 'security');
    expect(sec).toContainEqual({ kind: 'ws_origin_rejected', ipHash: s.app.security.tag(ipKey(ip)), detail: 'evil.example' });
    expect(sec.map((d) => d.kind)).toEqual(expect.arrayContaining(['ws_origin_rejected', 'http_rate_limited', 'ws_server_full']));
    // O throttle do log vale para os eventos: 1 por tipo e IP no minuto, mesmo com dezenas de 429.
    expect(sec.filter((d) => d.kind === 'http_rate_limited')).toHaveLength(1);
    for (const d of sec) expect(d.ipHash).toMatch(/^[0-9a-f]{10}$/);
    const body = JSON.stringify(st);
    for (const raw of ['203.0.113.30', '203.0.113.31', '203.0.113.32', '203.0.113.33']) expect(body).not.toContain(raw);
    first.ws.close();
  });
});
