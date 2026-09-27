// Servidor HTTP do observador: /healthz público, login, painel, APIs JSON, SSE e /metrics.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  RateLimiter,
  SESSION_COOKIE,
  Sessions,
  bearer,
  clearCookie,
  clientIp,
  parseCookies,
  sessionCookie,
} from './auth';
import { ALL_EVENT_TYPES, readDay, type StoredEvent } from './events';
import { renderMetrics } from './metrics';
import type { Observer, TickListener } from './observer';

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CSP,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const RANGES: Record<string, { ms: number; points: number }> = {
  '1h': { ms: 3600_000, points: 360 },
  '6h': { ms: 6 * 3600_000, points: 360 },
  '24h': { ms: 24 * 3600_000, points: 480 },
};

const MAX_SSE = 32;

interface StaticFile {
  body: Buffer;
  type: string;
}

function loadStatic(dir: string): Record<string, StaticFile> {
  const files: [string, string, string][] = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/login', 'login.html', 'text/html; charset=utf-8'],
    ['/static/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/static/view.js', 'view.js', 'text/javascript; charset=utf-8'],
    ['/static/app.css', 'app.css', 'text/css; charset=utf-8'],
    ['/static/favicon.svg', 'favicon.svg', 'image/svg+xml'],
  ];
  const out: Record<string, StaticFile> = {};
  for (const [route, name, type] of files) {
    try {
      out[route] = { body: readFileSync(join(dir, name)), type };
    } catch {
      out[route] = { body: Buffer.from(`${name} não encontrado em ${dir}`), type: 'text/plain; charset=utf-8' };
    }
  }
  return out;
}

const LOGIN_MESSAGES = {
  none: '',
  wrong: 'Token incorreto.',
  limited: 'Muitas tentativas. Espere um minuto.',
  origin: 'Origem da requisição recusada.',
} as const;

export interface ObsServerOptions {
  token: string;
  publicDir: string;
  now?: () => number;
  /** Tentativas de login (e de Bearer errado) por IP por minuto. */
  loginPerMinute?: number;
  heartbeatMs?: number;
}

export interface ObsServer {
  server: Server;
  limiter: RateLimiter;
  closeStreams(): void;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function json(res: ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', extra);
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        resolvePromise(null);
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => resolvePromise(null));
  });
}

/** Se veio Origin (navegadores mandam em POST), ele precisa bater com o Host. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createObsServer(obs: Observer, opts: ObsServerOptions): ObsServer {
  const sessions = new Sessions(opts.token);
  const limiter = new RateLimiter(opts.loginPerMinute ?? 5, 60_000);
  const statics = loadStatic(opts.publicDir);
  const now = opts.now ?? Date.now;
  const streams = new Set<ServerResponse>();
  // Um payload por tick é serializado uma vez, mesmo com vários painéis abertos.
  const serialized = new WeakMap<object, string>();

  const loginPage = (msg: keyof typeof LOGIN_MESSAGES) =>
    statics['/login'].body.toString('utf8').replace('<!--MSG-->', LOGIN_MESSAGES[msg]);

  /** 'ok' | 'none' (sem credencial) | 'bad' (credencial errada) | 'limited'. */
  function authenticate(req: IncomingMessage): 'ok' | 'none' | 'bad' | 'limited' {
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (cookie && sessions.verify(cookie, now())) return 'ok';
    const b = bearer(req);
    if (b !== null) {
      const ip = clientIp(req);
      if (limiter.blocked(ip, now())) return 'limited';
      if (sessions.checkToken(b)) return 'ok';
      limiter.hit(ip, now());
      return 'bad';
    }
    return cookie ? 'bad' : 'none';
  }

  function openStream(req: IncomingMessage, res: ServerResponse): void {
    if (streams.size >= MAX_SSE) {
      json(res, 503, { error: 'muitos painéis conectados' });
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    streams.add(res);
    const write = (event: string, data: string) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${data}\n\n`);
    };
    res.write('retry: 3000\n\n');
    write('hello', JSON.stringify({ summary: obs.summary(), events: obs.events.query({ limit: 150 }).reverse() }));
    const listener: TickListener = (payload) => {
      let s = serialized.get(payload);
      if (s === undefined) {
        s = JSON.stringify(payload);
        serialized.set(payload, s);
      }
      write('tick', s);
    };
    const off = obs.onTick(listener);
    // Comentário periódico para o túnel/proxies não fecharem a conexão ociosa.
    const hb = setInterval(() => {
      if (!res.writableEnded) res.write(': hb\n\n');
    }, opts.heartbeatMs ?? 20_000);
    const cleanup = () => {
      off();
      clearInterval(hb);
      streams.delete(res);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const html = 'text/html; charset=utf-8';
    if (!sameOrigin(req)) {
      send(res, 403, loginPage('origin'), html);
      return;
    }
    const ip = clientIp(req);
    if (!limiter.hit(ip, now())) {
      send(res, 429, loginPage('limited'), html, { 'retry-after': String(limiter.retryAfterS(ip, now())) });
      return;
    }
    const body = await readBody(req, 4096);
    const token = body === null ? '' : (new URLSearchParams(body).get('token') ?? '').trim();
    if (!token || !sessions.checkToken(token)) {
      send(res, 401, loginPage('wrong'), html);
      return;
    }
    res.writeHead(303, { ...SECURITY_HEADERS, location: '/', 'set-cookie': sessionCookie(sessions.issue(now()), req), 'cache-control': 'no-store' });
    res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://obs.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/healthz' && (method === 'GET' || method === 'HEAD')) {
      json(res, 200, { ok: true, game: obs.collector.state.status === 'up' ? 'up' : 'down' });
      return;
    }
    if (path.startsWith('/static/') && (method === 'GET' || method === 'HEAD')) {
      const f = statics[path];
      if (!f) {
        send(res, 404, 'não encontrado', 'text/plain; charset=utf-8');
        return;
      }
      send(res, 200, f.body, f.type, { 'cache-control': 'no-cache' });
      return;
    }
    if (path === '/login') {
      if (method === 'POST') return handleLogin(req, res);
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, 'método não permitido', 'text/plain; charset=utf-8', { allow: 'GET, POST' });
        return;
      }
      const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (cookie && sessions.verify(cookie, now())) {
        res.writeHead(302, { ...SECURITY_HEADERS, location: '/' }).end();
        return;
      }
      send(res, 200, loginPage('none'), 'text/html; charset=utf-8');
      return;
    }
    if (path === '/logout' && method === 'POST') {
      if (!sameOrigin(req)) {
        send(res, 403, 'origem recusada', 'text/plain; charset=utf-8');
        return;
      }
      res.writeHead(303, { ...SECURITY_HEADERS, location: '/login', 'set-cookie': clearCookie(req) }).end();
      return;
    }

    // Daqui para baixo, tudo exige autenticação.
    const auth = authenticate(req);
    if (auth !== 'ok') {
      if (auth === 'limited') {
        json(res, 429, { error: 'muitas tentativas' }, { 'retry-after': String(limiter.retryAfterS(clientIp(req), now())) });
        return;
      }
      if (path === '/' && method === 'GET') {
        res.writeHead(302, { ...SECURITY_HEADERS, location: '/login', 'cache-control': 'no-store' }).end();
        return;
      }
      json(res, 401, { error: 'não autenticado' }, { 'www-authenticate': 'Bearer realm="vira-bicho-obs"' });
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, 'método não permitido', 'text/plain; charset=utf-8', { allow: 'GET' });
      return;
    }

    switch (path) {
      case '/':
        send(res, 200, statics['/'].body, statics['/'].type);
        return;
      case '/api/summary':
        json(res, 200, obs.summary());
        return;
      case '/api/series': {
        const range = RANGES[url.searchParams.get('range') ?? '1h'];
        if (!range) {
          json(res, 400, { error: 'range deve ser 1h, 6h ou 24h' });
          return;
        }
        const fieldsParam = url.searchParams.get('fields');
        const only = fieldsParam ? fieldsParam.split(',').slice(0, 20) : undefined;
        const t = now();
        json(res, 200, obs.series.range(t - range.ms, t, range.points, only));
        return;
      }
      case '/api/events': {
        const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 100));
        const types = (url.searchParams.get('type') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => ALL_EVENT_TYPES.includes(s));
        const before = Number(url.searchParams.get('before'));
        const day = url.searchParams.get('day');
        let events: StoredEvent[];
        if (day) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
            json(res, 400, { error: 'day deve ser AAAA-MM-DD' });
            return;
          }
          events = (await readDay(obs.cfg.dataDir, day))
            .filter((e) => (!types.length || types.includes(e.type)) && (!before || e.id < before))
            .slice(-limit)
            .reverse();
        } else {
          events = obs.events.query({ limit, types, beforeId: before || undefined });
        }
        json(res, 200, { events });
        return;
      }
      case '/api/stream':
        openStream(req, res);
        return;
      case '/metrics':
        send(res, 200, renderMetrics(obs), 'text/plain; version=0.0.4; charset=utf-8');
        return;
      default:
        json(res, 404, { error: 'não encontrado' });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[obs] erro na requisição:', (err as Error).message);
      if (!res.headersSent) json(res, 500, { error: 'erro interno' });
      else res.end();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    limiter,
    closeStreams() {
      for (const r of streams) r.end();
      streams.clear();
    },
  };
}
