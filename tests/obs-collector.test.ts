import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameCollector, normalizeStats } from '../observer/src/collector';
import { EventStore } from '../observer/src/events';
import { startFakeGame, type FakeGame } from './helpers/fake-game';

const TOKEN = 'segredo-interno';

describe('coleta do contrato do jogo', () => {
  let game: FakeGame;
  let store: EventStore;
  let col: GameCollector;

  beforeEach(async () => {
    game = await startFakeGame(TOKEN);
    store = new EventStore(null);
    col = new GameCollector({ gameUrl: game.url, internalToken: TOKEN, timeoutMs: 300, addEvent: (e) => store.add(e) });
  });
  afterEach(async () => {
    await game.close().catch(() => {});
  });

  it('lê as estatísticas, manda o token e avança o cursor de eventos', async () => {
    game.emit('join', { name: 'Tatu', mode: 'publica', room: 'ABCD', country: 'BR', device: 'mobile' });
    game.emit('match_start', { room: 'ABCD', humans: 3, bots: 5, players: 8 });
    const added = await col.poll();
    expect(col.state.status).toBe('up');
    expect(col.fresh()?.players.online).toBe(5);
    expect(added.map((e) => e.type)).toEqual(['join', 'match_start']);
    expect(game.requests[0]).toEqual({ since: '0', token: TOKEN });
    expect(col.cursor.nextSeq).toBe(2);

    game.emit('leave', { name: 'Tatu', room: 'ABCD', reason: 'fechou', inMatch: false });
    const again = await col.poll();
    expect(game.requests[1].since).toBe('2');
    expect(again.map((e) => e.type)).toEqual(['leave']);
    // Sem duplicar o que já foi lido.
    expect(store.query({ limit: 10 }).map((e) => e.type)).toEqual(['leave', 'match_start', 'join']);
  });

  it('jogo fora do ar: status down com motivo, evento de queda e de volta', async () => {
    await col.poll();
    expect(col.state.status).toBe('up');
    await game.close();
    // Os eventos sintéticos também saem da consulta (para o SSE e os agregados).
    expect((await col.poll()).map((e) => e.type)).toEqual(['down']);
    expect(col.state.status).toBe('down');
    expect(col.state.lastError).toBe('conexão recusada');
    expect(col.fresh()).toBeNull();
    const down = store.query({ types: ['down'] });
    expect(down).toHaveLength(1);
    expect(down[0].data.wasUp).toBe(true);

    // Continua fora: não repete o evento.
    await col.poll();
    expect(store.query({ types: ['down'] })).toHaveLength(1);

    // Volta na mesma porta.
    const port = Number(new URL(game.url).port);
    game = await startFakeGame(TOKEN, port);
    // Processo novo (startedAt novo): volta e reinício.
    expect((await col.poll()).map((e) => e.type)).toEqual(['restart', 'up']);
    expect(col.state.status).toBe('up');
    const up = store.query({ types: ['up'] });
    expect(up).toHaveLength(1);
    expect(typeof up[0].data.downMs).toBe('number');
  });

  it('timeout curto quando o jogo trava', async () => {
    game.mode = 'hang';
    const t0 = performance.now();
    await col.poll();
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(col.state.status).toBe('down');
    expect(col.state.lastError).toBe('timeout');
  });

  it('HTTP 500, JSON inválido e token recusado contam como fora do ar', async () => {
    game.mode = 'error500';
    await col.poll();
    expect(col.state.lastError).toBe('HTTP 500');
    game.mode = 'garbage';
    await col.poll();
    expect(col.state.lastError).toMatch(/resposta inválida/);
    game.mode = 'ok';
    const wrong = new GameCollector({ gameUrl: game.url, internalToken: 'errado', timeoutMs: 300, addEvent: (e) => store.add(e) });
    await wrong.poll();
    expect(wrong.state.status).toBe('down');
    expect(wrong.state.lastError).toMatch(/401/);
  });

  it('detecta reinício pelo startedAt e relê os eventos do zero', async () => {
    game.emit('join', { name: 'A', mode: 'publica', room: 'ABCD', country: 'BR', device: 'mobile' });
    game.emit('join', { name: 'B', mode: 'publica', room: 'ABCD', country: 'BR', device: 'mobile' });
    await col.poll();
    expect(col.cursor.nextSeq).toBe(2);

    game.restart('2.0.0');
    game.emit('join', { name: 'C', mode: 'publica', room: 'NOVA', country: 'PT', device: 'desktop' });
    const added = await col.poll();
    expect(added.map((e) => e.type)).toEqual(['restart']);
    expect(added[0].data.version).toBe('2.0.0');
    expect(col.state.restarts).toBe(1);
    expect(col.cursor).toEqual({ startedAt: game.stats.startedAt, nextSeq: 0 });

    const next = await col.poll();
    expect(game.requests.at(-1)?.since).toBe('0');
    expect(next.map((e) => e.data.name)).toEqual(['C']);
  });

  it('cursor restaurado: não duplica eventos após reinício do observador', async () => {
    for (let i = 0; i < 3; i++) game.emit('duel', { room: 'ABCD', a: 'x', b: 'y' });
    const restored = new GameCollector({
      gameUrl: game.url,
      internalToken: TOKEN,
      timeoutMs: 300,
      addEvent: (e) => store.add(e),
      cursor: { startedAt: game.stats.startedAt, nextSeq: 2 },
    });
    const added = await restored.poll();
    expect(added).toHaveLength(1);
    expect(added[0].seq).toBe(2);
  });
});

describe('normalizeStats', () => {
  it('rejeita respostas fora do contrato e corta o que vier estranho', () => {
    expect(() => normalizeStats({})).toThrow();
    const s = normalizeStats({
      startedAt: 1,
      nextSeq: 3,
      rooms: [{ code: 'X'.repeat(100), state: 'hackeado', humans: 'muitos' }],
      events: [
        { seq: 1, t: 5, type: 'join', data: { name: 'a'.repeat(1000), obj: { x: 1 }, n: Infinity } },
        { seq: 2, t: 5, type: 'rm -rf', data: {} },
      ],
      breakdown: { countries: { BR: 2, __proto__: 5 } },
    });
    expect(s.rooms[0].code).toHaveLength(16);
    expect(s.rooms[0].state).toBe('lobby');
    expect(s.rooms[0].humans).toBe(0);
    expect(s.events).toHaveLength(1);
    expect(String(s.events[0].data.name)).toHaveLength(200);
    expect(s.events[0].data).not.toHaveProperty('obj');
    expect(s.events[0].data.n).toBeNull();
    expect(s.players.online).toBe(0);
    expect(s.breakdown.countries).toEqual({ BR: 2 });
  });
});
