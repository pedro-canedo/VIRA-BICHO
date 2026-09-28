import { describe, expect, it } from 'vitest';
import { BALANCE, MODES, type ServerMsg } from '@vb/shared';
import { Room, type Member } from '../server/src/room';
import { simulate } from '../scripts/simulate';

describe('partida simulada só com bots', () => {
  it('termina com um único vencedor, decidido no Duelo Final entre as 2 maiores Forças', () => {
    const P = MODES.rapido.phases;
    for (let seed = 1; seed <= 8; seed++) {
      const r = simulate(seed, 16);
      expect(r.alive).toBe(1);
      expect(r.battles.final).toBe(1);
      expect(r.duelAt).not.toBeNull();
      // Sem o gatilho "sobraram 2": o duelo é sempre no fim da fase final.
      expect(r.duelAt!).toBeGreaterThanOrEqual(P.finalEnd);
      expect(r.duelAt!).toBeLessThanOrEqual(P.finalEnd + BALANCE.tickMs);
      expect(r.duelTopTwo).toBe(true);
      expect(r.durationMs).toBeLessThan(P.hardCap);
      expect(r.battles.wild).toBeGreaterThan(50);
      expect(r.battles.pvp).toBeGreaterThan(15);
      // Ranking completo, sem colocação repetida, e bots comprando habilidades.
      expect(r.ranking.map((x) => x.place)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
      expect(r.avgBuys).toBeGreaterThan(1);
      expect(r.finalistPower[0]).toBeGreaterThanOrEqual(r.finalistPower[1]);
    }
  });

  it('funciona com 8 jogadores (mapa menor)', () => {
    const r = simulate(42, 8);
    expect(r.alive).toBe(1);
    expect(r.mapSize).toBe(48);
  });

  it('Clássico e Avançado: arena maior, fases do modo e builds maiores', () => {
    const c = simulate(7, 8, 'classico');
    expect(c.gm).toBe('classico');
    expect(c.mapSize).toBe(60);
    expect(c.duelAt).toBeGreaterThanOrEqual(MODES.classico.phases.finalEnd);
    expect(c.duelAt).toBeLessThanOrEqual(MODES.classico.phases.finalEnd + BALANCE.tickMs);
    expect(c.alive).toBe(1);
    expect(c.avgSkills).toBeGreaterThan(MODES.rapido.slots - 1);
    const a = simulate(7, 8, 'avancado');
    expect(a.mapSize).toBe(72);
    expect(a.duelAt).toBeGreaterThanOrEqual(MODES.avancado.phases.finalEnd);
    expect(a.alive).toBe(1);
    expect(a.avgSkills).toBeLessThanOrEqual(MODES.avancado.slots);
    expect(a.avgSkills).toBeGreaterThan(MODES.classico.slots - 1);
  });
});

describe('fluxo de um humano', () => {
  it('recebe lobby, start, snapshots e fim; vira bot se desconectar', () => {
    const msgs: ServerMsg[] = [];
    const room = new Room('TEST', true, 123);
    const member: Member = { conn: { send: (m) => msgs.push(m) }, name: 'Pedro', player: null };
    let now = 1_000_000;
    room.join(member, now);
    room.tick(now);
    expect(msgs.some((m) => m.t === 'lobby')).toBe(true);
    room.startNow(now);
    room.tick((now += 100));
    const start = msgs.find((m) => m.t === 'start');
    expect(start && start.t === 'start' && start.players).toBe(BALANCE.lobby.minPlayers);
    room.tick((now += 100));
    const snap = msgs.findLast((m) => m.t === 'snap');
    expect(snap && snap.t === 'snap' && snap.me?.alive).toBe(true);

    // O humano nasce chocando: espera a eclosão e anda até um bicho selvagem para batalhar.
    const me = member.player!;
    expect(snap && snap.t === 'snap' && snap.me!.hatchMs).toBeGreaterThan(0);
    for (let i = 0; i < 40 && room.isHatching(me); i++) room.tick((now += 100));
    expect(room.isHatching(me)).toBe(false);
    const wild = [...room.wilds.values()].sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
    room.setTarget(me, wild.id);
    for (let i = 0; i < 600 && !msgs.some((m) => m.t === 'b_start'); i++) room.tick((now += 100));
    expect(msgs.some((m) => m.t === 'b_start')).toBe(true);
    room.act(me, 'ataque');
    for (let i = 0; i < 200 && !msgs.some((m) => m.t === 'b_end'); i++) room.tick((now += 100));
    expect(msgs.some((m) => m.t === 'b_reveal')).toBe(true);
    expect(msgs.some((m) => m.t === 'b_end')).toBe(true);

    room.leave(member);
    expect(me.bot).not.toBeNull();
  });
});
