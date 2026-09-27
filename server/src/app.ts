import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { BALANCE, WS_PATH, parseClientMsg, type ServerMsg } from '@vb/shared';
import type { Conn } from './entities';
import { Lobby } from './lobby';
import {
  DEFAULT_ORIGINS,
  KeyedBuckets,
  SecurityLog,
  SlidingWindow,
  TokenBucket,
  clientId,
  ipKey,
  isTrustedLocal,
  netKey,
  normalizeIp,
  originAllowed,
  originLabel,
  resolveSecurity,
  type DeepPartial,
  type SecKind,
  type SecurityConfig,
} from './security';
import { loadStatic, parseRequestTarget } from './static';

export interface AppOptions {
  publicDir: string;
  security?: DeepPartial<SecurityConfig>;
  /** Somados ao padrão (domínios públicos do jogo). */
  allowedOrigins?: string[];
  /** Chaves (IPs) isentas dos limites por IP, para teste de carga pela LAN. */
  trustedKeys?: string[];
  now?: () => number;
  /** RSS em MB, só para o /health. */
  rssMB?: () => number;
  /** Heap usado em MB: a guarda de memória compara com heapRejectMB. */
  heapMB?: () => number;
  log?: (line: string) => void;
}

export interface App {
  server: Server;
  wss: WebSocketServer;
  lobby: Lobby;
  security: SecurityLog;
  close(): Promise<void>;
}

interface ConnState {
  key: string;
  conn: Conn;
  openedAt: number;
  sawHello: boolean;
  lastHelloAt: number;
  /** Já esteve numa sala nesta conexão (ganha o prazo longo fora de sala). */
  everInRoom: boolean;
  /** Último move/target/act (prazo de ociosidade dentro da partida). */
  lastCmdAt: number;
  /** Desde quando está fora de sala (null = em sala). */
  outSince: number | null;
  bucket: TokenBucket;
  /** Frames ping/pong vindos do cliente. */
  ctrl: TokenBucket;
  drops: SlidingWindow;
  invalid: SlidingWindow;
}

/** O mínimo do WebSocket que o envio usa (facilita testar sem rede). */
export interface SendTarget {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  terminate(): void;
}

/** Envio com backpressure: pula snapshots com buffer cheio e derruba quem não consome. */
export function makeSender(ws: SendTarget, cfg: SecurityConfig['ws']['backpressure'], onEvent: (kind: SecKind) => void): Conn['send'] {
  return (msg: ServerMsg) => {
    if (ws.readyState !== ws.OPEN) return;
    const buffered = ws.bufferedAmount;
    if (buffered > cfg.terminateBytes) {
      onEvent('ws_slow_consumer');
      ws.terminate();
      return;
    }
    if (buffered > cfg.skipSnapBytes && msg.t === 'snap') return; // o próximo snap substitui
    ws.send(JSON.stringify(msg));
  };
}

/** Corpo do /health: mínimo para o público, detalhado para a LAN, nunca com códigos de sala. */
export function healthPayload(
  trusted: boolean,
  lobby: Pick<Lobby, 'stats'>,
  extra: { uptimeS: number; rssMB: number; conns: number; security: unknown },
): string {
  if (!trusted) return '{"ok":true}';
  const { rooms, privateRooms, players } = lobby.stats();
  return JSON.stringify({ ok: true, uptimeS: extra.uptimeS, rssMB: extra.rssMB, rooms, privateRooms, players, conns: extra.conns, security: extra.security });
}

const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${DEFAULT_ORIGINS.map((o) => o.replace('https://', 'wss://')).join(' ')}`,
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
].join('; ');
const HTML_HEADERS = {
  'x-frame-options': 'DENY',
  // Só o que não quebra o jogo; a política completa fica em Report-Only até o cliente parar de usar style inline.
  'content-security-policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  'content-security-policy-report-only': CSP_REPORT_ONLY,
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
};

/** Recusa um upgrade direto no socket, antes de virar WebSocket. */
function rejectUpgrade(socket: Duplex, code: number, reason: string, extra = ''): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
}

/** Monta o servidor HTTP + WebSocket sem chamar listen (testável numa porta qualquer). */
export function createApp(opts: AppOptions): App {
  const cfg = resolveSecurity(opts.security);
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));
  const rssMB = opts.rssMB ?? (() => process.memoryUsage.rss() / 1048576);
  const heapMB = opts.heapMB ?? (() => process.memoryUsage().heapUsed / 1048576);
  const allow = new Set([...DEFAULT_ORIGINS, ...(opts.allowedOrigins ?? [])].map((o) => o.trim().toLowerCase().replace(/\/$/, '')).filter(Boolean));
  const trusted = new Set((opts.trustedKeys ?? []).map((k) => normalizeIp(k)).filter(Boolean).map((k) => (isIP(k) ? ipKey(k) : k)));
  const isExempt = (key: string) => key === 'local' || trusted.has(key);
  const started = now();

  const security = new SecurityLog({ now, write: log, throttleMs: cfg.log.throttleMs, summaryMs: cfg.log.summaryMs });
  const lobby = new Lobby({ limits: cfg.lobby, game: cfg.game, isExempt, onSecurity: (kind, key, d) => security.event(kind, key, d) });
  const files = loadStatic(opts.publicDir);
  const httpBuckets = new KeyedBuckets(cfg.http.rate.capacity, cfg.http.rate.refillPerSec, cfg.keys.maxTracked);
  const handshakeBuckets = new KeyedBuckets(cfg.ws.handshake.capacity, cfg.ws.handshake.refillPerSec, cfg.keys.maxTracked);
  const handshakeNetBuckets = new KeyedBuckets(cfg.ws.handshakeNet.capacity, cfg.ws.handshakeNet.refillPerSec, cfg.keys.maxTracked);
  /** Conexões abertas por chave e por bloco /48 IPv6 (contagem exata). */
  const perKey = new Map<string, number>();
  const perNet = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, d: number) => {
    const n = (m.get(k) ?? 0) + d;
    if (n <= 0) m.delete(k);
    else m.set(k, n);
  };
  const states = new Map<WebSocket, ConnState>();
  const alive = new WeakMap<WebSocket, boolean>();
  let memGuard = false;

  // ---------------------------------------------------------------- HTTP

  function reply(res: ServerResponse, status: number, headers: OutgoingHttpHeaders, body: string | Buffer, head: boolean): void {
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    res.writeHead(status, { ...BASE_HEADERS, 'content-length': buf.length, ...headers });
    res.end(head ? undefined : buf);
  }

  /** Cabeçalho da Cloudflare vindo de fora do loopback: ingress do túnel apontando para o IP da LAN. */
  function checkTunnel(req: IncomingMessage, id: { key: string; viaCloudflare: boolean }): void {
    if (id.viaCloudflare || id.key === 'local') return;
    if (req.headers['cf-ray'] !== undefined || req.headers['cf-connecting-ip'] !== undefined) security.event('cf_header_from_lan', id.key);
  }

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const id = clientId(req.socket.remoteAddress, req.headers);
    checkTunnel(req, id);
    const head = req.method === 'HEAD';
    const text = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
    if (!isExempt(id.key) && !httpBuckets.take(id.key, now())) {
      security.event('http_rate_limited', id.key);
      return reply(res, 429, { ...text, 'retry-after': '5' }, 'Too many requests', head);
    }
    if (req.method !== 'GET' && !head) {
      security.event('http_405', id.key, req.method);
      return reply(res, 405, { ...text, allow: 'GET, HEAD' }, 'Method not allowed', head);
    }
    const target = parseRequestTarget(req.url, cfg.http.maxUrlLength);
    if (target === null) {
      security.event('http_error', id.key, 'bad_target');
      return reply(res, 400, text, 'Bad request', head);
    }
    if (target === 'too_long') return reply(res, 414, text, 'URI too long', head);

    if (target.path === '/health') {
      const body = healthPayload(isTrustedLocal(req.socket.remoteAddress, req.headers), lobby, {
        uptimeS: Math.round((now() - started) / 1000),
        rssMB: Math.round(rssMB()),
        conns: wss.clients.size,
        security: security.summary(),
      });
      return reply(res, 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }, body, head);
    }

    const path = target.path === '/' ? '/index.html' : target.path;
    const file = files.get(path);
    const notFound = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' };
    // Falha de implantação: não pode ficar em cache depois de corrigida.
    if (path === '/index.html' && !file) return reply(res, 404, text, 'Build do cliente não encontrado.', head);
    // Asset com query é cache-busting: sairia do celular a cada requisição.
    if (!file || (path.startsWith('/assets/') && target.query !== '')) return reply(res, 404, notFound, 'Não encontrado.', head);

    const headers: OutgoingHttpHeaders = { 'content-type': file.type, 'cache-control': file.cacheControl, etag: file.etag };
    if (file.type.startsWith('text/html')) {
      Object.assign(headers, HTML_HEADERS);
      const visitor = req.headers['cf-visitor'];
      if (id.viaCloudflare && typeof visitor === 'string' && visitor.includes('"https"')) headers['strict-transport-security'] = 'max-age=15552000';
    }
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, { ...BASE_HEADERS, ...headers });
      res.end();
      return;
    }
    reply(res, 200, headers, file.body, head);
  }

  const server = createServer(
    {
      headersTimeout: cfg.http.headersTimeoutMs,
      requestTimeout: cfg.http.requestTimeoutMs,
      connectionsCheckingInterval: cfg.http.checkIntervalMs,
    },
    (req, res) => {
      try {
        handleHttp(req, res);
      } catch (err) {
        security.event('http_error', clientId(req.socket.remoteAddress, req.headers).key, (err as Error)?.name);
        if (!res.headersSent) res.writeHead(400, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('Bad request');
        else res.destroy();
      }
    },
  );
  server.maxHeadersCount = cfg.http.maxHeadersCount;
  server.maxConnections = cfg.http.maxConnections;
  // EMFILE no accept e afins não podem derrubar o processo.
  server.on('error', (err: NodeJS.ErrnoException) => log(JSON.stringify({ t: now(), ev: 'http_server_error', code: err.code ?? String(err.name) })));

  // ---------------------------------------------------------------- WebSocket

  // autoPong desligado: o ping do cliente passa pelo balde de frames de controle (ver onConnection).
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.ws.maxPayloadBytes, perMessageDeflate: false, autoPong: false });
  wss.on('error', (err) => log(JSON.stringify({ t: now(), ev: 'wss_error', err: String(err).slice(0, 200) })));

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // O Node tira o listener de erro do socket no upgrade.
    socket.on('error', () => socket.destroy());
    try {
      const target = parseRequestTarget(req.url, cfg.http.maxUrlLength);
      if (!target || target === 'too_long' || target.path !== WS_PATH) return rejectUpgrade(socket, 404, 'Not Found');
      const id = clientId(req.socket.remoteAddress, req.headers);
      checkTunnel(req, id);
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      if (!originAllowed(origin, id.viaCloudflare, allow)) {
        security.event('ws_origin_rejected', id.key, originLabel(origin));
        return rejectUpgrade(socket, 403, 'Forbidden');
      }
      if (memGuard) {
        security.event('ws_mem_guard', id.key);
        return rejectUpgrade(socket, 503, 'Service Unavailable');
      }
      if (wss.clients.size >= cfg.ws.maxClients) {
        security.event('ws_server_full', id.key);
        return rejectUpgrade(socket, 503, 'Service Unavailable');
      }
      if (!isExempt(id.key)) {
        const net = netKey(id.key);
        const t = now();
        if (!handshakeBuckets.take(id.key, t) || (net !== null && !handshakeNetBuckets.take(net, t))) {
          security.event('ws_handshake_rate', id.key);
          return rejectUpgrade(socket, 429, 'Too Many Requests', 'Retry-After: 10\r\n');
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, id.key));
    } catch (err) {
      security.event('http_error', 'upgrade', (err as Error)?.name);
      socket.destroy();
    }
  });

  /**
   * Fecha com código e, se o peer não responder ao close frame, derruba o socket depois de closeGraceMs
   * (sem isso a conexão ficaria em CLOSING por até 30 s, ocupando vaga e aceitando frames).
   */
  function closeHard(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.close(code, reason);
    const timer = setTimeout(() => ws.terminate(), cfg.ws.closeGraceMs);
    timer.unref?.();
    ws.once('close', () => clearTimeout(timer));
  }

  function onConnection(ws: WebSocket, key: string): void {
    ws.on('error', (err) => {
      security.event('ws_error', key, (err as NodeJS.ErrnoException).code);
      ws.terminate();
    });
    const net = netKey(key);
    // Acima do limite por rede: o navegador não vê o status do handshake, então avisa por mensagem.
    if (!isExempt(key)) {
      const overKey = (perKey.get(key) ?? 0) >= cfg.ws.maxPerIp;
      const overNet = net !== null && (perNet.get(net) ?? 0) >= cfg.ws.maxPerNet;
      if (overKey || overNet) {
        security.event(overKey ? 'ws_ip_limit' : 'ws_net_limit', key);
        ws.send(JSON.stringify({ t: 'error', msg: 'Muitas conexões vindas da sua rede. Feche outras abas do jogo e tente de novo.' } satisfies ServerMsg));
        closeHard(ws, 4029, 'conexoes demais');
        return;
      }
    }
    bump(perKey, key, 1);
    if (net !== null) bump(perNet, net, 1);
    const t0 = now();
    const conn: Conn = { key, send: makeSender(ws, cfg.ws.backpressure, (kind) => security.event(kind, key)) };
    const abuse = cfg.ws.abuse;
    const st: ConnState = {
      key,
      conn,
      openedAt: t0,
      sawHello: false,
      lastHelloAt: t0,
      everInRoom: false,
      lastCmdAt: t0,
      outSince: t0,
      bucket: new TokenBucket(cfg.ws.msg.capacity, cfg.ws.msg.refillPerSec, t0),
      ctrl: new TokenBucket(cfg.ws.ctrl.capacity, cfg.ws.ctrl.refillPerSec, t0),
      drops: new SlidingWindow(abuse.windowMs, abuse.maxDropped),
      invalid: new SlidingWindow(abuse.windowMs, abuse.maxInvalid),
    };
    states.set(ws, st);
    alive.set(ws, true);

    /** Frame descartado pelo rate limit; muitos na janela fecham a conexão. */
    const dropped = (t: number, detail?: string) => {
      security.event('ws_rate_limited', key, detail);
      if (st.drops.hit('', t) >= abuse.maxDropped) {
        security.event('ws_abuse_closed', key, detail);
        closeHard(ws, 1008, 'rate limit');
      }
    };

    // Ping e pong do cliente também custam: sem isso, um flood de pings viraria pongs de graça no uplink.
    ws.on('ping', (data) => {
      if (ws.readyState !== ws.OPEN) return;
      const t = now();
      if (st.ctrl.take(t)) ws.pong(data);
      else dropped(t, 'ctrl');
    });
    ws.on('pong', () => {
      alive.set(ws, true);
      if (ws.readyState !== ws.OPEN) return;
      const t = now();
      if (!st.ctrl.take(t)) dropped(t, 'ctrl');
    });

    ws.on('message', (data, isBinary) => {
      if (ws.readyState !== ws.OPEN) return;
      const t = now();
      if (!st.bucket.take(t)) {
        // Descarta em silêncio: um 'error' tiraria o cliente do lobby sem sair da sala.
        dropped(t);
        return;
      }
      let parsed: unknown;
      if (!isBinary) {
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          parsed = undefined;
        }
      }
      const msg = parseClientMsg(parsed);
      if (!msg) {
        security.event('ws_invalid_msg', key);
        if (st.invalid.hit('', t) >= abuse.maxInvalid) closeHard(ws, 1008, 'mensagens invalidas');
        return;
      }
      if (msg.t === 'hello') {
        st.sawHello = true;
        st.lastHelloAt = t;
      } else if (msg.t === 'move' || msg.t === 'target' || msg.t === 'act') st.lastCmdAt = t;
      try {
        lobby.handle(conn, msg, t);
        if (msg.t === 'hello' && lobby.roomOf(conn)) st.everInRoom = true;
      } catch (err) {
        security.event('handle_error', key, msg.t);
        console.error(String((err as Error)?.stack ?? err).slice(0, 2000));
        closeHard(ws, 1011, 'erro interno');
      }
    });

    ws.on('close', () => {
      states.delete(ws);
      bump(perKey, key, -1);
      if (net !== null) bump(perNet, net, -1);
      try {
        lobby.disconnect(conn, now());
      } catch (err) {
        console.error(String((err as Error)?.stack ?? err).slice(0, 2000));
      }
    });
  }

  // ---------------------------------------------------------------- timers

  /** Prazos por conexão e guarda de memória. */
  const sweepConns = () => {
    const t = now();
    // Heap e não RSS: o V8 não devolve RSS depois de um pico, e é o heap que mata o processo (--max-old-space-size).
    const heap = heapMB();
    if (heap > cfg.ws.heapRejectMB) memGuard = true;
    else if (heap < cfg.ws.heapRejectMB * 0.9) memGuard = false;
    for (const [ws, st] of states) {
      if (ws.readyState !== ws.OPEN) continue;
      if (!st.sawHello && t - st.openedAt > cfg.ws.helloTimeoutMs) {
        security.event('ws_hello_timeout', st.key);
        closeHard(ws, 4001, 'hello timeout');
        continue;
      }
      const room = lobby.roomOf(st.conn);
      if (room) {
        // Dentro de sala só fecha quem está vivo e parado na partida; o heartbeat cuida das conexões mortas.
        st.outSince = null;
        st.everInRoom = true;
        const p = lobby.playerOf(st.conn);
        // Chaves isentas (teste de carga pela LAN) ficam de fora: clientes sintéticos podem ficar parados.
        if (p?.alive && !isExempt(st.key) && t - Math.max(st.lastCmdAt, room.startedAt) > cfg.ws.idleInPlayMs) {
          security.event('ws_idle_in_play', st.key);
          closeHard(ws, 4003, 'parado na partida');
        }
        continue;
      }
      if (!st.everInRoom) {
        // Nunca entrou numa sala (código errado, servidor cheio...): prazo curto a partir do último hello.
        if (st.sawHello && t - st.lastHelloAt > cfg.ws.idleNeverJoinedMs) {
          security.event('ws_idle_timeout', st.key);
          closeHard(ws, 4002, 'ocioso');
        }
        continue;
      }
      if (st.outSince === null) st.outSince = t;
      else if (t - st.outSince > cfg.ws.idleNoRoomMs) {
        security.event('ws_idle_timeout', st.key);
        closeHard(ws, 4002, 'ocioso');
      }
    }
    security.tick(t);
  };

  /** Heartbeat: mantém as conexões vivas atrás do túnel e derruba as que sumiram. */
  const heartbeat = () => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  };

  /** Uma exceção num timer não pode virar uncaughtException (que derruba todas as partidas). */
  const guarded = (name: string, fn: () => void) => () => {
    try {
      fn();
    } catch (err) {
      security.event('timer_error', 'server', name);
      console.error(`[timer ${name}]`, String((err as Error)?.stack ?? err).slice(0, 2000));
    }
  };

  const timers = [
    setInterval(guarded('tick', () => lobby.tick(now())), BALANCE.tickMs),
    setInterval(guarded('heartbeat', heartbeat), cfg.ws.heartbeatMs),
    setInterval(guarded('sweep_conns', sweepConns), cfg.ws.sweepMs),
    setInterval(
      guarded('sweep_keys', () => {
        const t = now();
        httpBuckets.sweep(t);
        handshakeBuckets.sweep(t);
        handshakeNetBuckets.sweep(t);
        lobby.sweep(t);
      }),
      cfg.keys.sweepMs,
    ),
  ];

  return {
    server,
    wss,
    lobby,
    security,
    async close() {
      for (const t of timers) clearInterval(t);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
