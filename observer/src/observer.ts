// Orquestra coletas, séries, eventos, agregados e persistência.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObsStats } from '../../shared/src/obs';
import { GameCollector, type CollectorCursor } from './collector';
import type { ObsConfig } from './config';
import { DayAggregator, type DayStats } from './daystats';
import { EventStore, type StoredEvent } from './events';
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

async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
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

  constructor(
    readonly cfg: ObsConfig,
    opts: { now?: () => number; persist?: boolean } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    const persist = opts.persist ?? true;
    this.events = new EventStore(persist ? cfg.dataDir : null);
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
      this.series = RingSeries.deserialize(buf, this.series.capacity, SERIES_FIELDS, now - this.cfg.seriesWindowMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[obs] séries não restauradas:', (err as Error).message);
    }
    let saved: SavedState | null = null;
    try {
      saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as SavedState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[obs] estado não restaurado:', (err as Error).message);
    }
    const restored = await this.events.restore(now);
    if (saved?.v === 1) {
      if (saved.cursor && typeof saved.cursor.nextSeq === 'number') this.collector.cursor = { ...saved.cursor };
      if (saved.public?.url === this.cfg.publicUrl) this.pub = { ...emptyPublicCheck(this.cfg.publicUrl), ...saved.public };
      this.day = new DayAggregator(now, saved.day);
    }
    if (!saved || saved.day?.day !== this.day.stats.day) {
      // Sem agregados salvos para hoje: refaz a partir dos eventos de hoje e do pico nas séries.
      this.day = new DayAggregator(now);
      for (const e of restored) this.day.onEvent(e);
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const peak = this.series.max('online', midnight.getTime());
      if (peak !== null) this.day.onOnline(now, peak);
    }
    await this.events.prune(this.cfg.keepDays, now);
  }

  start(): void {
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
    this.timers.forEach(clearInterval);
    this.timers = [];
    await this.persist();
  }

  async pollGame(): Promise<StoredEvent[]> {
    const added = await this.collector.poll();
    for (const e of added) this.day.onEvent(e);
    const stats = this.collector.fresh();
    if (stats) this.day.onOnline(this.now(), stats.players.online);
    if (added.length) void this.events.flush();
    if (this.listeners.size) {
      const payload = { summary: this.summary(), events: added };
      for (const fn of this.listeners) {
        try {
          fn(payload);
        } catch {
          // um cliente SSE com problema não derruba os outros
        }
      }
    }
    return added;
  }

  async sample(): Promise<SeriesSample> {
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
    this.series.push(this.now(), sample);
    return sample;
  }

  async refreshServices(): Promise<void> {
    this.services = await readServices(this.cfg.serviceDir);
    this.servicesAt = this.now();
  }

  async refreshPublic(): Promise<void> {
    this.pub = await checkPublic(this.pub, this.cfg.publicTimeoutMs, this.now());
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
        cpuPct: this.phone?.self.cpuPct ?? null,
        sseClients: this.listeners.size,
        seriesPoints: this.series.size,
      },
    };
  }
}

export type Summary = ReturnType<Observer['summary']>;
