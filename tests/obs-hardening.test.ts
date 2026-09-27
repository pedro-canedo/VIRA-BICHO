import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameCollector } from '../observer/src/collector';
import { loadConfig, type ObsConfig } from '../observer/src/config';
import { DayAggregator, sanitizeDayStats } from '../observer/src/daystats';
import { EventStore, dayKey, readDayLast, readDayTail } from '../observer/src/events';
import { writeAtomic } from '../observer/src/fsutil';
import { Observer, type Summary } from '../observer/src/observer';
import { RingSeries } from '../observer/src/series';
import { createObsServer, type ObsServer } from '../observer/src/server';
import { startFakeGame, type FakeGame } from './helpers/fake-game';

const TOKEN = 'painel-'.padEnd(40, 'y');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let game: FakeGame;
let cfg: ObsConfig;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'obs-hard-'));
  game = await startFakeGame('interno');
  cfg = loadConfig({
    OBS_TOKEN: TOKEN,
    OBS_INTERNAL_TOKEN: 'interno',
    GAME_INTERNAL_URL: game.url,
    OBS_DATA_DIR: dir,
    OBS_PUBLIC_DIR: 'observer/public',
    OBS_SERVICE_DIR: '',
    PUBLIC_URL: `${game.url}/health`,
  });
});

afterEach(async () => {
  await game.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe('SSE com cliente que não lê (backpressure)', () => {
  let obs: Observer;
  let srv: ObsServer;
  let base: string;

  async function start(opts: { sseStallMs: number; sseMaxBufferedBytes?: number }) {
    obs = new Observer(cfg, { persist: false });
    await obs.init();
    await obs.pollGame();
    srv = createObsServer(obs, { token: TOKEN, publicDir: cfg.publicDir, heartbeatMs: 50, ...opts });
    await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(srv.server.address() as AddressInfo).port}`;
  }
  afterEach(async () => {
    srv.closeStreams();
    srv.server.closeAllConnections();
    await new Promise<void>((r) => srv.server.close(() => r()));
  });

  const bigTick = (n: number) => ({ summary: { n, pad: 'x'.repeat(200_000) } as unknown as Summary, events: [] });

  function openPaused(): Promise<{ req: http.ClientRequest; res: IncomingMessage }> {
    return new Promise((r) => {
      const req = http.get(`${base}/api/stream`, { headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
        res.pause();
        r({ req, res });
      });
    });
  }

  it('não acumula memória: coalesce os ticks e derruba o cliente travado', async () => {
    await start({ sseStallMs: 300 });
    const { req } = await openPaused();
    expect(srv.sseStreams).toBe(1);
    let maxBuffered = 0;
    // ~12 MB de ticks: bem mais do que os buffers do kernel no loopback absorvem.
    for (let i = 0; i < 60; i++) {
      obs.broadcast(bigTick(i));
      maxBuffered = Math.max(maxBuffered, srv.sseBufferedBytes());
      await sleep(2);
    }
    // No máximo um tick na fila do Node (o resto fica coalescido num único pendente).
    expect(maxBuffered).toBeLessThan(512 * 1024);
    // Travado por mais que sseStallMs: desconectado no próximo tick/heartbeat.
    await sleep(400);
    obs.broadcast(bigTick(99));
    await sleep(100);
    expect(srv.sseStreams).toBe(0);
    expect(obs.sseClients).toBe(0);
    req.destroy();
  });

  it('quando o cliente volta a ler recebe o resumo mais recente', async () => {
    await start({ sseStallMs: 30_000 });
    const { req, res } = await openPaused();
    for (let i = 0; i < 60; i++) {
      obs.broadcast(bigTick(i));
      await sleep(2);
    }
    let text = '';
    res.on('data', (d: Buffer) => (text += d.toString('utf8')));
    res.resume();
    const deadline = Date.now() + 5_000;
    while (!text.includes('"n":59') && Date.now() < deadline) await sleep(20);
    expect(text).toContain('"n":59');
    expect(srv.sseStreams).toBe(1);
    req.destroy();
  });
});

describe('arquivos de eventos grandes', () => {
  function writeDay(n: number, day = dayKey(Date.now())) {
    const t = Date.now();
    const lines: string[] = [];
    for (let i = 1; i <= n; i++) {
      lines.push(JSON.stringify({ id: i, t, type: 'match_end', data: { room: 'A', winner: 'w', form: 'mare', durationMs: 60_000, humans: 1 } }));
    }
    writeFileSync(join(dir, `events-${day}.ndjson`), lines.join('\n') + '\n');
  }

  it('restore lê só o fim do arquivo, e os ids continuam depois do maior', async () => {
    writeDay(5_000);
    const store = new EventStore(dir, { restoreTailBytes: 4096, capacity: 1000 });
    const tail = await store.restore();
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(40); // 4 KB ≈ 30 linhas
    expect(tail.at(-1)!.id).toBe(5_000);
    expect(store.add({ t: Date.now(), type: 'join', data: {} }).id).toBe(5_001);
    // readDayTail descarta a primeira linha parcial.
    const t2 = await readDayTail(dir, dayKey(Date.now()), 1000);
    expect(t2.every((e) => e.type === 'match_end')).toBe(true);
  });

  it('sem state.json, os agregados do dia são refeitos lendo o arquivo inteiro em fluxo', async () => {
    writeDay(5_000);
    const o = new Observer(cfg);
    await o.init();
    expect(o.day.view().matchesEnded).toBe(5_000);
    expect(o.events.query({ limit: 2000 }).length).toBeLessThanOrEqual(1000);
  });

  it('/api/events?day= guarda só os últimos N (readDayLast)', async () => {
    writeDay(3_000);
    const last = await readDayLast(dir, dayKey(Date.now()), 3);
    expect(last.map((e) => e.id)).toEqual([2998, 2999, 3000]);
    const filtered = await readDayLast(dir, dayKey(Date.now()), 2, (e) => e.id % 2 === 1);
    expect(filtered.map((e) => e.id)).toEqual([2997, 2999]);
  });

  it('teto de bytes por arquivo diário', async () => {
    const store = new EventStore(dir, { maxDayBytes: 2_000 });
    for (let i = 0; i < 100; i++) store.add({ t: Date.now(), type: 'security', data: { kind: 'rate_limit', ipHash: 'abcdef12', detail: 'flood' } });
    await store.flush();
    const file = join(dir, `events-${dayKey(Date.now())}.ndjson`);
    expect(statSync(file).size).toBeLessThanOrEqual(2_000);
    expect(store.dropped.get(dayKey(Date.now()))).toBeGreaterThan(0);
    // O feed em memória continua completo.
    expect(store.query({ limit: 200 })).toHaveLength(100);
  });
});

describe('salto de relógio nas séries', () => {
  it('relógio voltou: descarta as amostras "do futuro" e os dados novos aparecem', () => {
    const s = new RingSeries(100, ['online']);
    const base = 10_000_000;
    for (let i = 0; i < 10; i++) s.push(base + i * 5_000, { online: 10 });
    // Volta 30 s.
    const dropped = s.push(base + 15_000, { online: 50 });
    expect(dropped).toBe(7);
    s.push(base + 20_000, { online: 50 });
    const r = s.range(base, base + 60_000, 100);
    expect(r.fields.online).toEqual([10, 10, 10, 50, 50]);
    expect(s.max('online', base)).toBe(50);
  });

  it('uma amostra no futuro distante não esconde as seguintes', () => {
    const s = new RingSeries(100, ['online']);
    const now = 1_700_000_000_000;
    s.push(now, { online: 1 });
    s.push(now + 400 * 86_400_000, { online: 999 }); // "2027"
    s.push(now + 5_000, { online: 2 });
    s.push(now + 10_000, { online: 3 });
    expect(s.range(now - 1, now + 3_600_000, 1000).fields.online).toEqual([1, 2, 3]);
  });

  it('deserialize descarta amostras do futuro e fora de ordem', () => {
    const now = 1_700_000_000_000;
    const raw = new RingSeries(10, ['v']);
    // Cria um arquivo "ruim" empurrando valores sem passar pela proteção (via serialize de dois buffers).
    raw.push(now - 20_000, { v: 1 });
    raw.push(now - 10_000, { v: 2 });
    raw.push(now + 86_400_000, { v: 3 });
    const buf = raw.serialize();
    const r = RingSeries.deserialize(buf, 10, ['v'], 0, now + 60_000);
    expect(r.size).toBe(2);
    expect(r.last()?.values.v).toBe(2);
    r.push(now, { v: 4 });
    expect(r.range(now - 60_000, now + 1, 100).fields.v).toEqual([1, 2, 4]);
  });

  it('agregados do dia: relógio do observador voltando de dia recomeça em vez de ignorar tudo', () => {
    const today = new Date(2026, 8, 27, 12).getTime();
    const d = new DayAggregator(today);
    const yesterday = today - 86_400_000;
    // Evento atrasado de ontem: ignorado.
    d.onEvent({ id: 1, t: yesterday, type: 'match_end', data: { form: 'mare' } });
    expect(d.view(today).matchesEnded).toBe(0);
    // Relógio voltou para ontem: o dia passa a ser ontem.
    expect(d.view(yesterday).day).toBe(dayKey(yesterday));
    d.onEvent({ id: 2, t: yesterday + 1000, type: 'match_end', data: { form: 'mare' } });
    expect(d.view(yesterday + 2000).matchesEnded).toBe(1);
  });
});

describe('agregados do dia com dados hostis', () => {
  it("formas 'constructor', 'toString', 'hasOwnProperty' são contadas como números", () => {
    const d = new DayAggregator();
    for (const form of ['constructor', 'toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      d.onEvent({ id: 1, t: Date.now(), type: 'match_end', data: { form, durationMs: 1000 } });
    }
    const w = d.view().winnersByForm;
    expect(w).toEqual({ constructor: 2, toString: 1, hasOwnProperty: 1 });
    const back = JSON.parse(JSON.stringify(d.stats));
    expect(Object.values(back.winnersByForm).every((v) => typeof v === 'number')).toBe(true);
  });

  it('sanitizeDayStats: tipos errados viram vazio', () => {
    const day = dayKey(Date.now());
    const s = sanitizeDayStats({ day, winnersByForm: null, matchesEnded: 'a', joins: -3, peakAt: 'x', totalDurationMs: Infinity });
    expect(s).toMatchObject({ day, winnersByForm: {}, matchesEnded: 0, joins: 0, peakAt: null, totalDurationMs: 0 });
    expect(sanitizeDayStats({ day, winnersByForm: { mare: '3', broto: 2, constructor: 'function' } })!.winnersByForm).toEqual({ broto: 2 });
    expect(sanitizeDayStats({ day: '../x' })).toBeNull();
    expect(sanitizeDayStats(null)).toBeNull();
  });

  it('state.json com JSON válido mas formato errado não quebra a coleta', async () => {
    const day = dayKey(Date.now());
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ v: 1, cursor: { nextSeq: 'a' }, public: { url: cfg.publicUrl, ok: 'sim', latencyMs: {} }, day: { day, winnersByForm: null, matchesEnded: 'a' } }),
    );
    const o = new Observer(cfg, { persist: false });
    await o.init();
    expect(o.collector.cursor.nextSeq).toBe(0);
    expect(o.pub.ok).toBeNull();
    game.emit('match_end', { room: 'A', winner: 'w', form: 'constructor', durationMs: 1000, humans: 1 });
    const added = await o.pollGame();
    expect(added.map((e) => e.type)).toEqual(['match_end']);
    expect(o.day.view().winnersByForm).toEqual({ constructor: 1 });
    expect(o.summary().today.matchesEnded).toBe(1);
  });
});

describe('coleta: histerese e ordem dos eventos', () => {
  it('um timeout isolado não gera queda; dois seguidos sim', async () => {
    const store = new EventStore(null);
    const col = new GameCollector({ gameUrl: game.url, internalToken: 'interno', timeoutMs: 200, addEvent: (e) => store.add(e) });
    await col.poll();
    expect(col.state.status).toBe('up');
    game.mode = 'hang';
    await col.poll();
    expect(col.state.status).toBe('up');
    expect(col.state.lastError).toBe('timeout');
    game.mode = 'ok';
    await col.poll();
    expect(col.state.failStreak).toBe(0);
    game.mode = 'hang';
    await col.poll();
    await col.poll();
    expect(col.state.status).toBe('down');
    expect(store.query({ types: ['down'] })).toHaveLength(1);
  });

  it('reinício registrado no horário em que o jogo subiu, antes dos eventos do processo novo', async () => {
    const store = new EventStore(null);
    let clock = Date.now();
    const col = new GameCollector({ gameUrl: game.url, internalToken: 'interno', timeoutMs: 300, addEvent: (e) => store.add(e), now: () => clock });
    await col.poll();
    const port = Number(new URL(game.url).port);
    await game.close();
    await col.poll();
    expect(col.state.status).toBe('down');
    game = await startFakeGame('interno', port);
    const startedAt = Date.now();
    game.stats.startedAt = startedAt;
    game.emit('join', { name: 'Tatu', mode: 'quick', room: 'ABCD', country: 'BR', device: 'mobile' }, startedAt + 500);
    // O observador só percebe 2 s depois.
    clock = startedAt + 2_000;
    const first = await col.poll();
    expect(first.map((e) => e.type)).toEqual(['restart', 'up']);
    expect(first.every((e) => e.t === startedAt)).toBe(true);
    const next = await col.poll();
    expect(next.map((e) => e.type)).toEqual(['join']);
    expect(next[0].t).toBeGreaterThanOrEqual(first[0].t);
  });

  it('o túnel é rechecado na hora quando o jogo cai', async () => {
    cfg.intervals = { poll: 1e9, sample: 1e9, services: 1e9, publicCheck: 1e9, persist: 1e9 };
    const o = new Observer(cfg, { persist: false });
    await o.init();
    o.start();
    try {
      const deadline = Date.now() + 3_000;
      while ((o.pub.ok !== true || o.collector.state.status !== 'up') && Date.now() < deadline) await sleep(20);
      expect(o.pub.ok).toBe(true);
      const firstCheck = o.pub.checkedAt;
      await game.close();
      await sleep(5);
      await o.pollGame();
      expect(o.collector.state.status).toBe('down');
      while (o.pub.ok !== false && Date.now() < deadline + 3_000) await sleep(20);
      expect(o.pub.ok).toBe(false);
      expect(o.pub.checkedAt).toBeGreaterThanOrEqual(firstCheck!);
    } finally {
      await o.stop();
    }
  });
});

describe('gravação atômica', () => {
  it('não deixa .tmp para trás, nem quando falha', async () => {
    const f = join(dir, 'x.json');
    await writeAtomic(f, '{"a":1}');
    expect(readFileSync(f, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    await expect(writeAtomic(join(dir, 'nao-existe', 'y.json'), 'z')).rejects.toThrow();
    expect(existsSync(join(dir, 'nao-existe'))).toBe(false);
  });
});

describe('painel: rótulos só por chaves próprias', () => {
  it("forma 'constructor' e tipos desconhecidos aparecem como texto cru, nunca como função", async () => {
    class T {
      constructor(readonly data: string) {}
      get textContent() {
        return this.data;
      }
    }
    class E {
      className = '';
      title = '';
      kids: (E | T)[] = [];
      constructor(readonly tagName: string) {}
      append(...n: (E | T)[]) {
        this.kids.push(...n);
      }
      get textContent(): string {
        return this.kids.map((c) => c.textContent).join('');
      }
    }
    const g = globalThis as unknown as { document?: unknown };
    const prev = g.document;
    g.document = { createElement: (t: string) => new E(t), createTextNode: (s: string) => new T(s) };
    try {
      const view = await import(/* @vite-ignore */ pathToFileURL(resolve('observer/public/view.js')).href);
      expect(view.lookup(view.FORM_NAMES, 'constructor')).toBeUndefined();
      expect(view.lookup(view.FORM_NAMES, 'mare')).toBe('Maré');
      const end = view.feedItem({ id: 1, t: Date.now(), type: 'match_end', data: { room: 'A', winner: 'w', form: 'constructor', durationMs: 1000, humans: 1 } }, false) as E;
      expect(end.textContent).toContain('venceu como constructor');
      expect(end.textContent).not.toContain('function');
      const join1 = view.feedItem({ id: 2, t: Date.now(), type: 'join', data: { name: 'a', mode: 'publica', room: 'R', country: 'BR', device: 'mobile' } }, false) as E;
      expect(join1.textContent).toContain('(pública)');
      const sec = view.feedItem({ id: 3, t: Date.now(), type: 'security', data: { kind: 'too_many_conns', ipHash: 'ab12', detail: 'x' } }, false) as E;
      expect(sec.textContent).toContain('conexões demais');
      const weird = view.feedItem({ id: 4, t: Date.now(), type: 'security', data: { kind: 'toString', ipHash: 'ab12', detail: 'x' } }, false) as E;
      expect(weird.textContent).toContain('toString');
      expect(weird.textContent).not.toContain('function');
    } finally {
      g.document = prev;
    }
  });
});
