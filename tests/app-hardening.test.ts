import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../server/src/app';
import { originLabel } from '../server/src/security';
import { PUBLIC_ORIGIN, httpGet, sleep, startApp, wsClient } from './helpers/app';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
  vi.restoreAllMocks();
});

/**
 * Requisição HTTP entregue direto ao handler com um remoteAddress qualquer: é o único jeito de testar,
 * de ponta a ponta, uma conexão que não vem do loopback sem depender das interfaces da máquina.
 */
function fakeRequest(app: App, remoteAddress: string, headers: Record<string, string>, url = '/health') {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: '' };
  const res = {
    headersSent: false,
    writeHead(status: number, h: Record<string, unknown>) {
      out.status = status;
      out.headers = h;
      this.headersSent = true;
      return this;
    },
    end(b?: Buffer | string) {
      out.body = b === undefined ? '' : String(b);
    },
    destroy() {},
  };
  app.server.emit('request', { socket: { remoteAddress }, headers, method: 'GET', url }, res);
  return out;
}

describe('IP real de ponta a ponta (remoto fora do loopback)', () => {
  it('CF-Connecting-IP forjado vindo da LAN/internet é ignorado: o balde é o do remoto', async () => {
    const s = await startApp({ now: () => 1_000_000 });
    close = s.close;
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push(fakeRequest(s.app, '198.51.100.99', { 'cf-connecting-ip': `203.0.113.${i}` }).status);
    // Se o cabeçalho valesse, cada requisição teria um balde novo e nenhuma levaria 429.
    expect(statuses.slice(0, 60).every((x) => x === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    // Outro remoto segue livre.
    expect(fakeRequest(s.app, '198.51.100.98', {}).status).toBe(200);
  });

  it('cabeçalho da Cloudflare chegando pela LAN: /health mínimo e aviso de túnel mal configurado', async () => {
    const lines: string[] = [];
    const s = await startApp({ log: (l) => lines.push(l) });
    close = s.close;
    const viaLan = fakeRequest(s.app, '192.168.3.40', { 'cf-ray': '8abc-GRU', 'cf-connecting-ip': '203.0.113.5' });
    expect(viaLan.body).toBe('{"ok":true}');
    expect(s.app.security.summary().byKind.cf_header_from_lan).toBe(1);
    expect(lines.some((l) => l.includes('cf_header_from_lan'))).toBe(true);
    // LAN sem cabeçalhos da Cloudflare vê os números e não gera aviso.
    const lan = fakeRequest(s.app, '192.168.3.40', {});
    expect(JSON.parse(lan.body).rooms).toBe(0);
    expect(s.app.security.summary().byKind.cf_header_from_lan).toBe(1);
    // Pelo túnel de verdade (loopback) não é aviso.
    await httpGet(s.port, '/health', { 'cf-connecting-ip': '203.0.113.5', 'cf-ray': 'x' });
    expect(s.app.security.summary().byKind.cf_header_from_lan).toBe(1);
  });
});

describe('404', () => {
  it('build ausente não fica em cache; caminho desconhecido pode ficar', async () => {
    const s = await startApp();
    close = s.close;
    const home = await httpGet(s.port, '/');
    expect(home.status).toBe(404);
    expect(home.body).toContain('Build do cliente');
    expect(home.headers['cache-control']).toBe('no-store');
    const other = await httpGet(s.port, '/nao-existe.png');
    expect(other.status).toBe(404);
    expect(other.headers['cache-control']).toBe('public, max-age=300');
  });
});

describe('timers protegidos', () => {
  it('exceção no sweep não derruba o processo: é contada e o servidor segue atendendo', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await startApp({
      heapMB: () => {
        throw new Error('falha simulada');
      },
      security: { ws: { sweepMs: 20 } },
    });
    close = s.close;
    await sleep(120);
    expect(s.app.security.summary().byKind.timer_error).toBeGreaterThan(1);
    expect(err).toHaveBeenCalled();
    const c = (await wsClient(s.port, { ip: '198.51.100.70', origin: PUBLIC_ORIGIN })).client!;
    c.send({ t: 'hello', name: 'Ok', mode: 'quick' });
    expect((await c.waitFor((m) => m.t === 'lobby')).t).toBe('lobby');
    c.ws.close();
  });
});

describe('originLabel', () => {
  it('nunca devolve o valor cru', () => {
    expect(originLabel(undefined)).toBe('no_origin');
    expect(originLabel('lixo qualquer')).toBe('bad_origin');
    expect(originLabel('ftp://x.example')).toBe('bad_origin');
    expect(originLabel('https://EVIL.example/a?b=c')).toBe('evil.example');
    expect(originLabel(`https://${'a'.repeat(60)}.example`).length).toBe(40);
  });
});

/** Roda o index.ts de verdade (handlers de processo) e devolve o código de saída e a saída. */
function runIndex(env: Record<string, string>, onOut?: (text: string, kill: (sig: NodeJS.Signals) => void) => void) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
      env: { ...process.env, PUBLIC_DIR: '/nao-existe', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const feed = (d: Buffer) => {
      out += String(d);
      onOut?.(out, (sig) => child.kill(sig));
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

describe('processo (index.ts)', () => {
  it('porta ocupada (EADDRINUSE) → loga fatal e sai com 1', async () => {
    const busy: Server = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
    const port = (busy.address() as AddressInfo).port;
    try {
      const r = await runIndex({ PORT: String(port), HOST: '127.0.0.1' });
      expect(r.code).toBe(1);
      expect(r.out).toContain('"ev":"fatal"');
      expect(r.out).toContain('EADDRINUSE');
    } finally {
      busy.close();
    }
  }, 30_000);

  it('SIGTERM → encerra limpo com 0', async () => {
    let sent = false;
    const r = await runIndex({ PORT: '0', HOST: '127.0.0.1' }, (out, kill) => {
      if (!sent && out.includes('ouvindo')) {
        sent = true;
        kill('SIGTERM');
      }
    });
    expect(sent).toBe(true);
    expect(r.code).toBe(0);
  }, 30_000);
});
