// Autenticação do painel: token único (OBS_TOKEN) → cookie de sessão assinado com HMAC.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import { writeAtomicSync } from './fsutil';

/** Nome do cookie em HTTP puro (LAN). */
export const SESSION_COOKIE = 'vbobs';
/**
 * Nome em HTTPS. O prefixo __Host- obriga Secure, Path=/ e proíbe Domain: um subdomínio irmão
 * (outro serviço em *.caixazen.online) não consegue plantar um cookie com esse nome.
 */
export const SESSION_COOKIE_HOST = '__Host-vbobs';
export const SESSION_TTL_MS = 7 * 24 * 3600_000;

/** Comparação em tempo constante (independe do tamanho, pois compara os hashes). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export interface SessionInfo {
  exp: number;
  epoch: number;
  id: string;
}

/** exp.epoch.id.assinatura — tudo em forma canônica (a assinatura HMAC-SHA256 em base64url tem 43 caracteres). */
const SESSION_RE = /^(\d{1,16})\.(\d{1,9})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
const MAX_REVOKED = 1_000;

interface SessionFile {
  v: 1;
  epoch: number;
  revoked: [string, number][];
}

/**
 * Sessões sem estado no servidor, mas revogáveis:
 * - "sair" põe o id da sessão numa lista de revogados até ela expirar;
 * - "sair de todos os aparelhos" incrementa o epoch, que entra na parte assinada do cookie.
 * Lista e epoch ficam em sessions.json na pasta de dados (sobrevivem a reinícios).
 */
export class Sessions {
  private readonly key: Buffer;
  private epoch = 0;
  private revoked = new Map<string, number>();

  /** A chave deriva do OBS_TOKEN: trocar o token invalida todas as sessões. */
  constructor(
    private readonly token: string,
    private readonly file: string | null = null,
  ) {
    this.key = createHash('sha256').update(`vira-bicho-obs/session/${token}`).digest();
    this.load();
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  get revokedCount(): number {
    return this.revoked.size;
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SessionFile>;
      if (typeof raw.epoch === 'number' && Number.isInteger(raw.epoch) && raw.epoch >= 0 && raw.epoch < 1e9) this.epoch = raw.epoch;
      if (Array.isArray(raw.revoked)) {
        for (const r of raw.revoked.slice(0, MAX_REVOKED)) {
          if (Array.isArray(r) && typeof r[0] === 'string' && /^[A-Za-z0-9_-]{16}$/.test(r[0]) && Number.isFinite(r[1])) {
            this.revoked.set(r[0], r[1]);
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[obs] sessions.json ilegível; seguindo sem revogações:', (err as Error).message);
    }
  }

  private save(): void {
    if (!this.file) return;
    const data: SessionFile = { v: 1, epoch: this.epoch, revoked: [...this.revoked] };
    try {
      writeAtomicSync(this.file, JSON.stringify(data));
    } catch (err) {
      console.error('[obs] falha ao salvar sessions.json:', (err as Error).message);
    }
  }

  checkToken(candidate: string): boolean {
    return this.token.length > 0 && safeEqual(candidate, this.token);
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  issue(now = Date.now()): string {
    const payload = `${now + SESSION_TTL_MS}.${this.epoch}.${randomBytes(12).toString('base64url')}`;
    return `${payload}.${this.mac(payload)}`;
  }

  /** Sessão válida (assinatura, validade, epoch e não revogada) ou null. */
  check(value: string | undefined, now = Date.now()): SessionInfo | null {
    if (!value || value.length > 120) return null;
    const m = SESSION_RE.exec(value);
    if (!m) return null;
    const payload = `${m[1]}.${m[2]}.${m[3]}`;
    // Compara as strings canônicas: nada de decodificar base64 (que aceita sufixos e o alfabeto +/).
    const sig = Buffer.from(m[4], 'ascii');
    const expected = Buffer.from(this.mac(payload), 'ascii');
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    const info: SessionInfo = { exp: Number(m[1]), epoch: Number(m[2]), id: m[3] };
    return this.isValid(info, now) ? info : null;
  }

  /** Continua valendo? (usado também para derrubar streams SSE de sessões encerradas). */
  isValid(info: SessionInfo, now = Date.now()): boolean {
    return info.exp > now && info.epoch === this.epoch && !this.revoked.has(info.id);
  }

  verify(value: string | undefined, now = Date.now()): boolean {
    return this.check(value, now) !== null;
  }

  /** Revoga uma sessão ("sair" neste aparelho). */
  revoke(info: SessionInfo, now = Date.now()): void {
    for (const [id, exp] of this.revoked) if (exp <= now) this.revoked.delete(id);
    if (this.revoked.size >= MAX_REVOKED) {
      // Lista cheia: mais simples (e seguro) derrubar todas as sessões.
      this.revokeAll();
      return;
    }
    this.revoked.set(info.id, info.exp);
    this.save();
  }

  /** "Sair de todos os aparelhos": invalida todas as sessões emitidas até agora. */
  revokeAll(): void {
    this.epoch++;
    this.revoked.clear();
    this.save();
  }
}

/** Todos os valores dos cookies com esses nomes (um subdomínio pode ter plantado duplicatas). */
export function cookieValues(header: string | undefined, names: readonly string[]): string[] {
  const out: string[] = [];
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (names.includes(part.slice(0, i).trim())) out.push(part.slice(i + 1).trim());
  }
  return out;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k === '__proto__') continue;
    out[k] = part.slice(i + 1).trim();
  }
  return out;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(addr: string | undefined): boolean {
  return !!addr && (LOOPBACK.has(addr) || addr.startsWith('127.') || addr.startsWith('::ffff:127.'));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * IP real do cliente. O cloudflared conecta pelo loopback, então só nesse caso o
 * CF-Connecting-IP é confiável; de qualquer outro remoto o cabeçalho é ignorado.
 */
export function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? 'desconhecido';
  if (isLoopback(remote)) {
    const cf = header(req, 'cf-connecting-ip')?.trim();
    if (cf && cf.length <= 64 && /^[0-9a-fA-F:.]+$/.test(cf)) return cf;
  }
  return remote;
}

/**
 * Conexão feita no próprio celular (loopback sem nenhum cabeçalho de proxy), por exemplo um
 * curl ou um coletor Prometheus local. Não é tráfego do túnel: o cloudflared sempre acrescenta
 * CF-Connecting-IP / CF-Ray / X-Forwarded-For, e quem vem pela internet não consegue removê-los.
 */
export function isDirectLocal(req: IncomingMessage): boolean {
  if (!isLoopback(req.socket.remoteAddress)) return false;
  return !req.headers['cf-connecting-ip'] && !req.headers['cf-ray'] && !req.headers['x-forwarded-for'];
}

/** Expande um IPv6 para 8 grupos de 16 bits (null se inválido). */
function ipv6Groups(ip: string): number[] | null {
  if (!isIPv6(ip)) return null;
  let s = ip.split('%')[0];
  // Sufixo IPv4 (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) vira dois grupos.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const b = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array<string>(fill).fill('0'), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Chave do limite de tentativas. Um cliente IPv6 costuma controlar um /64 inteiro, então
 * todos os endereços do mesmo /64 contam juntos. IPv4 (inclusive mapeado em IPv6) conta por endereço.
 */
export function rateKey(ip: string): string {
  if (isIPv4(ip)) return ip;
  const g = ipv6Groups(ip);
  if (!g) return ip;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}

/** Atrás de HTTPS (Cloudflare): o cookie ganha Secure e o prefixo __Host-. */
export function isHttps(req: IncomingMessage): boolean {
  if (header(req, 'x-forwarded-proto')?.split(',')[0].trim() === 'https') return true;
  const visitor = header(req, 'cf-visitor');
  return !!visitor && /"scheme"\s*:\s*"https"/.test(visitor);
}

export function sessionCookie(value: string, req: IncomingMessage): string {
  const attrs = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
  return isHttps(req) ? `${SESSION_COOKIE_HOST}=${value}; ${attrs}; Secure` : `${SESSION_COOKIE}=${value}; ${attrs}`;
}

/** Apaga os dois nomes possíveis do cookie. */
export function clearCookies(req: IncomingMessage): string[] {
  const out = [`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? '; Secure' : ''}`];
  if (isHttps(req)) out.push(`${SESSION_COOKIE_HOST}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure`);
  return out;
}

export function bearer(req: IncomingMessage): string | null {
  const h = header(req, 'authorization');
  const m = h ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m ? m[1] : null;
}

/** Janela fixa por chave: no máximo `max` falhas por `windowMs`. */
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  /** Registra uma falha; false = passou do limite. */
  hit(key: string, now = Date.now()): boolean {
    let h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      if (this.hits.size >= this.maxKeys) this.sweep(now);
      h = { start: now, n: 0 };
      this.hits.set(key, h);
    }
    h.n++;
    return h.n <= this.max;
  }

  blocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    return !!h && now - h.start < this.windowMs && h.n >= this.max;
  }

  retryAfterS(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    return h ? Math.max(1, Math.ceil((h.start + this.windowMs - now) / 1000)) : 0;
  }

  get size(): number {
    return this.hits.size;
  }

  private sweep(now: number): void {
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
    // Ainda cheio: descarta os mais antigos. Com o limite global de falhas (LoginGuard), o mapa
    // nunca chega perto disso: só falhas criam chaves e elas param quando o limite global estoura.
    if (this.hits.size >= this.maxKeys) {
      const drop = this.hits.size - Math.floor(this.maxKeys / 2);
      let i = 0;
      for (const k of this.hits.keys()) {
        if (i++ >= drop) break;
        this.hits.delete(k);
      }
    }
  }
}

/**
 * Limite de tentativas de login/Bearer: só as falhas contam.
 * - por cliente: `perKey` falhas por minuto, com IPv6 agrupado por /64;
 * - global: `global` falhas por minuto somando todo mundo (contra quem tem muitos endereços).
 */
export class LoginGuard {
  readonly perKey: RateLimiter;
  readonly global: RateLimiter;

  constructor(perKey = 5, global = 30, windowMs = 60_000) {
    this.perKey = new RateLimiter(perKey, windowMs);
    this.global = new RateLimiter(global, windowMs, 1);
  }

  /** Segundos até liberar (0 = pode tentar). */
  blockedFor(ip: string, now = Date.now()): number {
    const k = rateKey(ip);
    if (this.perKey.blocked(k, now)) return this.perKey.retryAfterS(k, now);
    if (this.global.blocked('*', now)) return this.global.retryAfterS('*', now);
    return 0;
  }

  fail(ip: string, now = Date.now()): void {
    this.perKey.hit(rateKey(ip), now);
    this.global.hit('*', now);
  }
}
