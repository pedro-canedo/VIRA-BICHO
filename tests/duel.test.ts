import { describe, expect, it } from 'vitest';
import { BALANCE, maxHp, type ServerMsg, type Stage } from '@vb/shared';
import type { Player } from '../server/src/entities';
import { Room, type Member } from '../server/src/room';

/** Sala com 1 humano (fraco, para ficar de fora) e 7 bots, com estágios definidos a dedo. */
function setup() {
  const msgs: ServerMsg[] = [];
  const room = new Room('DUEL', true, 99);
  const human: Member = { conn: { send: (m) => msgs.push(m) }, name: 'Humano', player: null };
  let now = 1_000_000;
  room.join(human, now);
  room.start(now, 8);
  const players = [...room.players.values()].sort((a, b) => a.id - b.id);
  const set = (p: Player, stage: Stage, trophies: number, hpPct: number) => {
    p.stage = stage;
    p.trophies = trophies;
    p.hp = Math.round(maxHp(stage) * hpPct);
  };
  const me = human.player!;
  const bots = players.filter((p) => p !== me);
  set(me, 0, 0, 1);
  set(bots[0], 3, 1, 0.2); // 1º: forma final com troféu, mesmo com pouca vida
  set(bots[1], 3, 0, 0.9); // 2º: forma final, mais vida que o 3º
  set(bots[2], 3, 0, 0.5); // 3º
  set(bots[3], 2, 0, 1);
  set(bots[4], 2, 0, 0.4);
  set(bots[5], 1, 0, 1);
  set(bots[6], 1, 0, 0.3);
  const tick = (ms = BALANCE.tickMs) => room.tick((now += ms));
  return { room, msgs, me, bots, tick, advanceTo: (el: number) => (room.startedAt = now - el) };
}

describe('Duelo Final', () => {
  it('aos 5:00 só os 2 mais evoluídos seguem, com HP cheio, no centro, e os demais ganham a colocação do ranking', () => {
    const { room, msgs, me, bots, tick, advanceTo } = setup();
    advanceTo(BALANCE.phases.finalEnd);
    tick();
    expect(room.phase).toBe('duelo');
    expect(room.duel?.a).toBe(bots[0]);
    expect(room.duel?.b).toBe(bots[1]);
    for (const p of [bots[0], bots[1]]) {
      expect(p.alive).toBe(true);
      expect(p.hp).toBe(maxHp(p.stage));
      expect(p.battle?.kind).toBe('final');
      expect(Math.abs(p.x - room.zone.x)).toBeLessThanOrEqual(2);
    }
    // Colocações seguem o ranking: estágio, troféus, vida.
    expect(bots[2].place).toBe(3);
    expect(bots[3].place).toBe(4);
    expect(bots[4].place).toBe(5);
    expect(bots[5].place).toBe(6);
    expect(bots[6].place).toBe(7);
    expect(me.place).toBe(8);
    expect(room.wilds.size).toBe(0);

    // O humano que ficou de fora recebe o motivo e passa a assistir o duelo.
    const elim = msgs.find((m) => m.t === 'elim');
    expect(elim && elim.t === 'elim' && elim.reason).toBe('duelo');
    const spectate = msgs.find((m) => m.t === 'b_start');
    expect(spectate && spectate.t === 'b_start' && spectate.spectate && spectate.kind).toBe('final');

    for (let i = 0; i < 3000 && room.state === 'play'; i++) tick();
    expect(room.state).toBe('fim');
    const winner = [bots[0], bots[1]].find((p) => p.place === 1)!;
    const loser = [bots[0], bots[1]].find((p) => p !== winner)!;
    expect(winner.alive).toBe(true);
    expect(loser.place).toBe(2);
    expect(msgs.some((m) => m.t === 'b_reveal')).toBe(true);
    expect(msgs.some((m) => m.t === 'b_end' && m.result === 'over')).toBe(true);
    const end = msgs.find((m) => m.t === 'end');
    expect(end && end.t === 'end' && end.winner?.name).toBe(winner.name);
  });

  it('termina mesmo se ninguém escolher nada: a fúria da arena garante um vencedor', () => {
    const { room, bots, tick, advanceTo } = setup();
    advanceTo(BALANCE.phases.finalEnd);
    tick();
    const bt = bots[0].battle!;
    // Os dois "saem do teclado": toda rodada é Defesa × Defesa por hesitação.
    bots[0].bot = null;
    bots[1].bot = null;
    let turns = 0;
    for (let i = 0; i < 5000 && room.state === 'play'; i++) {
      tick();
      turns = Math.max(turns, bt.turn);
    }
    expect(room.state).toBe('fim');
    expect(turns).toBeGreaterThanOrEqual(BALANCE.duel.furyFromTurn);
    expect([bots[0], bots[1]].filter((p) => p.place === 1)).toHaveLength(1);
  });

  it('se sobrarem só 2 na Caçada, o duelo começa na hora', () => {
    const { room, bots, me, tick, advanceTo } = setup();
    advanceTo(BALANCE.phases.coletaEnd + 10_000);
    tick();
    expect(room.phase).toBe('cacada');
    for (const p of [me, ...bots.slice(2)]) p.alive = false;
    tick();
    expect(room.phase).toBe('duelo');
    expect(room.duel).not.toBeNull();
    expect(bots[0].battle?.kind).toBe('final');
  });

  it('batalhas em andamento são canceladas sem troca de estágio', () => {
    const { room, bots, tick, advanceTo } = setup();
    advanceTo(BALANCE.phases.cacadaEnd + 1000);
    tick();
    room.startBattle(bots[3], bots[4]);
    const stages = [bots[3].stage, bots[4].stage];
    advanceTo(BALANCE.phases.finalEnd);
    tick();
    expect(room.phase).toBe('duelo');
    expect([bots[3].stage, bots[4].stage]).toEqual(stages);
    expect(bots[3].alive).toBe(false); // ficaram de fora, com o estágio que tinham
  });
});
