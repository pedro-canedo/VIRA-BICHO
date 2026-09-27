// Endpoint interno do observador: GET /internal/stats?since=<seq> (contrato em shared/src/obs.ts).
// Servidor HTTP próprio, só em 127.0.0.1 e fora do servidor público: o túnel da Cloudflare aponta
// para a porta 3000 e nunca chega aqui. Exige o cabeçalho x-obs-token (comparação em tempo constante).
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OBS_INTERNAL_DEFAULT_URL, OBS_STATS_PATH, OBS_TOKEN_HEADER, type ObsStats } from '@vb/shared';
import { TokenBucket, isLoopback, normalizeIp, type Rate } from './security';
import { parseRequestTarget } from './static';

/** Tamanho mínimo do OBS_INTERNAL_TOKEN: abaixo disso o endpoint não sobe. */
export const OBS_MIN_TOKEN_LENGTH = 16;
/** Porta padrão, a mesma do endereço padrão que o observador usa (GAME_INTERNAL_URL). */
export const OBS_INTERNAL_PORT = Number(new URL(OBS_INTERNAL_DEFAULT_URL).port);
/** O endpoint só escuta aqui; não há opção de host. */
export const OBS_INTERNAL_HOST = '127.0.0.1';

export interface InternalOptions {
  token: string;
  snapshot: (since: number) => ObsStats;
  now?: () => number;
  log?: (line: string) => void;
  /** Requisições autenticadas (padrão 20 de uma vez, recarga de 5/s). */
  rate?: Rate;
  /**
   * Requisições sem o token certo, num balde à parte (padrão: o mesmo de `rate`). Assim um processo
   * local sem o token não consegue esgotar o balde do observador e deixá-lo sem dados.
   */
  failRate?: Rate;
}

/** Motivo para não subir o endpoint (null = pode subir). Nunca inclui o valor do token. */
export function tokenProblem(token: string | undefined): string | null {
  if (token === undefined || token.trim() === '') return 'sem OBS_INTERNAL_TOKEN';
  if (token.length < OBS_MIN_TOKEN_LENGTH) return `OBS_INTERNAL_TOKEN com menos de ${OBS_MIN_TOKEN_LENGTH} caracteres`;
  return null;
}

/** Valor de ?since=: ausente = 0; qualquer coisa que não seja inteiro >= 0 é null (400). */
export function parseSince(query: string): number | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(query).get('since');
  } catch {
    return null;
  }
  if (raw === null || raw === '') return 0;
  if (!/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

const HEADERS = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

function reply(res: ServerResponse, status: number, body: string, json = false): void {
  const buf = Buffer.from(body);
  res.writeHead(status, {
    ...HEADERS,
    'content-type': json ? 'application/json' : 'text/plain; charset=utf-8',
    'content-length': buf.length,
  });
  res.end(buf);
}

/** Cria o servidor (sem listen). O token precisa passar por tokenProblem antes. */
export function createInternalServer(o: InternalOptions): Server {
  if (tokenProblem(o.token) !== null) throw new Error('OBS_INTERNAL_TOKEN inválido');
  const now = o.now ?? Date.now;
  const log = o.log ?? ((line: string) => console.log(line));
  // Compara digests de tamanho fixo: o tempo não depende do conteúdo nem do tamanho do valor enviado.
  const expected = createHash('sha256').update(o.token, 'utf8').digest();
  const tokenOk = (v: string | string[] | undefined): boolean => {
    if (typeof v !== 'string') return false;
    const got = createHash('sha256').update(v, 'utf8').digest();
    return timingSafeEqual(got, expected);
  };
  const rate = o.rate ?? { capacity: 20, refillPerSec: 5 };
  const failRate = o.failRate ?? rate;
  const okBucket = new TokenBucket(rate.capacity, rate.refillPerSec, now());
  const failBucket = new TokenBucket(failRate.capacity, failRate.refillPerSec, now());
  let lastAuthLog = -Infinity;
  let authFails = 0;

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // Defesa em profundidade: só processos do próprio aparelho, nunca algo repassado pelo túnel ou proxy.
    const remote = normalizeIp(req.socket.remoteAddress ?? '');
    const h = req.headers;
    if (!isLoopback(remote) || h['cf-connecting-ip'] !== undefined || h['cf-ray'] !== undefined || h['x-forwarded-for'] !== undefined) {
      return reply(res, 403, 'Forbidden');
    }
    if (req.method !== 'GET') return reply(res, 405, 'Method not allowed');
    // A autenticação vem antes do limite (o SHA-256 é barato), e cada lado tem o seu balde.
    const authed = tokenOk(h[OBS_TOKEN_HEADER]);
    if (!(authed ? okBucket : failBucket).take(now())) return reply(res, 429, 'Too many requests');
    const target = parseRequestTarget(req.url, 256);
    if (target === null) return reply(res, 400, 'Bad request');
    if (target === 'too_long') return reply(res, 414, 'URI too long');
    if (!authed) {
      authFails++;
      const t = now();
      if (t - lastAuthLog >= 60_000) {
        lastAuthLog = t;
        log(JSON.stringify({ t, ev: 'obs_internal_unauthorized', n: authFails }));
        authFails = 0;
      }
      return reply(res, 401, 'Unauthorized');
    }
    if (target.path !== OBS_STATS_PATH) return reply(res, 404, 'Not found');
    const since = parseSince(target.query);
    if (since === null) return reply(res, 400, 'Bad since');
    reply(res, 200, JSON.stringify(o.snapshot(since)), true);
  }

  const server = createServer(
    { headersTimeout: 5_000, requestTimeout: 5_000, keepAliveTimeout: 2_000, connectionsCheckingInterval: 2_000, maxHeaderSize: 8_192 },
    (req, res) => {
      try {
        handle(req, res);
      } catch (err) {
        log(JSON.stringify({ t: now(), ev: 'obs_internal_error', err: String((err as Error)?.name ?? 'Error').slice(0, 40) }));
        if (!res.headersSent) reply(res, 500, 'Internal error');
        else res.destroy();
      }
    },
  );
  server.maxHeadersCount = 30;
  server.maxConnections = 16;
  // Erros do listen (EADDRINUSE etc.) chegam pelo reject de listenInternal e são registrados por quem
  // chamou; aqui só os que acontecem com o servidor já no ar (um registro por erro).
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (server.listening) log(JSON.stringify({ t: now(), ev: 'obs_internal_server_error', code: err.code ?? String(err.name) }));
  });
  return server;
}

/** Escuta só em 127.0.0.1. Resolve com a porta (útil com port 0 nos testes). */
export function listenInternal(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, OBS_INTERNAL_HOST, () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
