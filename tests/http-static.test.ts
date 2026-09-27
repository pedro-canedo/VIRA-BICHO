import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadStatic } from '../server/src/static';
import { httpGet, rawHttp, startApp, within } from './helpers/app';

let root: string;
let pub: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'vb-static-'));
  pub = join(root, 'public');
  mkdirSync(join(pub, 'assets'), { recursive: true });
  mkdirSync(join(root, 'public-x'));
  writeFileSync(join(pub, 'index.html'), '<!doctype html><title>jogo</title>');
  writeFileSync(join(pub, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(pub, 'assets', 'app-abc.js'), 'console.log(1)');
  writeFileSync(join(pub, '.env'), 'SEGREDO=1');
  writeFileSync(join(root, 'public-x', 'segredo.txt'), 'segredo');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function boot(over: Parameters<typeof startApp>[0] = {}) {
  const s = await startApp({ publicDir: pub, ...over });
  close = s.close;
  return s;
}

describe('estáticos em memória', () => {
  it('serve o index com cabeçalhos de segurança', async () => {
    const { port } = await boot();
    const r = await httpGet(port, '/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy-report-only']).toContain("default-src 'self'");
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['strict-transport-security']).toBeUndefined();
    expect((await httpGet(port, '/?sala=ABCD')).body).toContain('jogo');

    const etag = r.headers.etag as string;
    expect((await httpGet(port, '/', { 'if-none-match': etag })).status).toBe(304);
  });

  it('assets com cache imutável, sem query e sem fallback de SPA', async () => {
    const { port } = await boot();
    const a = await httpGet(port, '/assets/app-abc.js');
    expect(a.status).toBe(200);
    expect(a.headers['cache-control']).toContain('immutable');
    expect((await httpGet(port, '/assets/app-abc.js?x=1')).status).toBe(404);
    for (const p of ['/assets/nao-existe.js', '/.env', '/wp-login.php']) {
      const r = await httpGet(port, p);
      expect(r.status).toBe(404);
      expect(r.body).not.toContain('jogo');
    }
  });

  it('só GET e HEAD', async () => {
    const { port } = await boot();
    const post = await httpGet(port, '/', {}, 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    const head = await rawHttp(port, '/', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('nunca sai do diretório público', async () => {
    const { port } = await boot();
    for (const t of ['/..%2fpublic-x/segredo.txt', '/%2e%2e/public-x/segredo.txt', '/../public-x/segredo.txt', '/assets/..%2f..%2fpublic-x/segredo.txt']) {
      const r = await rawHttp(port, t);
      expect(r.status).not.toBe(200);
      expect(r.body).not.toContain('segredo');
    }
    expect((await rawHttp(port, '/' + 'a'.repeat(3000))).status).toBe(414);
  });

  it('serve da memória (apagar o arquivo depois do boot não muda nada)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vb-static-mem-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), 'x');
    writeFileSync(join(dir, 'assets', 'app-abc.js'), 'y');
    const { port } = await boot({ publicDir: dir });
    rmSync(dir, { recursive: true, force: true });
    const r = await httpGet(port, '/assets/app-abc.js');
    expect(r.status).toBe(200);
    expect(r.body).toBe('y');
  });

  it('loadStatic ignora dotfiles e diretório inexistente vira vazio', () => {
    const files = loadStatic(pub);
    expect([...files.keys()].sort()).toEqual(['/assets/app-abc.js', '/favicon.svg', '/index.html']);
    expect(files.get('/index.html')!.cacheControl).toBe('no-cache');
    expect(files.get('/favicon.svg')!.cacheControl).toBe('public, max-age=3600');
    expect(loadStatic(join(root, 'nao-existe')).size).toBe(0);
  });
});

describe('rate limit e HSTS', () => {
  it('estoura por IP com 429, sem afetar outros IPs nem a rede local', async () => {
    const { port } = await boot({ security: { http: { rate: { capacity: 5, refillPerSec: 0 } } } });
    for (let i = 0; i < 5; i++) expect((await httpGet(port, '/', { 'cf-connecting-ip': '203.0.113.5' })).status).toBe(200);
    const r = await httpGet(port, '/', { 'cf-connecting-ip': '203.0.113.5' });
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('5');
    expect((await httpGet(port, '/', { 'cf-connecting-ip': '203.0.113.6' })).status).toBe(200);
    for (let i = 0; i < 8; i++) expect((await httpGet(port, '/')).status).toBe(200);
  });

  it('HSTS só quando veio por HTTPS pela Cloudflare', async () => {
    const { port } = await boot();
    expect((await httpGet(port, '/', { 'cf-connecting-ip': '203.0.113.5' })).headers['strict-transport-security']).toBeUndefined();
    const r = await httpGet(port, '/', { 'cf-connecting-ip': '203.0.113.5', 'cf-visitor': '{"scheme":"https"}' });
    expect(r.headers['strict-transport-security']).toBe('max-age=15552000');
  });
});

describe('timeouts do servidor', () => {
  it('usa os limites padrão', async () => {
    const { app } = await boot();
    expect(app.server.headersTimeout).toBe(10_000);
    expect(app.server.requestTimeout).toBe(15_000);
    expect(app.server.maxConnections).toBe(1000);
    expect(app.server.maxHeadersCount).toBe(100);
  });

  it('derruba quem manda cabeçalhos devagar (slowloris)', async () => {
    const { port } = await boot({ security: { http: { headersTimeoutMs: 200, requestTimeoutMs: 300, checkIntervalMs: 50 } } });
    const sock = connect(port, '127.0.0.1');
    sock.on('error', () => {});
    sock.on('data', () => {});
    sock.write('GET / HTTP/1.1\r\nHost: x\r\n');
    const closed = new Promise((r) => sock.on('close', r));
    expect(await within(closed, 1500)).not.toBe('timeout');
  });
});
