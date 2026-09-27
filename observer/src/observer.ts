// Orquestra coletas, séries, eventos, agregados e persistência.
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObsStats } from '../../shared/src/obs';
import { GameCollector, type CollectorCursor, type GameStatus } from './collector';
import type { ObsConfig } from './config';
import { DayAggregator, sanitizeDayStats, type DayStats } from './daystats';
import { EventStore, dayKey, forEachInDay, type StoredEvent } from './events';
import { writeAtomic } from './fsutil';
import { PhoneReader, type PhoneMetrics } from './phone';
import { checkPublic, emptyPublicCheck, type PublicCheck } from './publiccheck';
import { readServices, type ServiceStatus } from './services';
import { RingSeries, SERIES_FIELDS, type SeriesSample } from './series';

interface SavedState {
  v: 1;
  savedAt: number;
  cursor: CollectorCursor;
  day: DayStats;
  public: PublicCheck;
}

export type TickListener = (payload: { summary: Summary; events: StoredEvent[] }) => void;

/** Salas "ativas": com pelo menos um humano. */
export function activeRooms(stats: ObsStats | null): number | null {
  return stats ? stats.rooms.filter((r) => r.humans > 0).length : null;
}

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Cursor salvo, validado (null se não servir). */
function sanitizeCursor(v: unknown): CollectorCursor | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  const nextSeq = finiteOrNull(c.nextSeq);
  if (nextSeq === null || nextSeq < 0) return null;
  return { startedAt: finiteOrNull(c.startedAt), nextSeq: Math.floor(nextSeq) };
}

/** Última checagem pública salva, validada campo a campo. */
function sanitizePublic(v: unknown, url: string): PublicCheck | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (p.url !== url) return null;
  return {
    url,
    ok: typeof p.ok === 'boolean' ? p.ok : null,
    status: finiteOrNull(p.status),
    latencyMs: finiteOrNull(p.latencyMs),
    checkedAt: finiteOrNull(p.checkedAt),
    lastOkAt: finiteOrNull(p.lastOkAt),
    error: typeof p.error === 'string' ? p.error.slice(0, 120) : null,
    consecutiveFailures: Math.max(0, finiteOrNull(p.consecutiveFailures) ?? 0),
  };
}

export class Observer {
  readonly events: EventStore;
  readonly collector: GameCollector;
  series: RingSeries;
  day: DayAggregator;
  phone: PhoneMetrics | null = null;
  services: ServiceStatus[] | null = null;
  servicesAt: number | null = null;
  pub: PublicCheck;
  readonly startedAt: number;
  private readonly phoneReader: PhoneReader;
  private readonly listeners = new Set<TickListener>();
  private timers: NodeJS.Timeout[] = [];
  private readonly now: () => number;
  private running = false;
  private sampling: Promise<SeriesSample> | null = null;
  private publicChecking: Promise<void> | null = null;

  constructor(
    readonly cfg: ObsConfig,
    opts: { now?: () => number; persist?: boolean } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    const persist = opts.persist ?? true;
    this.events = new EventStore(persist ? cfg.dataDir : null, { maxDayBytes: cfg.maxDayBytes });
    this.collector = new GameCollector({
      gameUrl: cfg.gameUrl,
      internalToken: cfg.internalToken,
      timeoutMs: cfg.pollTimeoutMs,
      addEvent: (e) => this.events.add(e),
      now: this.now,
    });
    this.series = new RingSeries(Math.ceil(cfg.seriesWindowMs / cfg.intervals.sample));
    this.day = new DayAggregator(this.now());
    this.pub = emptyPublicCheck(cfg.publicUrl);
    this.phoneReader = new PhoneReader({ procRoot: cfg.procRoot, sysRoot: cfg.sysRoot, diskPath: cfg.dataDir });
  }

  get sseClients(): number {
    return this.listeners.size;
  }

  onTick(fn: TickListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Restaura séries, cursor, agregados e o fim do feed de eventos; apaga NDJSON antigos. */
  async init(): Promise<void> {
    const dir = this.cfg.dataDir;
    await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
    const now = this.now();
    try {
      const buf = await readFile(join(dir, 'series.bin'));
      // Amostras "do futuro" (relógio que tinha saltado para frente) ficam de fora.
      this.series = RingSeries.deserialize(buf, this.series.capacity, SERIES_FIELDS, now - this.cfg.seriesWindowMs, now + 60_000);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[obs] séries não restauradas:', (err as Error).message);
    }
    let saved: Partial<SavedState> | null = null;
    try {
      const raw: unknown = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
      if (raw && typeof raw === 'object' && (raw as SavedState).v === 1) saved = raw as Partial<SavedState>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[obs] estado não restaurado:', (err as Error).message);
    }
    await this.events.restore(now);
    let dayRestored = false;
    if (saved) {
      const cursor = sanitizeCursor(saved.cursor);
      if (cursor) this.collector.cursor = cursor;
      const pub = sanitizePublic(saved.public, this.cfg.publicUrl);
      if (pub) this.pub = pub;
      // Formato validado campo a campo: um state.json com tipos errados não quebra a coleta.
      dayRestored = sanitizeDayStats(saved.day)?.day === dayKey(now);
      if (dayRestored) this.day = new DayAggregator(now, saved.day);
    }
    if (!dayRestored) {
      // Sem agregados salvos para hoje: refaz a partir do arquivo de hoje (lido em fluxo, linha a
      // linha, para não carregar um arquivo grande inteiro) e do pico nas séries.
      this.day = new DayAggregator(now);
      await forEachInDay(dir, dayKey(now), (e) => this.day.onEvent(e));
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const peak = this.series.max('online', midnight.getTime());
      if (peak !== null) this.day.onOnline(now, peak);
    }
    await this.events.prune(this.cfg.keepDays, now);
  }

  start(): void {
    this.running = true;
    const iv = this.cfg.intervals;
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const run = () => fn().catch((err) => console.error('[obs]', (err as Error).message));
      void run();
      this.timers.push(setInterval(run, ms));
    };
    every(iv.poll, () => this.pollGame());
    every(iv.sample, () => this.sample());
    every(iv.services, () => this.refreshServices());
    every(iv.publicCheck, () => this.refreshPublic());
    this.timers.push(setInterval(() => void this.persist(), iv.persist));
    this.timers.push(setInterval(() => void this.events.prune(this.cfg.keepDays, this.now()), 3600_000));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    await this.persist();
  }

  async pollGame(): Promise<StoredEvent[]> {
    const before: GameStatus = this.collector.state.status;
    const added = await this.collector.poll();
    for (const e of added) this.day.onEvent(e);
    const stats = this.collector.fresh();
    if (stats) this.day.onOnline(this.now(), stats.players.online);
    if (added.length) void this.events.flush();
    // O /health público passa pelo jogo: quando o jogo cai ou volta, a última checagem do túnel
    // fica velha. Refaz na hora em vez de esperar até 60 s.
    const after = this.collector.state.status;
    if (this.running && before !== after && before !== 'unknown') void this.refreshPublic().catch(() => {});
    this.broadcast({ summary: this.summary(), events: added });
    return added;
  }

  /** Entrega um tick aos painéis conectados (SSE). */
  broadcast(payload: Parameters<TickListener>[0]): void {
    for (const fn of this.listeners) {
      try {
        fn(payload);
      } catch {
        // um cliente SSE com problema não derruba os outros
      }
    }
  }

  /** Uma amostra por vez: se a leitura de /proc e /sys demorar, a próxima chamada reaproveita a em andamento. */
  sample(): Promise<SeriesSample> {
    if (!this.sampling) {
      this.sampling = this.doSample().finally(() => {
        this.sampling = null;
      });
    }
    return this.sampling;
  }

  private async doSample(): Promise<SeriesSample> {
    this.phone = await this.phoneReader.read();
    const s = this.collector.fresh();
    const p = this.phone;
    const sample: SeriesSample = {
      online: s?.players.online ?? null,
      playing: s?.players.playing ?? null,
      lobby: s?.players.lobby ?? null,
      rooms: activeRooms(s),
      conns: s?.connections.open ?? null,
      gameRssMB: s?.process.rssMB ?? null,
      gameCpuPct: s?.process.cpuPct ?? null,
      lagP99: s?.process.eventLoopLagMs.p99 ?? null,
      tickP99: s?.process.tickMs.p99 ?? null,
      load1: p.load?.[0] ?? null,
      memFreeMB: p.mem?.availableMB ?? null,
      tempC: p.tempC ?? p.battery?.tempC ?? null,
      battery: p.battery?.capacity ?? null,
    };
    const dropped = this.series.push(this.now(), sample);
    if (dropped) console.error(`[obs] relógio voltou: ${dropped} amostra(s) com horário posterior descartada(s)`);
    return sample;
  }

  async refreshServices(): Promise<void> {
    this.services = await readServices(this.cfg.serviceDir);
    this.servicesAt = this.now();
  }

  refreshPublic(): Promise<void> {
    if (!this.publicChecking) {
      this.publicChecking = checkPublic(this.pub, this.cfg.publicTimeoutMs, this.now())
        .then((r) => {
          this.pub = r;
        })
        .finally(() => {
          this.publicChecking = null;
        });
    }
    return this.publicChecking;
  }

  async persist(): Promise<void> {
    const dir = this.cfg.dataDir;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeAtomic(join(dir, 'series.bin'), this.series.serialize());
      const state: SavedState = { v: 1, savedAt: this.now(), cursor: this.collector.cursor, day: this.day.stats, public: this.pub };
      await writeAtomic(join(dir, 'state.json'), JSON.stringify(state));
      await this.events.flush();
    } catch (err) {
      console.error('[obs] falha ao salvar:', (err as Error).message);
    }
  }

  /** Tudo o que o painel mostra (exceto séries e feed completo). */
  summary() {
    const now = this.now();
    const st = this.collector.state;
    const stats = this.collector.fresh();
    const mem = process.memoryUsage();
    return {
      now,
      game: {
        status: st.status,
        since: st.since,
        forMs: now - st.since,
        lastOkAt: st.lastOkAt,
        lastError: st.lastError,
        pollMs: st.lastPollMs,
        version: stats?.version ?? st.stats?.version ?? null,
        startedAt: stats?.startedAt ?? null,
        uptimeMs: stats ? Math.max(0, stats.now - stats.startedAt) : null,
        restarts: st.restarts,
      },
      stats: stats
        ? {
            players: stats.players,
            connections: stats.connections,
            process: stats.process,
            rooms: stats.rooms,
            activeRooms: activeRooms(stats),
            counters: stats.counters,
            breakdown: stats.breakdown,
          }
        : null,
      phone: this.phone,
      services: this.services,
      servicesAt: this.servicesAt,
      public: this.pub,
      today: this.day.view(now),
      observer: {
        uptimeMs: now - this.startedAt,
        rssMB: Math.round((mem.rss / 1048576) * 10) / 10,
        privateMB: this.phone?.self.privateMB ?? null,
        pssMB: this.phone?.self.pssMB ?? null,
        cpuPct: this.phone?.self.cpuPct ?? null,
        sseClients: this.listeners.size,
        seriesPoints: this.series.size,
      },
    };
  }
}

export type Summary = ReturnType<Observer['summary']>;
