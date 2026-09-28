// Lado do jogo do contrato de observabilidade (shared/src/obs.ts): contadores, eventos e amostras
// do processo, lidos pelo endpoint interno (internal.ts) a cada poucos segundos.
//
// Custo: os ganchos só rodam em momentos raros (entrada, início/fim de partida, batalha, eliminação);
// no tick há apenas duas leituras de relógio e uma escrita num Float64Array (tickDone). Tudo o que
// agrega (salas, jogadores, países, quantis) é calculado sob demanda em snapshot().
import { readFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { monitorEventLoopDelay, type ELDHistogram } from 'node:perf_hooks';
import {
  BALANCE,
  type ObsCounters,
  type ObsDevice,
  type ObsEvent,
  type ObsEventDataMap,
  type ObsEventType,
  type ObsEventValue,
  type ObsQuantiles,
  type ObsRoom,
  type ObsStats,
} from '@vb/shared';
import type { Battle, Conn, Player } from './entities';
import type { LobbyHooks } from './hooks';
import type { Member, Room } from './room';
import { TokenBucket, type SecKind, type SecuritySummary } from './security';

/** Versão gravada no build (scripts/build-server.mjs); ausente no tsx. */
declare const __VB_VERSION__: string | undefined;

/** VB_VERSION do ambiente, senão a do build, senão a do package.json da raiz. */
export function resolveVersion(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.VB_VERSION?.trim();
  if (fromEnv) return fromEnv.slice(0, 40);
  if (typeof __VB_VERSION__ === 'string' && __VB_VERSION__) return __VB_VERSION__.slice(0, 40);
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version.slice(0, 40);
  } catch {
    // sem package.json por perto (bundle fora do repositório)
  }
  return '0.0.0';
}

export interface ConnMeta {
  country: string;
  device: ObsDevice;
}

const MOBILE_UA = /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile|Silk|KaiOS/i;

/** Celular ou computador pelo User-Agent (heurística; iPadOS que se diz Mac conta como computador). */
export function deviceOf(ua: unknown): ObsDevice {
  return typeof ua === 'string' && MOBILE_UA.test(ua.slice(0, 512)) ? 'mobile' : 'desktop';
}

/**
 * País do CF-IPCountry, só quando a conexão veio do túnel (loopback com CF-Connecting-IP, ver clientId):
 * fora disso o cabeçalho é do próprio cliente e vale 'XX'.
 */
export function countryOf(viaCloudflare: boolean, headers: IncomingHttpHeaders): string {
  if (!viaCloudflare) return 'XX';
  const raw = headers['cf-ipcountry'];
  if (typeof raw !== 'string') return 'XX';
  const c = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]$/.test(c) ? c : 'XX';
}

export function connMeta(viaCloudflare: boolean, headers: IncomingHttpHeaders): ConnMeta {
  return { country: countryOf(viaCloudflare, headers), device: deviceOf(headers['user-agent']) };
}

/** Rótulo curto da saída a partir do código de fechamento do WebSocket. */
export function leaveReason(code: number): string {
  switch (code) {
    case 1000:
    case 1001:
    case 1005:
      return 'fechou';
    case 1006:
      return 'caiu';
    case 1008:
      return 'abuso';
    case 1009:
      return 'mensagem grande';
    case 1011:
      return 'erro';
    case 1012:
      return 'reinício';
    case 4001:
      return 'sem hello';
    case 4002:
      return 'ocioso';
    case 4003:
      return 'parado';
    case 4029:
      return 'conexões demais';
    default:
      return 'desconectou';
  }
}

const round = (v: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const ZERO_Q: ObsQuantiles = { p50: 0, p99: 0, max: 0 };

/** Janela circular de amostras (sem alocação por amostra) com quantis sob demanda. */
export class SampleWindow {
  private readonly buf: Float64Array;
  private readonly scratch: Float64Array;
  private n = 0;
  private i = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  push(v: number): void {
    this.buf[this.i] = v;
    this.i = this.i + 1 === this.capacity ? 0 : this.i + 1;
    if (this.n < this.capacity) this.n++;
  }

  get size(): number {
    return this.n;
  }

  quantiles(digits = 3): ObsQuantiles {
    if (this.n === 0) return { ...ZERO_Q };
    const s = this.scratch.subarray(0, this.n);
    s.set(this.buf.subarray(0, this.n));
    s.sort();
    const at = (p: number) => s[Math.min(this.n - 1, Math.max(0, Math.ceil(p * this.n) - 1))];
    return { p50: round(at(0.5), digits), p99: round(at(0.99), digits), max: round(s[this.n - 1], digits) };
  }
}

/** Fonte do estado agregado no momento da coleta. */
export interface StatsSource {
  rooms: Iterable<Room>;
  openConns: number;
  security: Pick<SecuritySummary, 'rateLimited' | 'rejectedConnections' | 'originRejected'>;
}

export interface MetricsOptions {
  now?: () => number;
  version?: string;
  /** Eventos guardados para o observador (buffer circular). */
  eventCapacity?: number;
  /** Ticks na janela dos quantis de tickMs (padrão: 30 s de ticks). */
  tickWindow?: number;
  /** Janela do lag do event loop: o histograma é zerado depois dela (ms). */
  lagWindowMs?: number;
  /** Eventos de segurança aceitos no buffer: rajada e recarga por segundo (os contadores contam todos). */
  securityEvents?: { capacity: number; refillPerSec: number };
  /** Idem para eventos de erro (um erro repetido a cada tick não pode expulsar o resto do buffer). */
  errorEvents?: { capacity: number; refillPerSec: number };
}

/** SecKinds que são falhas do próprio servidor: viram 'error' (contados em errors), não 'security'. */
const ERROR_KINDS: ReadonlySet<SecKind> = new Set<SecKind>(['timer_error', 'handle_error']);

type MutableCounters = Omit<ObsCounters, 'rateLimited' | 'rejectedConnections' | 'originRejected'>;

/**
 * Coletor do jogo. Implementa os ganchos do Lobby/Room; nenhum método de gancho lança (um erro aqui
 * não pode derrubar o tick de uma sala), falhas internas só incrementam `internalErrors`.
 */
export class GameMetrics implements LobbyHooks {
  readonly startedAt: number;
  readonly version: string;
  readonly eventCapacity: number;
  /** Falhas dentro do próprio coletor (diagnóstico; fora do contrato). */
  internalErrors = 0;
  /** Eventos de segurança que não entraram no buffer por excesso (os contadores contam todos). */
  securityDropped = 0;
  /** Eventos de erro que não entraram no buffer por excesso (counters.errors conta todos). */
  errorsDropped = 0;

  private readonly now: () => number;
  private readonly counters: MutableCounters = {
    joins: 0,
    matchesStarted: 0,
    matchesEnded: 0,
    battles: { wild: 0, pvp: 0, final: 0 },
    eliminations: 0,
    errors: 0,
  };
  private totalConns = 0;
  private readonly ring: (ObsEvent | undefined)[];
  private seq = 0;
  private readonly conns = new WeakMap<Conn, ConnMeta>();
  private readonly roomCreatedAt = new WeakMap<Room, number>();
  private readonly humansAtStart = new WeakMap<Room, number>();
  private readonly ended = new WeakSet<Room>();
  private readonly ticks: SampleWindow;
  private readonly secBucket: TokenBucket;
  private readonly errBucket: TokenBucket;
  private loop: ELDHistogram | null = null;
  private loopResolutionMs = 50;
  private readonly lagWindowMs: number;
  private lagWindowStart = 0;
  private lastLag: ObsQuantiles = { ...ZERO_Q };
  private cpuPrev = process.cpuUsage();
  private cpuPrevAt = performance.now();
  private cpuPct = 0;

  constructor(o: MetricsOptions = {}) {
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
    this.version = o.version ?? resolveVersion();
    this.eventCapacity = Math.max(1, Math.floor(o.eventCapacity ?? 2_000));
    this.ring = new Array<ObsEvent | undefined>(this.eventCapacity);
    this.ticks = new SampleWindow(Math.max(1, o.tickWindow ?? Math.round(30_000 / BALANCE.tickMs)));
    this.lagWindowMs = o.lagWindowMs ?? 10_000;
    const se = o.securityEvents ?? { capacity: 30, refillPerSec: 0.5 };
    this.secBucket = new TokenBucket(se.capacity, se.refillPerSec, this.startedAt);
    const ee = o.errorEvents ?? { capacity: 20, refillPerSec: 0.2 };
    this.errBucket = new TokenBucket(ee.capacity, ee.refillPerSec, this.startedAt);
  }

  // ---------------------------------------------------------------- eventos

  emit<T extends ObsEventType>(type: T, data: ObsEventDataMap[T]): ObsEvent {
    const e: ObsEvent = { seq: this.seq, t: this.now(), type, data: data as unknown as Record<string, ObsEventValue> };
    this.ring[this.seq % this.eventCapacity] = e;
    this.seq++;
    return e;
  }

  /** Próximo seq (o que o observador manda em ?since= depois de ler tudo). */
  get nextSeq(): number {
    return this.seq;
  }

  /** Eventos com seq >= since que ainda estão no buffer, em ordem. */
  eventsSince(since: number): ObsEvent[] {
    const from = Math.max(0, Math.floor(since), this.seq - this.eventCapacity);
    const out: ObsEvent[] = [];
    for (let s = from; s < this.seq; s++) out.push(this.ring[s % this.eventCapacity]!);
    return out;
  }

  // ---------------------------------------------------------------- processo

  /**
   * Liga o monitor do event loop (só quando há quem leia: custa um timer interno). 50 ms basta para
   * ver travadas que importam num tick de 100 ms e acorda o processo 2,5x menos que 20 ms.
   */
  enableLoopMonitor(resolutionMs = 50): void {
    if (this.loop) return;
    this.loopResolutionMs = resolutionMs;
    this.loop = monitorEventLoopDelay({ resolution: resolutionMs });
    this.loop.enable();
    this.lagWindowStart = performance.now();
  }

  dispose(): void {
    this.loop?.disable();
    this.loop = null;
  }

  /** Duração de um lobby.tick (ms). Chamado a cada tick: sem alocação. */
  tickDone(ms: number): void {
    this.ticks.push(ms);
  }

  /** Atraso do event loop além da resolução do timer do monitor, na janela atual. */
  private eventLoopLag(): ObsQuantiles {
    const h = this.loop;
    if (!h || h.count === 0) return { ...this.lastLag };
    const res = this.loopResolutionMs * 1e6;
    const ms = (ns: number) => round(Math.max(0, (ns - res) / 1e6));
    const q: ObsQuantiles = { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) };
    const t = performance.now();
    if (t - this.lagWindowStart >= this.lagWindowMs) {
      h.reset();
      this.lagWindowStart = t;
    }
    this.lastLag = q;
    return { ...q };
  }

  /** CPU do processo (% de um núcleo) desde a amostra anterior (mínimo de 1 s entre amostras). */
  private cpu(): number {
    const t = performance.now();
    const dt = t - this.cpuPrevAt;
    if (dt >= 1000) {
      const u = process.cpuUsage(this.cpuPrev);
      this.cpuPct = round(((u.user + u.system) / 1000 / dt) * 100, 1);
      this.cpuPrev = process.cpuUsage();
      this.cpuPrevAt = t;
    }
    return this.cpuPct;
  }

  // ---------------------------------------------------------------- conexões e segurança

  /** Conexão WebSocket aceita (depois dos limites), com país e dispositivo já resolvidos. */
  connOpened(conn: Conn, meta: ConnMeta): void {
    this.totalConns++;
    this.conns.set(conn, meta);
  }

  /** Linha escrita pelo SecurityLog (já com o throttle por tipo e IP). `tag` é o ipTag, nunca o IP. */
  security(kind: SecKind, tag: string, detail?: string): void {
    try {
      if (ERROR_KINDS.has(kind)) return;
      if (!this.secBucket.take(this.now())) {
        this.securityDropped++;
        return;
      }
      this.emit('security', { kind, ipHash: tag, detail: detail === undefined ? '' : String(detail).slice(0, 60) });
    } catch {
      this.internalErrors++;
    }
  }

  error(where: string, err: unknown): void {
    try {
      this.counters.errors++;
      if (!this.errBucket.take(this.now())) {
        this.errorsDropped++;
        return;
      }
      const e = err as { name?: unknown; message?: unknown } | null;
      const name = typeof e?.name === 'string' ? e.name : 'Error';
      const msg = typeof e?.message === 'string' ? e.message : String(err);
      this.emit('error', { message: `${where}: ${name}: ${msg}`.replace(/\s+/g, ' ').slice(0, 160) });
    } catch {
      this.internalErrors++;
    }
  }

  // ---------------------------------------------------------------- ganchos do lobby e da sala

  roomCreated(room: Room, now: number): void {
    this.roomCreatedAt.set(room, now);
  }

  join(conn: Conn, member: Member, room: Room, mode: string): void {
    try {
      this.counters.joins++;
      const meta = this.conns.get(conn);
      this.emit('join', { name: member.name, mode, room: room.code, country: meta?.country ?? 'XX', device: meta?.device ?? 'desktop', gm: room.gm });
    } catch {
      this.internalErrors++;
    }
  }

  leave(member: Member, room: Room, reason: string): void {
    try {
      const inMatch = room.state === 'play' && member.player !== null && member.player.alive;
      this.emit('leave', { name: member.name, room: room.code, reason: reason.slice(0, 32), inMatch });
    } catch {
      this.internalErrors++;
    }
  }

  matchStart(room: Room): void {
    try {
      this.counters.matchesStarted++;
      const humans = room.members.size;
      const players = room.totalPlayers;
      this.humansAtStart.set(room, humans);
      this.emit('match_start', { room: room.code, humans, bots: Math.max(0, players - humans), players, gm: room.gm });
    } catch {
      this.internalErrors++;
    }
  }

  matchEnd(room: Room, winner: Player | null): void {
    try {
      if (this.ended.has(room)) return;
      this.ended.add(room);
      this.counters.matchesEnded++;
      const end = room.endedAt || this.now();
      this.emit('match_end', {
        room: room.code,
        winner: winner ? winner.name : null,
        form: winner ? room.look(winner).form : null,
        durationMs: Math.max(0, end - room.startedAt),
        humans: this.humansAtStart.get(room) ?? room.members.size,
        gm: room.gm,
      });
    } catch {
      this.internalErrors++;
    }
  }

  duel(room: Room, a: Player, b: Player): void {
    try {
      this.emit('duel', { room: room.code, a: a.name, b: b.name });
    } catch {
      this.internalErrors++;
    }
  }

  battle(_room: Room, kind: Battle['kind']): void {
    const b = this.counters.battles;
    if (kind === 'wild') b.wild++;
    else if (kind === 'pvp') b.pvp++;
    else b.final++;
  }

  /** Mortes (com renascimento) e saídas no Duelo Final: as duas contam em eliminations. */
  eliminated(_room: Room, _p: Player): void {
    this.counters.eliminations++;
  }

  // ---------------------------------------------------------------- leitura

  /** Resposta completa do contrato (ObsStats) com os eventos a partir de `since`. */
  snapshot(since: number, src: StatsSource): ObsStats {
    const now = this.now();
    const players = { online: 0, lobby: 0, playing: 0, spectating: 0 };
    const countries: Record<string, number> = Object.create(null) as Record<string, number>;
    const devices: Record<ObsDevice, number> = { mobile: 0, desktop: 0 };
    const rooms: ObsRoom[] = [];
    for (const r of src.rooms) {
      const humans = r.members.size;
      players.online += humans;
      let alive = 0;
      let bots = 0;
      if (r.state === 'lobby') players.lobby += humans;
      else {
        let humanPlayers = 0;
        for (const m of r.members) {
          if (m.player) humanPlayers++;
          if (r.state === 'play' && m.player?.alive) players.playing++;
          else players.spectating++;
        }
        for (const p of r.players.values()) if (p.alive) alive++;
        // Jogadores que não são de humanos ainda na sala: bots desde o início e humanos que saíram
        // (na partida um bot assume; na tela de fim o Room.leave não zera p.conn). humans + bots = total.
        bots = Math.max(0, r.players.size - humanPlayers);
      }
      for (const m of r.members) {
        const meta = this.conns.get(m.conn);
        const c = meta?.country ?? 'XX';
        countries[c] = (countries[c] ?? 0) + 1;
        devices[meta?.device ?? 'desktop']++;
      }
      let elapsedMs: number;
      if (r.state === 'lobby') elapsedMs = now - (this.roomCreatedAt.get(r) ?? now);
      else if (r.state === 'play') elapsedMs = now - r.startedAt;
      else elapsedMs = r.endedAt - r.startedAt;
      rooms.push({
        code: r.code,
        private: r.isPrivate,
        state: r.state,
        humans,
        bots,
        alive,
        phase: r.state === 'lobby' ? 'lobby' : r.state === 'fim' ? 'fim' : r.phase,
        elapsedMs: Math.max(0, elapsedMs),
      });
    }
    const mem = process.memoryUsage();
    const c = this.counters;
    return {
      now,
      startedAt: this.startedAt,
      version: this.version,
      process: {
        rssMB: round(mem.rss / 1048576, 1),
        heapUsedMB: round(mem.heapUsed / 1048576, 1),
        cpuPct: this.cpu(),
        eventLoopLagMs: this.eventLoopLag(),
        tickMs: this.ticks.quantiles(),
      },
      connections: { open: src.openConns, total: this.totalConns },
      players,
      rooms,
      counters: {
        joins: c.joins,
        matchesStarted: c.matchesStarted,
        matchesEnded: c.matchesEnded,
        battles: { ...c.battles },
        eliminations: c.eliminations,
        rateLimited: src.security.rateLimited,
        rejectedConnections: src.security.rejectedConnections,
        originRejected: src.security.originRejected,
        errors: c.errors,
      },
      breakdown: { countries: { ...countries }, devices },
      events: this.eventsSince(since),
      nextSeq: this.seq,
    };
  }
}
