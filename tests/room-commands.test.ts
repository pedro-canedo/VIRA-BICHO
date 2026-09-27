import { beforeEach, describe, expect, it } from 'vitest';
import { chebyshev, nearestWalkable, type Vec } from '@vb/shared';
import type { Player, Wild } from '../server/src/entities';
import { Room, type Member } from '../server/src/room';

let room: Room;
let me: Player;
let wild: Wild;
let now: number;

/** Sala em jogo com os bots parados, para medir só os comandos do humano. */
beforeEach(() => {
  room = new Room('TEST', true, 123);
  const member: Member = { conn: { send: () => {} }, name: 'Pedro', player: null };
  now = 1_000_000;
  room.join(member, now);
  room.startNow(now);
  room.tick((now += 100));
  me = member.player!;
  for (const p of room.players.values()) {
    if (p === me) continue;
    p.bot = null;
    p.target = null;
    p.path = [];
  }
  wild = [...room.wilds.values()][0];
});

const tick = () => room.tick((now += 100));

/** Um tile andável a ~d tiles de distância de mim. */
function farTile(d: number): Vec {
  const x = me.x + d < room.map.w ? me.x + d : me.x - d;
  return nearestWalkable(room.map, x, me.y);
}

function placeWild(d: number): void {
  const x = me.x + d < room.map.w ? me.x + d : me.x - d;
  wild.x = x;
  wild.y = me.y;
  wild.path = [];
  wild.wanderAt = Infinity;
}

describe('comandos humanos coalescidos por tick', () => {
  it('50 moves no mesmo tick custam no máximo 1 A*', () => {
    const before = room.pathfinds;
    for (let i = 0; i < 50; i++) room.commandMove(me, me.x + (i % 7) - 3, me.y + (i % 5) - 2);
    tick();
    expect(room.pathfinds - before).toBeLessThanOrEqual(1);
  });

  it('o mesmo destino repetido em vários ticks custa 1 A*', () => {
    const dest = farTile(12);
    const before = room.pathfinds;
    for (let i = 0; i < 3; i++) {
      room.commandMove(me, dest.x, dest.y);
      tick();
    }
    expect(room.pathfinds - before).toBe(1);
  });

  it('move e depois target no mesmo tick: o target vence', () => {
    const spot = farTile(5);
    wild.x = spot.x;
    wild.y = spot.y;
    wild.wanderAt = Infinity;
    const dest = farTile(10);
    room.commandMove(me, dest.x, dest.y);
    room.commandTarget(me, wild.id);
    tick();
    expect(me.target).toBe(wild.id);
  });

  it('target e depois move no mesmo tick: o move vence', () => {
    placeWild(5);
    const dest = farTile(10);
    room.commandTarget(me, wild.id);
    room.commandMove(me, dest.x, dest.y);
    tick();
    expect(me.target).toBeNull();
    expect(me.path.at(-1)).toEqual(dest);
  });
});

describe('alvo recusado não cancela o movimento', () => {
  it('move e depois target no próprio id: o move continua valendo', () => {
    const dest = farTile(10);
    room.commandMove(me, dest.x, dest.y);
    room.commandTarget(me, me.id);
    expect(me.pendingDest).toEqual(dest);
    tick();
    expect(me.target).toBeNull();
    expect(me.path.at(-1)).toEqual(dest);
  });

  it('setTarget informa se aceitou', () => {
    placeWild(5);
    expect(room.setTarget(me, me.id)).toBe(false);
    expect(room.setTarget(me, 999_999)).toBe(false);
    expect(room.setTarget(me, wild.id)).toBe(true);
  });
});

describe('mira humana só dentro do raio de visão', () => {
  it('recusa alvo longe demais e aceita dentro do raio (com folga)', () => {
    placeWild(30);
    expect(chebyshev(me, wild)).toBe(30);
    room.commandTarget(me, wild.id);
    expect(me.target).toBeNull();

    placeWild(10);
    room.commandTarget(me, wild.id);
    expect(me.target).toBe(wild.id);

    me.target = null;
    placeWild(18);
    room.commandTarget(me, wild.id);
    expect(me.target).toBe(wild.id);
  });

  it('a folga vem do construtor da sala', () => {
    const strict = new Room('STRC', true, 123, { targetSlackTiles: 0 });
    const m: Member = { conn: { send: () => {} }, name: 'Rígido', player: null };
    strict.join(m, now);
    strict.startNow(now);
    strict.tick(now + 100);
    const p = m.player!;
    const w = [...strict.wilds.values()][0];
    w.x = p.x + 18 < strict.map.w ? p.x + 18 : p.x - 18;
    w.y = p.y;
    w.wanderAt = Infinity;
    expect(chebyshev(p, w)).toBe(18);
    // Na sala padrão (folga 4) 18 tiles passam; com folga 0 não.
    strict.commandTarget(p, w.id);
    expect(p.target).toBeNull();
  });

  it('bots continuam mirando direto pelo setTarget', () => {
    placeWild(30);
    room.setTarget(me, wild.id);
    expect(me.target).toBe(wild.id);
  });
});
