import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { BALANCE, WS_PATH, type ClientMsg, type ServerMsg } from '@vb/shared';
import type { Conn } from './entities';
import { Lobby } from './lobby';

const PORT = Number(process.env.PORT ?? 3000);
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR ?? join(HERE, 'public'));
const STARTED = Date.now();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const lobby = new Lobby();

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    const mem = process.memoryUsage();
    res.end(JSON.stringify({ ok: true, uptimeS: Math.round((Date.now() - STARTED) / 1000), rssMB: Math.round(mem.rss / 1048576), ...lobby.stats() }));
    return;
  }
  let file = normalize(join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(PUBLIC_DIR, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end('Build do cliente não encontrado.');
    return;
  }
  const hashed = file.includes(`${join(PUBLIC_DIR, 'assets')}`);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: 4096 });
const alive = new WeakMap<WebSocket, boolean>();

wss.on('connection', (ws) => {
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));
  const conn: Conn = {
    send(msg: ServerMsg) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  let budget = 40;
  ws.on('message', (data) => {
    if (--budget < 0) return; // limite simples de mensagens por segundo
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    lobby.handle(conn, msg, Date.now());
  });
  const refill = setInterval(() => (budget = 40), 1000);
  ws.on('close', () => {
    clearInterval(refill);
    lobby.disconnect(conn);
  });
});

// Mantém as conexões vivas atrás do túnel e derruba as que sumiram.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.get(ws)) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 20_000);

setInterval(() => lobby.tick(Date.now()), BALANCE.tickMs);

server.listen(PORT, () => {
  console.log(`VIRA-BICHO ouvindo na porta ${PORT} (arquivos em ${PUBLIC_DIR})`);
});
