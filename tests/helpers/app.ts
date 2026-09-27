import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { ServerMsg } from '@vb/shared';
import { createApp, type App, type AppOptions } from '../../server/src/app';

export const PUBLIC_ORIGIN = 'https://virabicho.caixazen.online';

/** Sobe o app real numa porta livre de 127.0.0.1. */
export async function startApp(over: Partial<AppOptions> = {}): Promise<{ app: App; port: number; close: () => Promise<void> }> {
  const app = createApp({ publicDir: join(tmpdir(), 'vb-sem-build-inexistente'), log: () => {}, ...over });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const port = (app.server.address() as AddressInfo).port;
  return { app, port, close: () => app.close() };
}

export interface WsOpts {
  /** Vira o cabeçalho cf-connecting-ip (conexão vem de loopback, como pelo túnel). */
  ip?: string;
  origin?: string;
  headers?: Record<string, string>;
  path?: string;
}

export interface TestClient {
  ws: WebSocket;
  msgs: ServerMsg[];
  closed: Promise<{ code: number; reason: string }>;
  /** Espera uma mensagem que satisfaça o filtro (inclusive as já recebidas). */
  waitFor(pred: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg>;
  send(obj: unknown): void;
}

/** Abre um cliente ws; resolve com o socket aberto ou com o status HTTP da recusa. */
export function wsClient(port: number, o: WsOpts = {}): Promise<{ client?: TestClient; status?: number; error?: Error }> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.ip) headers['cf-connecting-ip'] = o.ip;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${o.path ?? '/ws'}`, { headers, origin: o.origin });
  const msgs: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as ServerMsg;
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
  const client: TestClient = {
    ws,
    msgs,
    closed,
    waitFor(pred, ms = 2000) {
      const found = msgs.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('mensagem não chegou')), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    send(obj) {
      ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    },
  };
  return new Promise((resolve) => {
    ws.once('open', () => resolve({ client }));
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode });
      res.resume();
      ws.terminate();
    });
    ws.once('error', (error) => resolve({ error }));
  });
}

/** Resultado de uma corrida com prazo. */
export function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Requisição crua (sem normalizar o alvo). Devolve status, cabeçalhos em minúsculas e corpo. */
export function rawHttp(port: number, requestTarget: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, string>; body: string; raw: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1');
    let raw = '';
    sock.setEncoding('latin1');
    sock.on('data', (d) => (raw += d));
    sock.on('error', reject);
    sock.on('close', () => {
      const [head, ...rest] = raw.split('\r\n\r\n');
      const lines = head.split('\r\n');
      const status = Number(lines[0]?.split(' ')[1] ?? 0);
      const h: Record<string, string> = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':');
        if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      resolve({ status, headers: h, body: rest.join('\r\n\r\n'), raw });
    });
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    sock.write(`${method} ${requestTarget} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${extra}\r\n`);
  });
}

/** GET normal pelo cliente http do Node. */
export function httpGet(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
