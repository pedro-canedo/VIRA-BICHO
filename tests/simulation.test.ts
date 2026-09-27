import { describe, expect, it } from 'vitest';
import { BALANCE, type ServerMsg } from '@vb/shared';
import { Room, type Member } from '../server/src/room';
import { simulate } from '../scripts/simulate';

describe('partida simulada só com bots', () => {
  it('termina com um único vencedor, decidido no Duelo Final entre os 2 mais evoluídos', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const r = simulate(seed, 16);
      expect(r.alive).toBe(1);
      expect(r.battles.final).toBe(1);
      expect(r.duelAt).not.toBeNull();
      expect(r.duelAt!).toBeLessThanOrEqual(BALANCE.phases.finalEnd + BALANCE.tickMs);
      expect(r.durationMs).toBeLessThan(BALANCE.phases.hardCap);
      expect(r.battles.wild).toBeGreaterThan(50);
      expect(r.battles.pvp).toBeGreaterThan(15);
    }
  });

  it('funciona com 8 jogadores (mapa menor)', () => {
    const r = simulate(42, 8);
    expect(r.alive).toBe(1);
    expect(r.mapSize).toBe(48);
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

    // O humano anda até um bicho selvagem e batalha.
    const me = member.player!;
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
