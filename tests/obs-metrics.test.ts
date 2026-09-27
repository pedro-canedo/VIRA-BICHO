import { describe, expect, it } from 'vitest';
import { normalizeStats } from '../observer/src/collector';
import { OBS_INTERNAL_DEFAULT_URL } from '@vb/shared';
import { OBS_INTERNAL_PORT, parseSince, tokenProblem } from '../server/src/internal';
import { GameMetrics, SampleWindow, countryOf, deviceOf, leaveReason, resolveVersion, type StatsSource } from '../server/src/metrics';
import { Room, type Member } from '../server/src/room';

const NO_SEC = { rateLimited: 0, rejectedConnections: 0, originRejected: 0 };
const src = (rooms: Room[] = [], openConns = 0): StatsSource => ({ rooms, openConns, security: NO_SEC });

describe('GameMetrics: buffer de eventos', () => {
  it('seq crescente, buffer limitado e filtro since', () => {
    const m = new GameMetrics({ now: () => 1000, eventCapacity: 5 });
    for (let i = 0; i < 8; i++) m.emit('error', { message: `e${i}` });
    expect(m.nextSeq).toBe(8);
    // Só os 5 últimos continuam no buffer.
    expect(m.eventsSince(0).map((e) => e.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(m.eventsSince(6).map((e) => e.data.message)).toEqual(['e6', 'e7']);
    expect(m.eventsSince(8)).toEqual([]);
    expect(m.eventsSince(1000)).toEqual([]);
    const snap = m.snapshot(7, src());
    expect(snap.events.map((e) => e.seq)).toEqual([7]);
    expect(snap.nextSeq).toBe(8);
    expect(snap.events[0]).toEqual({ seq: 7, t: 1000, type: 'error', data: { message: 'e7' } });
  });

  it('startedAt é fixo no processo; now acompanha o relógio', () => {
    let t = 5_000;
    const m = new GameMetrics({ now: () => t });
    t = 9_000;
    const a = m.snapshot(0, src());
    t = 12_000;
    const b = m.snapshot(0, src());
    expect(a.startedAt).toBe(5_000);
    expect(b.startedAt).toBe(5_000);
    expect(b.now).toBe(12_000);
  });

  it('a resposta passa inteira pela validação do observador', () => {
    const m = new GameMetrics({ now: () => 1_000 });
    const room = new Room('ABCD', false, 7);
    m.roomCreated(room, 1_000);
    const member: Member = { conn: { send: () => {} }, name: 'Tatu', player: null };
    m.connOpened(member.conn, { country: 'BR', device: 'mobile' });
    room.join(member, 1_000);
    m.join(member.conn, member, room, 'quick');
    const snap = m.snapshot(0, src([room], 1));
    expect(normalizeStats(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
    expect(snap.rooms).toEqual([{ code: 'ABCD', private: false, state: 'lobby', humans: 1, bots: 0, alive: 0, phase: 'lobby', elapsedMs: 0 }]);
    expect(snap.breakdown).toEqual({ countries: { BR: 1 }, devices: { mobile: 1, desktop: 0 } });
    expect(snap.players).toEqual({ online: 1, lobby: 1, playing: 0, spectating: 0 });
  });
});

describe('GameMetrics: ganchos', () => {
  it('um gancho com falha não lança (o tick da sala não pode cair por causa da métrica)', () => {
    const m = new GameMetrics({ now: () => 1 });
    const bad = { get name(): string {
      throw new Error('x');
    } } as unknown as Member;
    const room = new Room('ABCD', false, 1);
    expect(() => m.join({ send: () => {} }, bad, room, 'quick')).not.toThrow();
    expect(() => m.leave(bad, room, 'saiu')).not.toThrow();
    expect(() => m.matchEnd({} as Room, null)).not.toThrow();
    expect(m.internalErrors).toBeGreaterThanOrEqual(2);
  });

  it('segurança: falhas do servidor não viram evento de segurança e a rajada é limitada', () => {
    let t = 0;
    const m = new GameMetrics({ now: () => t, securityEvents: { capacity: 3, refillPerSec: 1 } });
    m.security('timer_error', 'abc', 'tick');
    m.security('handle_error', 'abc', 'hello');
    expect(m.nextSeq).toBe(0);
    for (let i = 0; i < 10; i++) m.security('ws_origin_rejected', `tag${i}`, 'evil.example');
    expect(m.nextSeq).toBe(3);
    expect(m.securityDropped).toBe(7);
    t = 2_000;
    m.security('http_rate_limited', 'tagX');
    expect(m.eventsSince(0).map((e) => e.data)).toContainEqual({ kind: 'http_rate_limited', ipHash: 'tagX', detail: '' });
  });

  it('erro vira contador e evento curto; erro repetido não enche o buffer', () => {
    const m = new GameMetrics({ now: () => 1, errorEvents: { capacity: 2, refillPerSec: 0 } });
    m.error('timer tick', new TypeError('quebrou\n  em algum lugar'));
    const snap = m.snapshot(0, src());
    expect(snap.counters.errors).toBe(1);
    expect(snap.events[0].data).toEqual({ message: 'timer tick: TypeError: quebrou em algum lugar' });
    for (let i = 0; i < 10; i++) m.error('timer tick', new Error('de novo'));
    expect(m.snapshot(0, src()).counters.errors).toBe(11);
    expect(m.nextSeq).toBe(2);
    expect(m.errorsDropped).toBe(9);
  });
});

describe('amostras do processo', () => {
  it('SampleWindow: quantis na janela recente, sem crescer', () => {
    const w = new SampleWindow(100);
    for (let i = 1; i <= 100; i++) w.push(i);
    expect(w.quantiles()).toEqual({ p50: 50, p99: 99, max: 100 });
    // Janela circular: as 100 amostras antigas saem.
    for (let i = 0; i < 100; i++) w.push(1);
    expect(w.size).toBe(100);
    expect(w.quantiles()).toEqual({ p50: 1, p99: 1, max: 1 });
    expect(new SampleWindow(10).quantiles()).toEqual({ p50: 0, p99: 0, max: 0 });
  });

  it('tickMs, lag do event loop e CPU aparecem como números finitos', async () => {
    const m = new GameMetrics();
    m.enableLoopMonitor(10);
    for (let i = 0; i < 50; i++) m.tickDone(i % 10 === 0 ? 4 : 1);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    while (Date.now() - t0 < 60); // trava o loop um pouco
    await new Promise((r) => setTimeout(r, 1000));
    const p = m.snapshot(0, src()).process;
    m.dispose();
    expect(p.tickMs).toEqual({ p50: 1, p99: 4, max: 4 });
    expect(p.eventLoopLagMs.max).toBeGreaterThanOrEqual(p.eventLoopLagMs.p50);
    expect(p.eventLoopLagMs.max).toBeGreaterThan(20);
    for (const v of [p.rssMB, p.heapUsedMB, p.cpuPct]) expect(Number.isFinite(v) && v >= 0).toBe(true);
    expect(p.rssMB).toBeGreaterThan(p.heapUsedMB);
  });
});

describe('país, dispositivo e rótulos', () => {
  it('CF-IPCountry só vale pelo túnel', () => {
    expect(countryOf(true, { 'cf-ipcountry': 'br' })).toBe('BR');
    expect(countryOf(true, { 'cf-ipcountry': 'T1' })).toBe('T1');
    expect(countryOf(false, { 'cf-ipcountry': 'BR' })).toBe('XX');
    expect(countryOf(true, {})).toBe('XX');
    expect(countryOf(true, { 'cf-ipcountry': 'BRA' })).toBe('XX');
    expect(countryOf(true, { 'cf-ipcountry': '<b>' })).toBe('XX');
  });

  it('dispositivo pelo User-Agent', () => {
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; moto g) AppleWebKit/537.36 Mobile Safari/537.36')).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130')).toBe('desktop');
    expect(deviceOf(undefined)).toBe('desktop');
  });

  it('motivo da saída pelo código de fechamento', () => {
    expect(leaveReason(1001)).toBe('fechou');
    expect(leaveReason(1006)).toBe('caiu');
    expect(leaveReason(4003)).toBe('parado');
    expect(leaveReason(3999)).toBe('desconectou');
  });

  it('versão: VB_VERSION, senão a do package.json', () => {
    expect(resolveVersion({ VB_VERSION: ' 2.0.0-x ' })).toBe('2.0.0-x');
    expect(resolveVersion({})).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('endpoint interno: entradas', () => {
  it('porta padrão coerente com o endereço padrão do observador', () => {
    expect(OBS_INTERNAL_PORT).toBe(3002);
    expect(OBS_INTERNAL_DEFAULT_URL).toBe(`http://127.0.0.1:${OBS_INTERNAL_PORT}`);
  });

  it('token: ausente ou curto desliga, sem citar o valor', () => {
    expect(tokenProblem(undefined)).toMatch(/sem/);
    expect(tokenProblem('   ')).toMatch(/sem/);
    const p = tokenProblem('curtinho-123');
    expect(p).toMatch(/16/);
    expect(p).not.toContain('curtinho');
    expect(tokenProblem('x'.repeat(16))).toBeNull();
  });

  it('since: ausente = 0, inteiro >= 0, o resto é inválido', () => {
    expect(parseSince('')).toBe(0);
    expect(parseSince('since=')).toBe(0);
    expect(parseSince('since=42')).toBe(42);
    expect(parseSince('x=1&since=7')).toBe(7);
    for (const q of ['since=-1', 'since=abc', 'since=1.5', 'since=1e3', 'since=9999999999999999', 'since=%zz']) expect(parseSince(q)).toBeNull();
  });
});
