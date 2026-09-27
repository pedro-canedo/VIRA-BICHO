import { createHash, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP, isIPv4 } from 'node:net';
import { BALANCE } from '@vb/shared';

// ---------------------------------------------------------------- limites

export interface Rate {
  capacity: number;
  refillPerSec: number;
}

export interface SecurityConfig {
  http: {
    headersTimeoutMs: number;
    requestTimeoutMs: number;
    checkIntervalMs: number;
    maxHeadersCount: number;
    maxConnections: number;
    maxUrlLength: number;
    rate: Rate;
  };
  ws: {
    maxPayloadBytes: number;
    maxClients: number;
    maxPerIp: number;
    /** Conexões simultâneas por /48 IPv6 (quem gira de /64 dentro do mesmo bloco). */
    maxPerNet: number;
    handshake: Rate;
    /** Handshakes por /48 IPv6. */
    handshakeNet: Rate;
    helloTimeoutMs: number;
    /** Fora de sala, para quem já esteve numa sala nesta conexão. */
    idleNoRoomMs: number;
    /** Fora de sala, para quem nunca entrou numa sala (contado do último hello). */
    idleNeverJoinedMs: number;
    /** Vivo numa partida sem nenhum comando (move/target/act): fecha com 4003 e vira bot. */
    idleInPlayMs: number;
    /** Prazo entre o close() por abuso ou prazo e o terminate() (peer que não responde ao close). */
    closeGraceMs: number;
    sweepMs: number;
    heartbeatMs: number;
    /** Heap usado (MB) a partir do qual novos handshakes recebem 503. O processo roda com --max-old-space-size=256. */
    heapRejectMB: number;
    msg: Rate;
    /** Frames de controle (ping/pong) vindos do cliente. Navegadores não mandam ping. */
    ctrl: Rate;
    abuse: { windowMs: number; maxDropped: number; maxInvalid: number };
    backpressure: { skipSnapBytes: number; terminateBytes: number };
  };
  lobby: LobbyLimits;
  game: { targetSlackTiles: number };
  keys: { maxTracked: number; sweepMs: number };
  log: { throttleMs: number; summaryMs: number };
}

export interface LobbyLimits {
  maxRooms: number;
  helloPerConn: Rate;
  roomCreate: Rate;
  maxRoomsPerIp: number;
  /** Teto maior só para a partida rápida (CGNAT: desconhecidos na mesma rede). */
  maxQuickRoomsPerIp: number;
  /** Salas por /48 IPv6 (soma dos /64 do mesmo bloco). */
  maxRoomsPerNet: number;
  maxPrivateRooms: number;
  failedJoin: { windowMs: number; max: number };
  /** Códigos errados somando todas as chaves: acima disso, join por código fica fechado até a janela esvaziar. */
  failedJoinGlobal: { windowMs: number; max: number };
}

export const SECURITY: SecurityConfig = {
  http: {
    headersTimeoutMs: 10_000,
    requestTimeoutMs: 15_000,
    checkIntervalMs: 5_000,
    maxHeadersCount: 100,
    maxConnections: 1000,
    maxUrlLength: 2048,
    rate: { capacity: 60, refillPerSec: 20 },
  },
  ws: {
    // O maior hello legítimo tem menos de 150 bytes.
    maxPayloadBytes: 512,
    maxClients: 500,
    maxPerIp: 16,
    maxPerNet: 48,
    handshake: { capacity: 40, refillPerSec: 0.5 },
    handshakeNet: { capacity: 80, refillPerSec: 1.5 },
    helloTimeoutMs: 10_000,
    idleNoRoomMs: 300_000,
    idleNeverJoinedMs: 60_000,
    idleInPlayMs: 120_000,
    closeGraceMs: 1_000,
    sweepMs: 5_000,
    heartbeatMs: 20_000,
    heapRejectMB: 200,
    msg: { capacity: 20, refillPerSec: 10 },
    ctrl: { capacity: 5, refillPerSec: 1 },
    abuse: { windowMs: 10_000, maxDropped: 30, maxInvalid: 10 },
    backpressure: { skipSnapBytes: 131_072, terminateBytes: 1_048_576 },
  },
  lobby: {
    maxRooms: BALANCE.lobby.maxRooms,
    helloPerConn: { capacity: 3, refillPerSec: 1 / 3 },
    roomCreate: { capacity: 4, refillPerSec: 1 / 150 },
    maxRoomsPerIp: 2,
    maxQuickRoomsPerIp: 3,
    maxRoomsPerNet: 4,
    // Reserva vagas para a partida rápida.
    maxPrivateRooms: BALANCE.lobby.maxRooms - 2,
    failedJoin: { windowMs: 60_000, max: 10 },
    failedJoinGlobal: { windowMs: 60_000, max: 300 },
  },
  game: { targetSlackTiles: 4 },
  keys: { maxTracked: 10_000, sweepMs: 60_000 },
  log: { throttleMs: 60_000, summaryMs: 60_000 },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return structuredClone(base);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base as Record<string, unknown>)) {
    const o = (over as Record<string, unknown>)[k];
    if (v && typeof v === 'object') out[k] = merge(v, o as DeepPartial<typeof v> | undefined);
    else out[k] = o === undefined ? v : o;
  }
  return out as T;
}

/** SECURITY com sobrescritas (merge profundo, sem mutar o original). */
export function resolveSecurity(over?: DeepPartial<SecurityConfig>): SecurityConfig {
  return merge(SECURITY, over);
}

// ---------------------------------------------------------------- baldes e janelas

/** Balde de fichas com recarga preguiçosa (sem timers). */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly capacity: number,
    readonly refillPerSec: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number): void {
    if (now <= this.last) return;
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
  }

  take(now: number, cost = 1): boolean {
    this.refill(now);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  level(now: number): number {
    this.refill(now);
    return this.tokens;
  }

  give(now: number, amount = 1): void {
    this.refill(now);
    this.tokens = Math.min(this.capacity, this.tokens + amount);
  }
}

/** Um balde por chave, com teto de chaves (a mais antiga sai primeiro). */
export class KeyedBuckets {
  private readonly map = new Map<string, TokenBucket>();

  constructor(
    readonly capacity: number,
    readonly refillPerSec: number,
    readonly maxKeys = 10_000,
  ) {}

  take(key: string, now: number, cost = 1): boolean {
    let b = this.map.get(key);
    if (!b) {
      if (this.map.size >= this.maxKeys) this.map.delete(this.map.keys().next().value!);
      b = new TokenBucket(this.capacity, this.refillPerSec, now);
      this.map.set(key, b);
    }
    return b.take(now, cost);
  }

  /** Devolve fichas (sem passar da capacidade). Chave sem balde já está cheia. */
  refund(key: string, now: number, amount = 1): void {
    this.map.get(key)?.give(now, amount);
  }

  /** Remove os baldes cheios (equivalem a um balde novo). */
  sweep(now: number): void {
    for (const [k, b] of this.map) if (b.level(now) >= this.capacity) this.map.delete(k);
  }

  get size(): number {
    return this.map.size;
  }
}

/** Conta ocorrências por chave numa janela deslizante (guarda no máximo max+1 marcas). */
export class SlidingWindow {
  private readonly map = new Map<string, number[]>();

  constructor(
    readonly windowMs: number,
    readonly max: number,
    readonly maxKeys = 10_000,
  ) {}

  private prune(key: string, now: number): number[] {
    const arr = this.map.get(key);
    if (!arr) return [];
    while (arr.length && arr[0] <= now - this.windowMs) arr.shift();
    if (!arr.length) this.map.delete(key);
    return arr;
  }

  hit(key: string, now: number): number {
    let arr = this.prune(key, now);
    if (!this.map.has(key)) {
      if (this.map.size >= this.maxKeys) this.map.delete(this.map.keys().next().value!);
      arr = [];
      this.map.set(key, arr);
    }
    arr.push(now);
    if (arr.length > this.max + 1) arr.shift();
    return arr.length;
  }

  count(key: string, now: number): number {
    return this.prune(key, now).length;
  }

  sweep(now: number): void {
    for (const k of [...this.map.keys()]) this.prune(k, now);
  }

  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------- log de segurança

export type SecKind =
  | 'http_error'
  | 'http_rate_limited'
  | 'http_405'
  | 'ws_origin_rejected'
  | 'ws_server_full'
  | 'ws_ip_limit'
  | 'ws_net_limit'
  | 'ws_handshake_rate'
  | 'ws_mem_guard'
  | 'ws_hello_timeout'
  | 'ws_idle_timeout'
  | 'ws_idle_in_play'
  | 'ws_rate_limited'
  | 'ws_abuse_closed'
  | 'ws_invalid_msg'
  | 'ws_error'
  | 'ws_slow_consumer'
  | 'handle_error'
  | 'timer_error'
  | 'cf_header_from_lan'
  | 'lobby_room_cap'
  | 'lobby_create_rate'
  | 'lobby_private_cap'
  | 'lobby_join_bruteforce'
  | 'lobby_hello_rate';

const RATE_LIMITED: SecKind[] = ['http_rate_limited', 'ws_handshake_rate', 'ws_rate_limited', 'lobby_create_rate', 'lobby_join_bruteforce', 'lobby_hello_rate'];
const REJECTED: SecKind[] = ['ws_server_full', 'ws_ip_limit', 'ws_net_limit', 'ws_handshake_rate', 'ws_mem_guard'];

/** Identificador curto e não reversível de uma chave (IP). O salt muda a cada processo. */
export function ipTag(key: string, salt: string): string {
  return createHash('sha256').update(salt + key).digest('hex').slice(0, 10);
}

export interface SecuritySummary {
  rateLimited: number;
  rejectedConnections: number;
  originRejected: number;
  byKind: Partial<Record<SecKind, number>>;
}

/**
 * Conta eventos de segurança e escreve no máximo 1 linha por (tipo, tag) a cada throttleMs.
 * Nunca loga IP cru, apelido, conteúdo de mensagem nem URL inteira.
 */
export class SecurityLog {
  private readonly byKind: Partial<Record<SecKind, number>> = {};
  private readonly throttle = new Map<string, { at: number; suppressed: number }>();
  private readonly now: () => number;
  private readonly write: (line: string) => void;
  private readonly throttleMs: number;
  private readonly summaryMs: number;
  private readonly salt: string;
  private lastSummaryAt: number;
  private sinceSummary = 0;
  private readonly onLine: ((kind: SecKind, tag: string, detail?: string) => void) | undefined;

  constructor(o: {
    now: () => number;
    write: (line: string) => void;
    throttleMs: number;
    summaryMs: number;
    salt?: string;
    /** Cada linha escrita (mesmo throttle do log): alimenta os eventos do observador. Nunca recebe o IP. */
    onLine?: (kind: SecKind, tag: string, detail?: string) => void;
  }) {
    this.now = o.now;
    this.write = o.write;
    this.onLine = o.onLine;
    this.throttleMs = o.throttleMs;
    this.summaryMs = o.summaryMs;
    this.salt = o.salt ?? randomBytes(16).toString('hex');
    this.lastSummaryAt = o.now();
  }

  tag(key: string): string {
    return ipTag(key, this.salt);
  }

  event(kind: SecKind, key: string, detail?: string): void {
    this.byKind[kind] = (this.byKind[kind] ?? 0) + 1;
    this.sinceSummary++;
    const t = this.now();
    const tag = this.tag(key);
    const id = `${kind}|${tag}`;
    const cur = this.throttle.get(id);
    if (cur && t - cur.at < this.throttleMs) {
      cur.suppressed++;
      return;
    }
    if (!cur && this.throttle.size >= 5000) this.throttle.clear();
    this.throttle.set(id, { at: t, suppressed: 0 });
    const line: Record<string, unknown> = { t, ev: 'sec', kind, tag, n: cur?.suppressed ?? 0 };
    if (detail !== undefined) line.d = String(detail).slice(0, 80);
    this.write(JSON.stringify(line));
    this.onLine?.(kind, tag, detail === undefined ? undefined : String(detail).slice(0, 80));
  }

  /** Escreve o resumo periódico, se houve eventos desde o último. */
  tick(now: number): void {
    if (now - this.lastSummaryAt < this.summaryMs) return;
    this.lastSummaryAt = now;
    if (this.sinceSummary === 0) return;
    this.sinceSummary = 0;
    this.write(JSON.stringify({ t: now, ev: 'sec_summary', ...this.summary() }));
  }

  summary(): SecuritySummary {
    const sum = (kinds: SecKind[]) => kinds.reduce((s, k) => s + (this.byKind[k] ?? 0), 0);
    return {
      rateLimited: sum(RATE_LIMITED),
      rejectedConnections: sum(REJECTED),
      originRejected: sum(['ws_origin_rejected']),
      byKind: { ...this.byKind },
    };
  }
}

// ---------------------------------------------------------------- IP e Origin

/** Tira o '::ffff:' de IPv4 mapeado e o sufixo de zona do IPv6. */
export function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  const pct = ip.indexOf('%');
  if (pct >= 0) ip = ip.slice(0, pct);
  if (ip.startsWith('::ffff:') && isIPv4(ip.slice(7))) ip = ip.slice(7);
  return ip;
}

function v4Octets(ip: string): number[] {
  return ip.split('.').map(Number);
}

/** Expande um IPv6 em 8 grupos numéricos. */
function v6Groups(ip: string): number[] {
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, undefined];
  const part = (s: string | undefined) => {
    if (!s) return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (g.includes('.')) {
        const o = v4Octets(g);
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
      } else out.push(parseInt(g, 16));
    }
    return out;
  };
  const a = part(head);
  const b = part(tail);
  const zeros = tail === undefined ? [] : new Array(8 - a.length - b.length).fill(0);
  return [...a, ...zeros, ...b];
}

export function isLoopback(ip: string): boolean {
  return (isIPv4(ip) && ip.startsWith('127.')) || ip === '::1';
}

function isPrivateV4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const [a, b] = v4Octets(ip);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function isPrivate(ip: string): boolean {
  if (isPrivateV4(ip)) return true;
  if (isIP(ip) !== 6) return false;
  const g = v6Groups(ip)[0];
  return (g & 0xfe00) === 0xfc00 || (g & 0xffc0) === 0xfe80;
}

/** Chave de rate limit: IPv4 inteiro, IPv6 agrupado em /64. */
export function ipKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  return `${v6Groups(ip)
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/** Bloco /48 de uma chave IPv6 (/64); null para IPv4 e chaves especiais. */
export function netKey(key: string): string | null {
  if (!key.endsWith('::/64')) return null;
  return `${key.slice(0, -5).split(':').slice(0, 3).join(':')}::/48`;
}

/**
 * Chave do cliente. Só confia no CF-Connecting-IP quando a conexão vem de loopback (cloudflared no
 * próprio celular). Nunca lê X-Forwarded-For, X-Real-IP nem True-Client-IP: são controlados pelo cliente.
 */
export function clientId(remoteAddress: string | undefined, headers: IncomingHttpHeaders): { key: string; viaCloudflare: boolean } {
  const remote = normalizeIp(remoteAddress ?? '');
  if (isLoopback(remote)) {
    const cf = headers['cf-connecting-ip'];
    if (cf === undefined) return { key: 'local', viaCloudflare: false };
    const ip = typeof cf === 'string' ? normalizeIp(cf) : '';
    if (!isIP(ip)) return { key: 'cf-invalid', viaCloudflare: true };
    return { key: ipKey(ip), viaCloudflare: true };
  }
  return { key: isIP(remote) ? ipKey(remote) : 'unknown', viaCloudflare: false };
}

export const DEFAULT_ORIGINS = ['https://virabicho.caixazen.online', 'https://batllebicho.caixazen.online'];

/** Rótulo curto do Origin para o log: nunca o valor cru (controlado pelo cliente). */
export function originLabel(origin: string | undefined): string {
  if (!origin) return 'no_origin';
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'bad_origin';
    return u.hostname.slice(0, 40);
  } catch {
    return 'bad_origin';
  }
}

/**
 * Origin permitido no handshake. Fora da Cloudflare também aceita localhost e IPv4 privado literais
 * (Vite na LAN, acesso direto pelo IP do celular); nomes de domínio ficam de fora (DNS rebinding).
 */
export function originAllowed(origin: string | undefined, viaCloudflare: boolean, allow: Set<string>): boolean {
  if (!origin) return !viaCloudflare;
  if (allow.has(origin.toLowerCase())) return true;
  if (viaCloudflare) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || isPrivateV4(host);
}

/** Pedido local de verdade: sem cabeçalhos da Cloudflare e vindo de loopback ou rede privada. */
export function isTrustedLocal(remoteAddress: string | undefined, headers: IncomingHttpHeaders): boolean {
  if (headers['cf-connecting-ip'] !== undefined || headers['cf-ray'] !== undefined) return false;
  const ip = normalizeIp(remoteAddress ?? '');
  return isLoopback(ip) || isPrivate(ip);
}

// ---------------------------------------------------------------- apelido

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}ᅟᅠㅤﾠ⠀<>]/gu;

/** Apelido seguro: sem controles, invisíveis, bidi, zalgo nem imitação do chip de bot; até 14 code points. */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Bichinho';
  let s = raw.slice(0, 64).normalize('NFKC');
  s = s.replace(INVISIBLE, '').replace(/\p{Zs}/gu, ' ');
  s = s.replace(/(\p{M}{2})\p{M}+/gu, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, 14).join('').trim();
  if (!/[\p{L}\p{N}\p{So}]/u.test(s)) return 'Bichinho';
  if (s.replace(/[^\p{L}]/gu, '').toLowerCase() === 'bot') return 'Bichinho';
  return s;
}
