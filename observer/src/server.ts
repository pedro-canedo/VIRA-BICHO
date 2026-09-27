// Servidor HTTP do observador: /healthz público, login, painel, APIs JSON, SSE e /metrics.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  LoginGuard,
  SESSION_COOKIE,
  SESSION_COOKIE_HOST,
  Sessions,
  bearer,
  clearCookies,
  clientIp,
  cookieValues,
  isDirectLocal,
  sessionCookie,
  type SessionInfo,
} from './auth';
import { ALL_EVENT_TYPES, readDayLast, type StoredEvent } from './events';
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
  // same-origin, e não no-referrer: com no-referrer o navegador manda "Origin: null" no POST do
  // formulário de login/logout e não há como distinguir de uma origem opaca. Para outros sites
  // continua não indo nada.
  'referrer-policy': 'same-origin',
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
const COOKIE_NAMES = [SESSION_COOKIE_HOST, SESSION_COOKIE] as const;

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
  /** Falhas de login (e de Bearer) por cliente por minuto (IPv6 agrupado por /64). */
  loginPerMinute?: number;
  /** Falhas somando todos os clientes por minuto. */
  loginGlobalPerMinute?: number;
  heartbeatMs?: number;
  /** Onde guardar epoch e sessões revogadas (null = só em memória). */
  sessionFile?: string | null;
  /** Bytes pendentes num stream SSE acima dos quais o cliente é desconectado. */
  sseMaxBufferedBytes?: number;
  /** Tempo máximo que um cliente SSE pode ficar sem ler antes de ser desconectado. */
  sseStallMs?: number;
}

export interface ObsServer {
  server: Server;
  guard: LoginGuard;
  sessions: Sessions;
  closeStreams(): void;
  /** Soma do que está enfileirado nos streams SSE (bytes). */
  sseBufferedBytes(): number;
  readonly sseStreams: number;
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

/**
 * Proteção de CSRF para os POST de login/logout (além do SameSite=Strict do cookie).
 * - Sec-Fetch-Site, quando presente (navegadores atuais), precisa ser same-origin;
 * - Origin "null" (origem opaca) só vale junto com Sec-Fetch-Site: same-origin;
 * - outro Origin precisa bater com o Host;
 * - sem nenhum dos dois é um cliente que não é navegador (curl), sem risco de CSRF.
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return site === 'same-origin';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

interface StreamCtl {
  res: ServerResponse;
  /** Encerra se a sessão que abriu o stream deixou de valer. */
  recheck(): void;
  close(): void;
}

export function createObsServer(obs: Observer, opts: ObsServerOptions): ObsServer {
  const sessions = new Sessions(opts.token, opts.sessionFile ?? null);
  const guard = new LoginGuard(opts.loginPerMinute ?? 5, opts.loginGlobalPerMinute ?? 30);
  const statics = loadStatic(opts.publicDir);
  const now = opts.now ?? Date.now;
  const maxBuffered = opts.sseMaxBufferedBytes ?? 256 * 1024;
  const stallMs = opts.sseStallMs ?? 60_000;
  const streams = new Set<StreamCtl>();
  // Um payload por tick é serializado uma vez, mesmo com vários painéis abertos.
  const serialized = new WeakMap<object, string>();

  const loginPage = (msg: keyof typeof LOGIN_MESSAGES) =>
    statics['/login'].body.toString('utf8').replace('<!--MSG-->', LOGIN_MESSAGES[msg]);

  /** Qualquer um dos cookies de sessão presentes que seja válido (duplicatas plantadas não derrubam). */
  function sessionOf(req: IncomingMessage): SessionInfo | null {
    for (const v of cookieValues(req.headers.cookie, COOKIE_NAMES)) {
      const s = sessions.check(v, now());
      if (s) return s;
    }
    return null;
  }

  type Auth = { ok: true; session: SessionInfo | null } | { ok: false; why: 'none' | 'bad' } | { ok: false; why: 'limited'; retryAfterS: number };

  function authenticate(req: IncomingMessage): Auth {
    const session = sessionOf(req);
    if (session) return { ok: true, session };
    const b = bearer(req);
    if (b !== null) {
      const ip = clientIp(req);
      const t = now();
      const wait = guard.blockedFor(ip, t);
      // Bloqueio antes de conferir: quem está bloqueado não descobre se acertou. A exceção é quem
      // conecta direto no próprio celular (sem proxy): esse já lê o secrets.env, então um coletor
      // local com o token certo não fica travado porque outro processo local errou.
      if (wait && !isDirectLocal(req)) return { ok: false, why: 'limited', retryAfterS: wait };
      if (sessions.checkToken(b)) return { ok: true, session: null };
      if (wait) return { ok: false, why: 'limited', retryAfterS: wait };
      guard.fail(ip, t);
      return { ok: false, why: 'bad' };
    }
    return { ok: false, why: cookieValues(req.headers.cookie, COOKIE_NAMES).length ? 'bad' : 'none' };
  }

  function openStream(req: IncomingMessage, res: ServerResponse, session: SessionInfo | null): void {
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
    let closed = false;
    /** Ticks acumulados enquanto o cliente não lê (só o resumo mais recente + os eventos). */
    let pending: { summary: unknown; events: StoredEvent[] } | null = null;
    let stalledSince: number | null = null;

    const ctl: StreamCtl = {
      res,
      recheck() {
        if (session && !sessions.isValid(session, now())) {
          // Sessão encerrada (logout, "sair de todos" ou expirou): avisa o painel e fecha.
          raw('event: bye\ndata: {}\n\n');
          ctl.close();
        }
      },
      close() {
        if (closed) return;
        closed = true;
        cleanup();
        res.end();
      },
    };
    const kill = () => {
      if (closed) return;
      closed = true;
      cleanup();
      res.destroy();
    };
    /** Escreve respeitando o buffer: cliente que não lê não acumula memória sem limite. */
    const raw = (chunk: string): boolean => {
      if (closed || res.writableEnded || res.destroyed) return false;
      if (res.writableLength > maxBuffered) {
        kill();
        return false;
      }
      res.write(chunk);
      return true;
    };
    /** true = o cliente está atrasado (fila cheia): não manda mais nada até o 'drain'. */
    const congested = (): boolean => {
      if (!res.writableNeedDrain) {
        stalledSince = null;
        return false;
      }
      stalledSince ??= performance.now();
      if (performance.now() - stalledSince > stallMs) kill();
      return true;
    };
    const sendTick = (payload: { summary: unknown; events: StoredEvent[] }) => {
      let s = serialized.get(payload);
      if (s === undefined) {
        s = JSON.stringify(payload);
        serialized.set(payload, s);
      }
      raw(`event: tick\ndata: ${s}\n\n`);
    };

    streams.add(ctl);
    raw('retry: 3000\n\n');
    raw(`event: hello\ndata: ${JSON.stringify({ summary: obs.summary(), events: obs.events.query({ limit: 150 }).reverse() })}\n\n`);
    const listener: TickListener = (payload) => {
      ctl.recheck();
      if (closed) return;
      if (congested() || pending) {
        // Coalesce: guarda só o resumo mais novo e os eventos (limitados) até o cliente voltar a ler.
        pending = { summary: payload.summary, events: [...(pending?.events ?? []), ...payload.events].slice(-500) };
        if (!closed && !res.writableNeedDrain) flushPending();
        return;
      }
      sendTick(payload);
    };
    const flushPending = () => {
      if (!pending || closed) return;
      const p = pending;
      pending = null;
      sendTick(p);
    };
    res.on('drain', () => {
      stalledSince = null;
      flushPending();
    });
    const off = obs.onTick(listener);
    // Comentário periódico para o túnel/proxies não fecharem a conexão ociosa; também confere a
    // sessão e o cliente travado quando não há ticks (jogo fora do ar).
    const hb = setInterval(() => {
      ctl.recheck();
      if (closed || congested()) return;
      raw(': hb\n\n');
    }, opts.heartbeatMs ?? 20_000);
    function cleanup() {
      off();
      clearInterval(hb);
      streams.delete(ctl);
      pending = null;
    }
    req.on('close', () => ctl.close());
    res.on('close', () => ctl.close());
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const html = 'text/html; charset=utf-8';
    if (!sameOrigin(req)) {
      send(res, 403, loginPage('origin'), html);
      return;
    }
    const ip = clientIp(req);
    const t = now();
    const wait = guard.blockedFor(ip, t);
    const local = isDirectLocal(req);
    const limited = () => send(res, 429, loginPage('limited'), html, { 'retry-after': String(wait) });
    if (wait && !local) {
      limited();
      return;
    }
    const body = await readBody(req, 4096);
    const token = body === null ? '' : (new URLSearchParams(body).get('token') ?? '').trim();
    if (!token || !sessions.checkToken(token)) {
      if (wait) {
        limited();
        return;
      }
      // Só as falhas contam: vários aparelhos atrás do mesmo IP podem entrar à vontade.
      guard.fail(ip, t);
      send(res, 401, loginPage('wrong'), html);
      return;
    }
    res.writeHead(303, { ...SECURITY_HEADERS, location: '/', 'set-cookie': sessionCookie(sessions.issue(now()), req), 'cache-control': 'no-store' });
    res.end();
  }

  async function handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) {
      send(res, 403, 'origem recusada', 'text/plain; charset=utf-8');
      return;
    }
    const body = await readBody(req, 1024);
    const all = new URLSearchParams(body ?? '').get('all') === '1';
    const session = sessionOf(req);
    if (session) {
      // O cookie deixa de valer no servidor, não só no navegador (uma cópia dele também morre).
      if (all) sessions.revokeAll();
      else sessions.revoke(session, now());
      for (const s of [...streams]) s.recheck();
    }
    res.writeHead(303, { ...SECURITY_HEADERS, location: '/login', 'set-cookie': clearCookies(req), 'cache-control': 'no-store' }).end();
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
      if (sessionOf(req)) {
        res.writeHead(302, { ...SECURITY_HEADERS, location: '/' }).end();
        return;
      }
      send(res, 200, loginPage('none'), 'text/html; charset=utf-8');
      return;
    }
    if (path === '/logout' && method === 'POST') return handleLogout(req, res);

    // Daqui para baixo, tudo exige autenticação.
    const auth = authenticate(req);
    if (!auth.ok) {
      if (auth.why === 'limited') {
        json(res, 429, { error: 'muitas tentativas' }, { 'retry-after': String(auth.retryAfterS) });
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
          // Lido em fluxo: só os últimos `limit` ficam na memória, qualquer que seja o tamanho do arquivo.
          events = (
            await readDayLast(obs.cfg.dataDir, day, limit, (e) => (!types.length || types.includes(e.type)) && (!before || e.id < before))
          ).reverse();
        } else {
          events = obs.events.query({ limit, types, beforeId: before || undefined });
        }
        json(res, 200, { events });
        return;
      }
      case '/api/stream':
        openStream(req, res, auth.session);
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
    guard,
    sessions,
    closeStreams() {
      for (const s of [...streams]) s.close();
    },
    sseBufferedBytes() {
      let n = 0;
      for (const s of streams) n += s.res.writableLength;
      return n;
    },
    get sseStreams() {
      return streams.size;
    },
  };
}
