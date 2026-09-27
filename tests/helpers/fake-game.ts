// Servidor falso do contrato jogo → observador (GET /internal/stats?since=<seq>).
// Usado nos testes e no "npm run dev:obs" para ver o painel sem o jogo real.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OBS_STATS_PATH, OBS_TOKEN_HEADER, type ObsEvent, type ObsEventType, type ObsStats } from '../../shared/src/obs';

export type FakeMode = 'ok' | 'error500' | 'hang' | 'garbage';

export interface FakeGame {
  url: string;
  server: Server;
  stats: Omit<ObsStats, 'events' | 'nextSeq' | 'now'>;
  mode: FakeMode;
  requests: { since: string | null; token: string | undefined }[];
  emit(type: ObsEventType, data: ObsEvent['data'], t?: number): ObsEvent;
  /** Simula um reinício do processo: startedAt novo, seq e contadores do zero. */
  restart(version?: string): void;
  close(): Promise<void>;
}

export function baseStats(startedAt = Date.now() - 60_000): FakeGame['stats'] {
  return {
    startedAt,
    version: '1.0.0-test',
    process: {
      rssMB: 80,
      heapUsedMB: 30,
      cpuPct: 12.5,
      eventLoopLagMs: { p50: 1.2, p99: 8.4, max: 20 },
      tickMs: { p50: 2, p99: 6, max: 11 },
    },
    connections: { open: 5, total: 42 },
    players: { online: 5, lobby: 2, playing: 3, spectating: 0 },
    rooms: [
      { code: 'ABCD', private: false, state: 'play', humans: 3, bots: 5, alive: 6, phase: 'cacada', elapsedMs: 150_000 },
      { code: 'WXYZ', private: true, state: 'lobby', humans: 2, bots: 0, alive: 0, phase: 'lobby', elapsedMs: 20_000 },
    ],
    counters: {
      joins: 10,
      matchesStarted: 3,
      matchesEnded: 2,
      battles: { wild: 50, pvp: 12, final: 2 },
      eliminations: 7,
      rateLimited: 1,
      rejectedConnections: 0,
      originRejected: 2,
      errors: 0,
    },
    breakdown: { countries: { BR: 4, PT: 1 }, devices: { mobile: 3, desktop: 2 } },
  };
}

export async function startFakeGame(token: string, port = 0): Promise<FakeGame> {
  let events: ObsEvent[] = [];
  let seq = 0;
  const hanging = new Set<import('node:http').ServerResponse>();
  const game: FakeGame = {
    url: '',
    server: undefined as unknown as Server,
    stats: baseStats(),
    mode: 'ok',
    requests: [],
    emit(type, data, t = Date.now()) {
      const e: ObsEvent = { seq: seq++, t, type, data };
      events.push(e);
      if (events.length > 500) events = events.slice(-500);
      return e;
    },
    restart(version = '1.0.1-test') {
      events = [];
      seq = 0;
      game.stats = { ...baseStats(Date.now()), version };
    },
    async close() {
      for (const r of hanging) r.destroy();
      game.server.closeAllConnections();
      await new Promise<void>((r) => game.server.close(() => r()));
    },
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (url.pathname !== OBS_STATS_PATH) {
      res.writeHead(404).end();
      return;
    }
    const tok = req.headers[OBS_TOKEN_HEADER] as string | undefined;
    game.requests.push({ since: url.searchParams.get('since'), token: tok });
    if (tok !== token) {
      res.writeHead(401).end();
      return;
    }
    if (game.mode === 'hang') {
      hanging.add(res);
      return;
    }
    if (game.mode === 'error500') {
      res.writeHead(500).end('boom');
      return;
    }
    if (game.mode === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"nope":');
      return;
    }
    const since = Number(url.searchParams.get('since') ?? 0) || 0;
    const body: ObsStats = { ...game.stats, now: Date.now(), events: events.filter((e) => e.seq >= since), nextSeq: seq };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  game.server = server;
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  game.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return game;
}
