// Autenticação do painel: token único (OBS_TOKEN) → cookie de sessão assinado com HMAC.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const SESSION_COOKIE = 'vbobs';
export const SESSION_TTL_MS = 7 * 24 * 3600_000;

/** Comparação em tempo constante (independe do tamanho, pois compara os hashes). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export class Sessions {
  private readonly key: Buffer;

  /** A chave deriva do OBS_TOKEN: trocar o token invalida todas as sessões. */
  constructor(private readonly token: string) {
    this.key = createHash('sha256').update(`vira-bicho-obs/session/${token}`).digest();
  }

  checkToken(candidate: string): boolean {
    return this.token.length > 0 && safeEqual(candidate, this.token);
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  issue(now = Date.now()): string {
    const payload = `${now + SESSION_TTL_MS}.${randomBytes(12).toString('base64url')}`;
    return `${payload}.${this.mac(payload)}`;
  }

  verify(value: string | undefined, now = Date.now()): boolean {
    if (!value || value.length > 200) return false;
    const i = value.lastIndexOf('.');
    if (i <= 0) return false;
    const payload = value.slice(0, i);
    const sig = Buffer.from(value.slice(i + 1), 'base64url');
    const expected = Buffer.from(this.mac(payload), 'base64url');
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
    const exp = Number(payload.split('.')[0]);
    return Number.isFinite(exp) && exp > now;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
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

/** Atrás de HTTPS (Cloudflare): o cookie ganha o atributo Secure. */
export function isHttps(req: IncomingMessage): boolean {
  if (header(req, 'x-forwarded-proto')?.split(',')[0].trim() === 'https') return true;
  const visitor = header(req, 'cf-visitor');
  return !!visitor && /"scheme"\s*:\s*"https"/.test(visitor);
}

export function sessionCookie(value: string, req: IncomingMessage): string {
  const secure = isHttps(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

export function clearCookie(req: IncomingMessage): string {
  const secure = isHttps(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export function bearer(req: IncomingMessage): string | null {
  const h = header(req, 'authorization');
  const m = h ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m ? m[1] : null;
}

/** Janela fixa por chave (IP): no máximo `max` tentativas por `windowMs`. */
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  /** Registra uma tentativa; false = bloqueado. */
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

  private sweep(now: number): void {
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
    // Ainda cheio (ataque distribuído): descarta os mais antigos.
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
