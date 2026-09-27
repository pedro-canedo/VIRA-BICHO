import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoginGuard, Sessions, clientIp, isDirectLocal, isHttps, rateKey } from '../observer/src/auth';
import { loadConfig } from '../observer/src/config';
import { escapeLabel } from '../observer/src/metrics';
import { Observer } from '../observer/src/observer';
import { createObsServer, sameOrigin, type ObsServer } from '../observer/src/server';
import { startFakeGame, type FakeGame } from './helpers/fake-game';

const TOKEN = 'painel-'.padEnd(40, 'x');
const EVIL = '<img src=x onerror=alert(1)>';

let game: FakeGame;
let obs: Observer;
let srv: ObsServer;
let base: string;
let dir: string;
let ipSeq = 1;
/** Cada teste usa um IP próprio (CF-Connecting-IP vale porque o remoto é loopback). */
const freshIp = () => `203.0.113.${ipSeq++}`;

async function login(ip = freshIp(), extra: Record<string, string> = {}) {
  return fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip, ...extra },
    body: new URLSearchParams({ token: TOKEN }).toString(),
  });
}

async function cookie(): Promise<string> {
  const res = await login();
  expect(res.status).toBe(303);
  return res.headers.get('set-cookie')!.split(';')[0];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'obs-http-'));
  game = await startFakeGame('interno');
  const cfg = loadConfig({
    OBS_TOKEN: TOKEN,
    OBS_INTERNAL_TOKEN: 'interno',
    GAME_INTERNAL_URL: game.url,
    OBS_DATA_DIR: dir,
    OBS_PUBLIC_DIR: 'observer/public',
    OBS_SERVICE_DIR: '',
  });
  obs = new Observer(cfg, { persist: false });
  await obs.init();
  game.emit('join', { name: EVIL, mode: 'publica', room: 'ABCD', country: 'BR', device: 'mobile' });
  game.emit('security', { kind: 'rate_limit', ipHash: 'a1b2c3d4', detail: 'ws flood' });
  await obs.pollGame();
  await obs.sample();
  // Limite global alto aqui: os testes somam muitas falhas de propósito (o global tem teste próprio).
  srv = createObsServer(obs, { token: TOKEN, publicDir: cfg.publicDir, heartbeatMs: 50, loginGlobalPerMinute: 10_000 });
  await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(srv.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  srv.closeStreams();
  srv.server.closeAllConnections();
  await new Promise<void>((r) => srv.server.close(() => r()));
  await game.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('rotas públicas e cabeçalhos', () => {
  it('/healthz responde sem autenticação', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, game: 'up' });
  });

  it('cabeçalhos de segurança em todas as respostas', async () => {
    for (const path of ['/login', '/healthz', '/api/summary', '/static/app.css']) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('same-origin');
      const csp = res.headers.get('content-security-policy')!;
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
    }
  });

  it('as páginas não têm script nem estilo inline', () => {
    for (const f of ['index.html', 'login.html']) {
      const html = readFileSync(join('observer/public', f), 'utf8');
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
      expect(html).not.toMatch(/\son\w+=/i);
      expect(html).not.toMatch(/\sstyle=/i);
      expect(html).not.toMatch(/https?:\/\//); // sem CDN
    }
  });
});

describe('autenticação', () => {
  it('sem cookie: / redireciona para /login e as APIs dão 401', async () => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    for (const path of ['/api/summary', '/api/series?range=1h', '/api/events', '/api/stream', '/metrics']) {
      const r = await fetch(`${base}${path}`);
      expect(r.status, path).toBe(401);
      expect(r.headers.get('www-authenticate')).toMatch(/^Bearer/);
    }
  });

  it('token errado no login dá 401 e não emite cookie', async () => {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': freshIp() },
      body: 'token=errado',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('Token incorreto');
  });

  it('login certo emite cookie assinado HttpOnly/SameSite=Strict de 7 dias e libera o painel', async () => {
    const res = await login();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/^vbobs=[\w.-]+;/);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Max-Age=604800');
    expect(set).not.toContain('Secure');
    const c = set.split(';')[0];
    const page = await fetch(`${base}/`, { headers: { cookie: c } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('/static/app.js');
    expect((await fetch(`${base}/api/summary`, { headers: { cookie: c } })).status).toBe(200);
    // Validade estendida pelo cliente: a assinatura deixa de bater.
    const tampered = c.replace(/^vbobs=(\d+)/, (_m, exp: string) => `vbobs=${Number(exp) + 86_400_000}`);
    expect(tampered).not.toBe(c);
    expect((await fetch(`${base}/api/summary`, { headers: { cookie: tampered } })).status).toBe(401);
    // Assinatura trocada (primeiro caractere, que carrega bits inteiros).
    const sigSwap = c.replace(/\.([\w-])([\w-]+)$/, (_m, a: string, rest: string) => `.${a === 'A' ? 'B' : 'A'}${rest}`);
    expect((await fetch(`${base}/api/summary`, { headers: { cookie: sigSwap } })).status).toBe(401);
  });

  it('cookie ganha Secure atrás de HTTPS (X-Forwarded-Proto ou CF-Visitor)', async () => {
    expect((await login(freshIp(), { 'x-forwarded-proto': 'https' })).headers.get('set-cookie')).toContain('Secure');
    expect((await login(freshIp(), { 'cf-visitor': '{"scheme":"https"}' })).headers.get('set-cookie')).toContain('Secure');
  });

  it('limita a 5 tentativas de login por minuto por IP real', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
        body: 'token=chute' + i,
      });
      expect(r.status).toBe(401);
    }
    const blocked = await login(ip);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Outro IP (outro visitante atrás do túnel) segue livre.
    expect((await login(freshIp())).status).toBe(303);
  });

  it('recusa POST de outra origem', async () => {
    const res = await login(freshIp(), { origin: 'https://malicioso.example' });
    expect(res.status).toBe(403);
  });

  it('aceita Authorization: Bearer na API e no /metrics', async () => {
    const ok = await fetch(`${base}/api/summary`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    const m = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(m.status).toBe(200);
    const bad = await fetch(`${base}/api/summary`, { headers: { authorization: 'Bearer errado', 'cf-connecting-ip': '198.51.100.7' } });
    expect(bad.status).toBe(401);
  });

  it('Bearer errado repetido também cai no limite', async () => {
    const ip = '198.51.100.50';
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer chute${i}`, 'cf-connecting-ip': ip } });
      expect(r.status).toBe(401);
    }
    const r = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}`, 'cf-connecting-ip': ip } });
    expect(r.status).toBe(429);
  });

  it('sessão expira e não vale com outro OBS_TOKEN', () => {
    const s = new Sessions('a'.repeat(32));
    const now = Date.now();
    const v = s.issue(now);
    expect(s.verify(v, now + 1000)).toBe(true);
    expect(s.verify(v, now + 8 * 24 * 3600_000)).toBe(false);
    expect(new Sessions('b'.repeat(32)).verify(v, now)).toBe(false);
    expect(s.verify(undefined)).toBe(false);
    expect(s.verify('x.y.z')).toBe(false);
    expect(s.checkToken('a'.repeat(32))).toBe(true);
    expect(s.checkToken('a'.repeat(31))).toBe(false);
    expect(new Sessions('').checkToken('')).toBe(false);
  });

  it('CF-Connecting-IP só é confiável quando o remoto é loopback', () => {
    const req = (remote: string, headers: Record<string, string> = {}) =>
      ({ socket: { remoteAddress: remote }, headers }) as unknown as IncomingMessage;
    expect(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' }))).toBe('1.2.3.4');
    expect(clientIp(req('::ffff:127.0.0.1', { 'cf-connecting-ip': '2001:db8::1' }))).toBe('2001:db8::1');
    expect(clientIp(req('192.168.3.50', { 'cf-connecting-ip': '1.2.3.4' }))).toBe('192.168.3.50');
    expect(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '<script>' }))).toBe('127.0.0.1');
    expect(isHttps(req('127.0.0.1', { 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(isHttps(req('127.0.0.1'))).toBe(false);
  });
});

/** POST de formulário como um navegador manda (Origin e Sec-Fetch-Site). */
function formPost(path: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': freshIp(), ...headers },
    body,
  });
}

describe('login e logout pelo navegador (CSRF)', () => {
  it('aceita Origin: null quando Sec-Fetch-Site é same-origin (Chrome com referrer no-referrer)', async () => {
    const res = await formPost('/login', `token=${TOKEN}`, { origin: 'null', 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(303);
    const c = res.headers.get('set-cookie')!.split(';')[0];
    const out = await formPost('/logout', '', { origin: 'null', 'sec-fetch-site': 'same-origin', cookie: c });
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('/login');
  });

  it('aceita o Origin real igual ao Host', async () => {
    const host = new URL(base).host;
    expect((await formPost('/login', `token=${TOKEN}`, { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' })).status).toBe(303);
  });

  it('recusa Origin: null sem Sec-Fetch-Site, e qualquer POST cross-site ou same-site', async () => {
    expect((await formPost('/login', `token=${TOKEN}`, { origin: 'null' })).status).toBe(403);
    expect((await formPost('/login', `token=${TOKEN}`, { origin: 'null', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    // Subdomínio irmão (outro serviço em *.caixazen.online): same-site não basta.
    expect((await formPost('/login', `token=${TOKEN}`, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await formPost('/logout', '', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it('sameOrigin(): tabela de casos', () => {
    const req = (headers: Record<string, string>) => ({ headers: { host: 'obs.example', ...headers } }) as unknown as IncomingMessage;
    expect(sameOrigin(req({}))).toBe(true); // curl
    expect(sameOrigin(req({ origin: 'https://obs.example' }))).toBe(true);
    expect(sameOrigin(req({ origin: 'https://obs.example', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(sameOrigin(req({ origin: 'null', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(sameOrigin(req({ origin: 'null' }))).toBe(false);
    expect(sameOrigin(req({ origin: 'https://evil.example' }))).toBe(false);
    expect(sameOrigin(req({ origin: 'https://obs.example', 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(sameOrigin(req({ 'sec-fetch-site': 'none' }))).toBe(false);
  });
});

describe('sessões revogáveis', () => {
  it('depois do logout o mesmo cookie deixa de valer no servidor', async () => {
    const c = await cookie();
    expect((await fetch(`${base}/api/summary`, { headers: { cookie: c } })).status).toBe(200);
    expect((await formPost('/logout', '', { cookie: c })).status).toBe(303);
    expect((await fetch(`${base}/api/summary`, { headers: { cookie: c } })).status).toBe(401);
    // Outra sessão continua valendo.
    const other = await cookie();
    expect((await fetch(`${base}/api/summary`, { headers: { cookie: other } })).status).toBe(200);
  });

  it('"sair de todos os aparelhos" invalida todas as sessões; sem sessão não faz nada', async () => {
    const a = await cookie();
    const b = await cookie();
    const epoch = srv.sessions.currentEpoch;
    // Sem cookie válido, all=1 não derruba ninguém.
    expect((await formPost('/logout', 'all=1')).status).toBe(303);
    expect(srv.sessions.currentEpoch).toBe(epoch);
    expect((await formPost('/logout', 'all=1', { cookie: a })).status).toBe(303);
    expect(srv.sessions.currentEpoch).toBe(epoch + 1);
    for (const c of [a, b]) expect((await fetch(`${base}/api/summary`, { headers: { cookie: c } })).status).toBe(401);
    expect((await fetch(`${base}/api/summary`, { headers: { cookie: await cookie() } })).status).toBe(200);
  });

  it('o logout fecha o stream SSE daquela sessão com um evento "bye"', async () => {
    const c = await cookie();
    const req = http.get(`${base}/api/stream`, { headers: { cookie: c } });
    const res = await new Promise<IncomingMessage>((r) => req.on('response', r));
    let text = '';
    res.on('data', (d: Buffer) => (text += d.toString('utf8')));
    const ended = new Promise<void>((r) => res.on('end', () => r()));
    await formPost('/logout', '', { cookie: c });
    await ended;
    expect(text).toContain('event: bye');
  });

  it('revogações e epoch sobrevivem a reinícios (sessions.json)', () => {
    const file = join(dir, 'sessions.json');
    const s1 = new Sessions('k'.repeat(32), file);
    const now = Date.now();
    const v1 = s1.issue(now);
    const v2 = s1.issue(now);
    s1.revoke(s1.check(v1, now)!, now);
    const s2 = new Sessions('k'.repeat(32), file);
    expect(s2.verify(v1, now)).toBe(false);
    expect(s2.verify(v2, now)).toBe(true);
    s2.revokeAll();
    expect(new Sessions('k'.repeat(32), file).verify(v2, now)).toBe(false);
  });
});

describe('cookie de sessão', () => {
  it('assinatura só na forma canônica: sufixos, base64 padrão e variações do último caractere são recusados', () => {
    const s = new Sessions('c'.repeat(32));
    const now = Date.now();
    const v = s.issue(now);
    expect(s.verify(v, now)).toBe(true);
    const sig = v.slice(v.lastIndexOf('.') + 1);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const head = v.slice(0, v.lastIndexOf('.') + 1);
    const std = sig.replace(/-/g, '+').replace(/_/g, '/');
    const variants = [`${v}==`, `${v}!!`, `${v}=`, head + std + (std === sig ? '=' : '')];
    // O último caractere de 43 em base64 carrega 2 bits sobrando: as outras 3 letras decodificam igual.
    const last = sig.at(-1)!;
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const i = alpha.indexOf(last);
    for (let k = 1; k < 4; k++) variants.push(head + sig.slice(0, -1) + alpha[(i & ~3) | ((i + k) & 3)]);
    for (const bad of variants) expect(s.verify(bad, now), bad).toBe(false);
  });

  it('em HTTPS usa o prefixo __Host- (Secure, Path=/, sem Domain)', async () => {
    const res = await login(freshIp(), { 'x-forwarded-proto': 'https' });
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/^__Host-vbobs=[\w.-]+;/);
    expect(set).toContain('Secure');
    expect(set).toContain('Path=/');
    expect(set).not.toMatch(/Domain=/i);
    const c = set.split(';')[0];
    expect((await fetch(`${base}/api/summary`, { headers: { cookie: c } })).status).toBe(200);
  });

  it('cookie duplicado plantado por outro subdomínio não derruba a sessão', async () => {
    const c = await cookie();
    const value = c.split('=').slice(1).join('=');
    for (const header of [`${c}; vbobs=bad`, `vbobs=bad; ${c}`, `__Host-vbobs=${value}; vbobs=lixo`]) {
      expect((await fetch(`${base}/api/summary`, { headers: { cookie: header } })).status, header).toBe(200);
    }
  });
});

describe('limite de tentativas', () => {
  it('login certo não consome o limite', async () => {
    const ip = freshIp();
    for (let i = 0; i < 8; i++) expect((await login(ip)).status).toBe(303);
  });

  it('IPv6 conta por /64: trocar o endereço dentro do mesmo prefixo não contorna o limite', async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await formPost('/login', 'token=chute', { 'cf-connecting-ip': `2001:db8:7:7::${i}` });
      expect(r.status).toBe(401);
    }
    expect((await formPost('/login', 'token=chute', { 'cf-connecting-ip': '2001:db8:7:7:ffff::99' })).status).toBe(429);
    // Outro /64 segue livre.
    expect((await formPost('/login', `token=${TOKEN}`, { 'cf-connecting-ip': '2001:db8:7:8::1' })).status).toBe(303);
  });

  it('rateKey(): IPv6 agrupado por /64, IPv4 (inclusive mapeado) por endereço', () => {
    expect(rateKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateKey('2001:db8:0:0:ffff::2')).toBe('2001:db8:0:0::/64');
    expect(rateKey('2001:DB8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(rateKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(rateKey('203.0.113.9')).toBe('203.0.113.9');
    expect(rateKey('lixo')).toBe('lixo');
  });

  it('limite global de falhas: muitos endereços diferentes também param', () => {
    const g = new LoginGuard(5, 30);
    const now = 1_000_000;
    for (let i = 0; i < 30; i++) g.fail(`198.18.${i >> 8}.${i & 255}`, now);
    expect(g.blockedFor('192.0.2.200', now)).toBeGreaterThan(0);
    expect(g.blockedFor('192.0.2.200', now + 61_000)).toBe(0);
    // Só falhas criam chaves: o mapa não cresce com tráfego legítimo.
    expect(g.perKey.size).toBe(30);
  });

  it('Bearer certo de um processo no próprio celular (loopback sem proxy) não fica preso no bloqueio', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await fetch(`${base}/metrics`, { headers: { authorization: `Bearer chute${i}` } })).status).toBe(401);
    }
    expect((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer chute-de-novo' } })).status).toBe(429);
    expect((await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it('isDirectLocal(): só loopback sem cabeçalhos de proxy', () => {
    const req = (remote: string, headers: Record<string, string> = {}) =>
      ({ socket: { remoteAddress: remote }, headers }) as unknown as IncomingMessage;
    expect(isDirectLocal(req('127.0.0.1'))).toBe(true);
    expect(isDirectLocal(req('::1'))).toBe(true);
    expect(isDirectLocal(req('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' }))).toBe(false);
    expect(isDirectLocal(req('127.0.0.1', { 'cf-ray': 'abc' }))).toBe(false);
    expect(isDirectLocal(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }))).toBe(false);
    expect(isDirectLocal(req('192.168.3.50'))).toBe(false);
  });
});

describe('APIs', () => {
  it('/metrics no formato de texto do Prometheus', async () => {
    const res = await fetch(`${base}/metrics`, { headers: { cookie: await cookie() } });
    expect(res.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = await res.text();
    expect(text.endsWith('\n')).toBe(true);
    const typed = new Set<string>();
    const name = '[a-zA-Z_:][a-zA-Z0-9_:]*';
    const sample = new RegExp(`^(${name})(\\{${name}="(?:[^"\\\\\\n]|\\\\.)*"(?:,${name}="(?:[^"\\\\\\n]|\\\\.)*")*\\})? (-?[0-9.e+-]+|NaN|\\+Inf|-Inf)$`);
    for (const line of text.trimEnd().split('\n')) {
      if (line.startsWith('# HELP ')) continue;
      const t = /^# TYPE (\S+) (gauge|counter|histogram|summary|untyped)$/.exec(line);
      if (t) {
        expect(typed.has(t[1]), `TYPE duplicado ${t[1]}`).toBe(false);
        typed.add(t[1]);
        continue;
      }
      const m = sample.exec(line);
      expect(m, `linha inválida: ${line}`).not.toBeNull();
      expect(typed.has(m![1]), `amostra sem TYPE: ${line}`).toBe(true);
    }
    expect(text).toContain('vb_game_up 1');
    expect(text).toContain('vb_players{state="online"} 5');
    expect(text).toContain('vb_battles_total{kind="pvp"} 12');
    expect(text).toContain('vb_players_by_country{country="BR"} 4');
    expect(escapeLabel('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });

  it('/api/series e /api/events', async () => {
    const c = await cookie();
    const s = await (await fetch(`${base}/api/series?range=1h`, { headers: { cookie: c } })).json();
    expect(s.fields.online).toEqual([5]);
    expect(s.t).toHaveLength(1);
    expect((await fetch(`${base}/api/series?range=2h`, { headers: { cookie: c } })).status).toBe(400);
    const only = await (await fetch(`${base}/api/series?range=24h&fields=online`, { headers: { cookie: c } })).json();
    expect(Object.keys(only.fields)).toEqual(['online']);
    const ev = await (await fetch(`${base}/api/events?type=security&limit=5`, { headers: { cookie: c } })).json();
    expect(ev.events).toHaveLength(1);
    expect(ev.events[0].data).toEqual({ kind: 'rate_limit', ipHash: 'a1b2c3d4', detail: 'ws flood' });
    const day = await fetch(`${base}/api/events?day=../../etc/passwd`, { headers: { cookie: c } });
    expect(day.status).toBe(400);
  });

  it('SSE entrega o estado inicial e as atualizações a cada coleta', async () => {
    const c = await cookie();
    const events: { event: string; data: any }[] = [];
    const url = new URL(`${base}/api/stream`);
    const req = http.get(url, { headers: { cookie: c } });
    const res = await new Promise<IncomingMessage>((r) => req.on('response', r));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    let buf = '';
    let heartbeat = false;
    const waitFor = (pred: () => boolean) =>
      new Promise<void>((resolveWait, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE não chegou')), 3_000);
        const check = () => {
          if (pred()) {
            clearTimeout(timer);
            res.off('data', onData);
            resolveWait();
          }
        };
        const onData = (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith(': hb')) heartbeat = true;
            const ev = /^event: (\w+)$/m.exec(block);
            const data = /^data: (.*)$/m.exec(block);
            if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
          }
          check();
        };
        res.on('data', onData);
        check();
      });
    await waitFor(() => events.length >= 1);
    expect(events[0].event).toBe('hello');
    expect(events[0].data.summary.stats.players.online).toBe(5);
    expect(events[0].data.events.map((e: any) => e.type)).toContain('join');

    game.emit('match_end', { room: 'ABCD', winner: 'Tatu', form: 'brasa', durationMs: 300_000, humans: 3 });
    await obs.pollGame();
    await waitFor(() => events.some((e) => e.event === 'tick'));
    const tick = events.find((e) => e.event === 'tick')!;
    expect(tick.data.events.map((e: any) => e.type)).toEqual(['match_end']);
    expect(tick.data.summary.today.matchesEnded).toBeGreaterThanOrEqual(1);
    await waitFor(() => heartbeat);
    req.destroy();
  });
});

describe('apelidos nunca viram HTML', () => {
  it('a API devolve o apelido como texto JSON e o HTML do painel não o contém', async () => {
    const c = await cookie();
    const res = await fetch(`${base}/api/events?type=join`, { headers: { cookie: c } });
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const { events } = await res.json();
    expect(events[0].data.name).toBe(EVIL);
    const page = await (await fetch(`${base}/`, { headers: { cookie: c } })).text();
    expect(page).not.toContain('onerror');
  });

  it('o JS do painel não usa sinks de HTML', () => {
    for (const f of ['app.js', 'view.js']) {
      const src = readFileSync(join('observer/public', f), 'utf8');
      expect(src, f).not.toMatch(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*['"]on/);
    }
  });

  it('o feed monta o evento com nós de texto (DOM simulado)', async () => {
    class FakeText {
      readonly nodeType = 3;
      constructor(readonly data: string) {}
      get textContent() {
        return this.data;
      }
    }
    class FakeEl {
      readonly nodeType = 1;
      className = '';
      title = '';
      childNodes: (FakeEl | FakeText)[] = [];
      constructor(readonly tagName: string) {}
      append(...n: (FakeEl | FakeText)[]) {
        for (const x of n) {
          if (!(x instanceof FakeEl) && !(x instanceof FakeText)) throw new Error('append de algo que não é nó');
          this.childNodes.push(x);
        }
      }
      get textContent(): string {
        return this.childNodes.map((c) => c.textContent).join('');
      }
      set innerHTML(_v: string) {
        throw new Error('innerHTML proibido');
      }
    }
    const g = globalThis as unknown as { document?: unknown };
    const prev = g.document;
    g.document = { createElement: (t: string) => new FakeEl(t), createTextNode: (s: string) => new FakeText(s) };
    try {
      const view = await import(/* @vite-ignore */ pathToFileURL(resolve('observer/public/view.js')).href);
      const li = view.feedItem(
        { id: 1, t: Date.now(), type: 'join', data: { name: EVIL, mode: 'publica', room: '<b>X</b>', country: 'BR', device: 'mobile' } },
        true,
      ) as FakeEl;
      const tags: string[] = [];
      const walk = (n: FakeEl | FakeText) => {
        if (n instanceof FakeEl) {
          tags.push(n.tagName);
          n.childNodes.forEach(walk);
        }
      };
      walk(li);
      expect(tags).not.toContain('img');
      expect(tags.filter((t) => t === 'b')).toHaveLength(2); // só os destaques do próprio painel
      expect(li.textContent).toContain(EVIL);
      expect(li.textContent).toContain('<b>X</b>');
    } finally {
      g.document = prev;
    }
  });
});
