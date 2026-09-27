import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type ObsConfig } from '../observer/src/config';
import { DayAggregator } from '../observer/src/daystats';
import { EventStore, dayKey } from '../observer/src/events';
import { Observer } from '../observer/src/observer';
import { RingSeries } from '../observer/src/series';
import { startFakeGame, type FakeGame } from './helpers/fake-game';

describe('RingSeries (buffer circular)', () => {
  it('sobrescreve as amostras mais antigas ao dar a volta', () => {
    const s = new RingSeries(4, ['a', 'b']);
    for (let i = 1; i <= 6; i++) s.push(i * 1000, { a: i, b: i % 2 ? null : i * 10 });
    expect(s.size).toBe(4);
    const r = s.range(0, 10_000, 100);
    expect(r.t.length).toBe(4);
    expect(r.fields.a).toEqual([3, 4, 5, 6]);
    expect(r.fields.b).toEqual([null, 40, null, 60]);
    expect(s.last()).toEqual({ t: 6000, values: { a: 6, b: 60 } });
    expect(s.max('a', 0)).toBe(6);
    expect(s.max('a', 0, 4500)).toBe(4);
  });

  it('reduz para no máximo N pontos com média por balde', () => {
    const s = new RingSeries(1000, ['v']);
    for (let i = 0; i < 1000; i++) s.push(i * 1000, { v: i });
    const r = s.range(0, 999_999, 10);
    expect(r.t.length).toBe(10);
    expect(r.fields.v[0]).toBeCloseTo(49.5);
    expect(r.fields.v[9]).toBeCloseTo(949.5);
    // Só um campo pedido.
    expect(Object.keys(s.range(0, 1e6, 10, ['v']).fields)).toEqual(['v']);
  });

  it('serializa e restaura (ordem cronológica, campos casados pelo nome, corte por idade)', () => {
    const s = new RingSeries(5, ['a', 'b']);
    for (let i = 1; i <= 7; i++) s.push(i * 1000, { a: i, b: -i });
    const buf = s.serialize();
    const r = RingSeries.deserialize(buf, 10, ['b', 'novo', 'a'], 4000);
    expect(r.size).toBe(4); // 4000..7000
    const range = r.range(0, 10_000, 100);
    expect(range.fields.a).toEqual([4, 5, 6, 7]);
    expect(range.fields.b).toEqual([-4, -5, -6, -7]);
    expect(range.fields.novo).toEqual([null, null, null, null]);
    expect(() => RingSeries.deserialize(Buffer.from('lixo'), 10)).toThrow();
  });
});

describe('agregados do dia', () => {
  it('conta partidas, média de duração, vencedores por forma e pico de online', () => {
    const now = new Date(2026, 8, 27, 15, 0, 0).getTime();
    const d = new DayAggregator(now);
    let id = 1;
    const ev = (type: string, data: Record<string, string | number | null>, t = now) => d.onEvent({ id: id++, t, type, data });
    ev('match_start', { room: 'A' });
    ev('match_end', { room: 'A', winner: 'x', form: 'brasa', durationMs: 300_000, humans: 2 });
    ev('match_end', { room: 'B', winner: 'y', form: 'brasa', durationMs: 200_000, humans: 2 });
    ev('match_end', { room: 'C', winner: null, form: null, durationMs: 100_000, humans: 1 });
    ev('join', { name: 'z' });
    d.onOnline(now, 7);
    d.onOnline(now + 1, 3);
    const v = d.view(now);
    expect(v.matchesEnded).toBe(3);
    expect(v.avgDurationMs).toBe(200_000);
    expect(v.winnersByForm).toEqual({ brasa: 2, 'sem vencedor': 1 });
    expect(v.peakOnline).toBe(7);
    expect(v.joins).toBe(1);
    // Virou o dia: zera.
    const tomorrow = now + 24 * 3600_000;
    expect(d.view(tomorrow).matchesEnded).toBe(0);
  });
});

describe('persistência do observador', () => {
  let dir: string;
  let game: FakeGame;
  let cfg: ObsConfig;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'obs-persist-'));
    game = await startFakeGame('tok');
    cfg = loadConfig({
      OBS_TOKEN: 'x'.repeat(32),
      OBS_INTERNAL_TOKEN: 'tok',
      GAME_INTERNAL_URL: game.url,
      OBS_DATA_DIR: dir,
      OBS_SERVICE_DIR: '',
      OBS_PROC_ROOT: join(dir, 'sem-proc'),
      OBS_SYS_ROOT: join(dir, 'sem-sys'),
    });
  });
  afterEach(async () => {
    await game.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('salva séries, cursor, agregados e eventos NDJSON e restaura ao iniciar', async () => {
    const a = new Observer(cfg);
    await a.init();
    game.emit('join', { name: 'Tatu', mode: 'publica', room: 'ABCD', country: 'BR', device: 'mobile' });
    game.emit('match_end', { room: 'ABCD', winner: 'Tatu', form: 'mare', durationMs: 280_000, humans: 3 });
    await a.pollGame();
    await a.sample();
    await a.sample();
    await a.persist();

    const files = readdirSync(dir).sort();
    expect(files).toContain('series.bin');
    expect(files).toContain('state.json');
    const ndjson = files.find((f) => /^events-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f))!;
    expect(ndjson).toBe(`events-${dayKey(Date.now())}.ndjson`);
    const lines = readFileSync(join(dir, ndjson), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['join', 'match_end']);

    const b = new Observer(cfg);
    await b.init();
    expect(b.series.size).toBe(2);
    expect(b.series.last()?.values.online).toBe(5);
    expect(b.collector.cursor.nextSeq).toBe(2);
    expect(b.day.view().matchesEnded).toBe(1);
    expect(b.day.view().winnersByForm).toEqual({ mare: 1 });
    expect(b.events.query({ limit: 10 }).map((e) => e.type)).toEqual(['match_end', 'join']);

    // O cursor restaurado impede releitura: nenhum evento novo duplicado.
    const added = await b.pollGame();
    expect(added).toHaveLength(0);
    // Ids continuam crescendo depois do restauro.
    game.emit('duel', { room: 'ABCD', a: 'x', b: 'y' });
    const [duel] = await b.pollGame();
    expect(duel.id).toBeGreaterThan(2);
  });

  it('sem state.json, refaz os agregados de hoje a partir do NDJSON', async () => {
    const store = new EventStore(dir);
    store.add({ t: Date.now(), type: 'match_end', data: { room: 'A', winner: 'w', form: 'broto', durationMs: 60_000, humans: 1 } });
    await store.flush();
    const o = new Observer(cfg);
    await o.init();
    expect(o.day.view().matchesEnded).toBe(1);
    expect(o.day.view().winnersByForm).toEqual({ broto: 1 });
  });

  it('apaga arquivos de eventos com mais de 7 dias', async () => {
    const now = Date.now();
    const old = dayKey(now - 8 * 86_400_000);
    const recent = dayKey(now - 6 * 86_400_000);
    writeFileSync(join(dir, `events-${old}.ndjson`), '');
    writeFileSync(join(dir, `events-${recent}.ndjson`), '');
    writeFileSync(join(dir, 'outro-arquivo.txt'), '');
    const store = new EventStore(dir);
    const removed = await store.prune(7, now);
    expect(removed).toEqual([`events-${old}.ndjson`]);
    expect(readdirSync(dir).sort()).toEqual([`events-${recent}.ndjson`, 'outro-arquivo.txt'].sort());
  });

  it('arquivo de séries corrompido não impede a subida', async () => {
    writeFileSync(join(dir, 'series.bin'), 'corrompido');
    writeFileSync(join(dir, 'state.json'), '{nao é json');
    writeFileSync(join(dir, `events-${dayKey(Date.now())}.ndjson`), '{"id":1,"t":1,"type":"join","data":{}}\n{linha quebrada\n');
    const o = new Observer(cfg);
    await expect(o.init()).resolves.toBeUndefined();
    expect(o.series.size).toBe(0);
    expect(o.events.query({ limit: 10 })).toHaveLength(1);
  });
});
