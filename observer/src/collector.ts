// Coleta do contrato do jogo (GET /internal/stats?since=<seq>): estado up/down, reinícios e eventos novos.
import {
  OBS_EVENT_TYPES,
  OBS_STATS_PATH,
  OBS_TOKEN_HEADER,
  type ObsEventType,
  type ObsQuantiles,
  type ObsRoom,
  type ObsStats,
} from '../../shared/src/obs';
import { HttpGetError, httpGet } from './httpget';
import { sanitizeData, type StoredEvent } from './events';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown, max = 64): string => (typeof v === 'string' ? v.slice(0, max) : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const quant = (v: unknown): ObsQuantiles => {
  const o = obj(v);
  return { p50: num(o.p50), p99: num(o.p99), max: num(o.max) };
};
const counts = (v: unknown, maxKeys: number): Record<string, number> => {
  const out: Record<string, number> = {};
  let n = 0;
  for (const [k, c] of Object.entries(obj(v))) {
    if (n >= maxKeys) break;
    if (k === '__proto__' || k.length > 32) continue;
    out[k] = num(c);
    n++;
  }
  return out;
};

/**
 * Valida e normaliza a resposta do jogo: campos ausentes viram zero, textos são cortados,
 * listas limitadas. O painel nunca recebe nada fora do formato esperado.
 */
export function normalizeStats(raw: unknown): ObsStats {
  const r = obj(raw);
  if (typeof r.startedAt !== 'number' || typeof r.nextSeq !== 'number') throw new Error('resposta fora do contrato (startedAt/nextSeq)');
  const p = obj(r.process);
  const c = obj(r.connections);
  const pl = obj(r.players);
  const ct = obj(r.counters);
  const b = obj(ct.battles);
  const bd = obj(r.breakdown);
  const dev = obj(bd.devices);
  const rooms: ObsRoom[] = (Array.isArray(r.rooms) ? r.rooms : []).slice(0, 200).map((x) => {
    const o = obj(x);
    const state = o.state === 'play' || o.state === 'fim' ? o.state : 'lobby';
    return {
      code: str(o.code, 16),
      private: o.private === true,
      state,
      humans: num(o.humans),
      bots: num(o.bots),
      alive: num(o.alive),
      phase: str(o.phase, 24),
      elapsedMs: num(o.elapsedMs),
    };
  });
  const events = (Array.isArray(r.events) ? r.events : [])
    .slice(-2_000)
    .map((x) => obj(x))
    .filter((e) => typeof e.seq === 'number' && (OBS_EVENT_TYPES as readonly unknown[]).includes(e.type))
    .map((e) => ({ seq: num(e.seq), t: num(e.t) || Date.now(), type: e.type as ObsEventType, data: sanitizeData(e.data) }));
  return {
    now: num(r.now),
    startedAt: num(r.startedAt),
    version: str(r.version, 40),
    process: {
      rssMB: num(p.rssMB),
      heapUsedMB: num(p.heapUsedMB),
      cpuPct: num(p.cpuPct),
      eventLoopLagMs: quant(p.eventLoopLagMs),
      tickMs: quant(p.tickMs),
    },
    connections: { open: num(c.open), total: num(c.total) },
    players: { online: num(pl.online), lobby: num(pl.lobby), playing: num(pl.playing), spectating: num(pl.spectating) },
    rooms,
    counters: {
      joins: num(ct.joins),
      matchesStarted: num(ct.matchesStarted),
      matchesEnded: num(ct.matchesEnded),
      battles: { wild: num(b.wild), pvp: num(b.pvp), final: num(b.final) },
      eliminations: num(ct.eliminations),
      rateLimited: num(ct.rateLimited),
      rejectedConnections: num(ct.rejectedConnections),
      originRejected: num(ct.originRejected),
      errors: num(ct.errors),
    },
    breakdown: {
      countries: counts(bd.countries, 64),
      devices: { mobile: num(dev.mobile), desktop: num(dev.desktop) },
    },
    events,
    nextSeq: num(r.nextSeq),
  };
}

export type GameStatus = 'unknown' | 'up' | 'down';

/** Estado persistido entre reinícios do observador (para não duplicar eventos). */
export interface CollectorCursor {
  startedAt: number | null;
  nextSeq: number;
}

export interface CollectorState {
  status: GameStatus;
  /** Desde quando está no estado atual. */
  since: number;
  lastOkAt: number | null;
  lastError: string | null;
  lastPollMs: number | null;
  stats: ObsStats | null;
  statsAt: number | null;
  restarts: number;
  /** Falhas seguidas (para a histerese de "fora do ar"). */
  failStreak: number;
}

type AddEvent = (e: Omit<StoredEvent, 'id'>) => StoredEvent;

export interface CollectorOptions {
  gameUrl: string;
  internalToken: string;
  timeoutMs: number;
  addEvent: AddEvent;
  now?: () => number;
  cursor?: CollectorCursor | null;
  /**
   * Falhas seguidas para passar de "no ar" a "fora do ar" (padrão 2: um timeout isolado não gera
   * queda). Conexão recusada derruba na hora: o processo não está escutando.
   */
  downAfter?: number;
}

export class GameCollector {
  state: CollectorState;
  cursor: CollectorCursor;
  private inFlight = false;
  private readonly now: () => number;
  /** Eventos registrados na consulta em andamento (inclusive os sintéticos down/up/restart). */
  private batch: StoredEvent[] = [];

  constructor(private readonly opts: CollectorOptions) {
    this.now = opts.now ?? Date.now;
    this.cursor = opts.cursor ? { ...opts.cursor } : { startedAt: null, nextSeq: 0 };
    this.state = {
      status: 'unknown',
      since: this.now(),
      lastOkAt: null,
      lastError: null,
      lastPollMs: null,
      stats: null,
      statsAt: null,
      restarts: 0,
      failStreak: 0,
    };
  }

  /** Estatísticas só valem se forem recentes (senão, o jogo está fora e os números são velhos). */
  fresh(maxAgeMs = 6_000): ObsStats | null {
    const s = this.state;
    return s.status === 'up' && s.stats && s.statsAt !== null && this.now() - s.statsAt <= maxAgeMs ? s.stats : null;
  }

  /** `at`: quando a mudança de fato aconteceu (por padrão, agora). */
  private setStatus(status: GameStatus, reason: string | null, at = this.now()): void {
    const s = this.state;
    if (s.status === status) return;
    const prev = s.status;
    const prevSince = s.since;
    const t = Math.max(prevSince, Math.min(at, this.now()));
    s.status = status;
    s.since = t;
    if (status === 'down') {
      this.record({ t, type: 'down', data: { reason: reason ?? 'desconhecido', wasUp: prev === 'up' } });
    } else if (status === 'up' && prev === 'down') {
      this.record({ t, type: 'up', data: { downMs: t - prevSince } });
    }
  }

  private record(e: Omit<StoredEvent, 'id'>): void {
    this.batch.push(this.opts.addEvent(e));
  }

  /** Uma consulta. Retorna os eventos novos registrados. */
  async poll(): Promise<StoredEvent[]> {
    if (this.inFlight) return [];
    this.inFlight = true;
    const added: StoredEvent[] = [];
    this.batch = added;
    try {
      const url = `${this.opts.gameUrl}${OBS_STATS_PATH}?since=${this.cursor.nextSeq}`;
      let res;
      try {
        res = await httpGet(url, {
          timeoutMs: this.opts.timeoutMs,
          headers: { [OBS_TOKEN_HEADER]: this.opts.internalToken, accept: 'application/json' },
        });
      } catch (err) {
        const code = err instanceof HttpGetError ? err.code : 'EIO';
        this.fail(code === 'ECONNREFUSED' ? 'conexão recusada' : code === 'ETIMEDOUT' ? 'timeout' : (err as Error).message, code === 'ECONNREFUSED');
        return added;
      }
      this.state.lastPollMs = Math.round(res.ms);
      if (res.status === 401 || res.status === 403) {
        this.fail(`HTTP ${res.status}: OBS_INTERNAL_TOKEN recusado`, true);
        return added;
      }
      if (res.status !== 200) {
        this.fail(`HTTP ${res.status}`);
        return added;
      }
      let stats: ObsStats;
      try {
        stats = normalizeStats(JSON.parse(res.body));
      } catch (err) {
        this.fail(`resposta inválida: ${(err as Error).message}`.slice(0, 120));
        return added;
      }
      const t = this.now();
      const add = (e: Omit<StoredEvent, 'id'>) => this.record(e);

      // Reinício: startedAt mudou (ou a sequência voltou para trás).
      const restarted =
        (this.cursor.startedAt !== null && stats.startedAt !== this.cursor.startedAt) || stats.nextSeq < this.cursor.nextSeq;
      if (restarted) {
        this.state.restarts++;
        // O reinício aconteceu em startedAt (não quando foi percebido): assim o feed fica em ordem
        // cronológica com os eventos do processo novo, que têm t >= startedAt.
        const at = Math.min(t, Math.max(stats.startedAt, this.state.since));
        add({
          t: at,
          type: 'restart',
          data: {
            previousStartedAt: this.cursor.startedAt,
            startedAt: stats.startedAt,
            version: stats.version,
          },
        });
        this.cursor = { startedAt: stats.startedAt, nextSeq: 0 };
        // Os eventos desta resposta foram pedidos com o since antigo: busca de novo do zero já na próxima.
        this.markUp(stats, t, at);
        return added;
      }
      this.cursor.startedAt = stats.startedAt;
      for (const e of stats.events) {
        if (e.seq < this.cursor.nextSeq) continue;
        add({ t: e.t, type: e.type, seq: e.seq, data: e.data });
      }
      this.cursor.nextSeq = Math.max(this.cursor.nextSeq, stats.nextSeq);
      this.markUp(stats, t);
      return added;
    } finally {
      this.inFlight = false;
      this.batch = [];
    }
  }

  private markUp(stats: ObsStats, t: number, upAt = t): void {
    this.setStatus('up', null, upAt);
    this.state.stats = { ...stats, events: [] };
    this.state.statsAt = t;
    this.state.lastOkAt = t;
    this.state.lastError = null;
    this.state.failStreak = 0;
  }

  /** `now`: derruba sem esperar a segunda falha (processo não escuta, token recusado). */
  private fail(reason: string, immediate = false): void {
    const s = this.state;
    s.lastError = reason;
    s.failStreak++;
    if (s.status === 'up' && !immediate && s.failStreak < (this.opts.downAfter ?? 2)) return;
    this.setStatus('down', reason);
  }
}
