import { ACTIONS, BALANCE, type Action, type ClientMsg } from '@vb/shared';
import type { Conn } from './entities';
import { Room, type Member } from './room';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function sanitizeName(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 14);
  return s || 'Bichinho';
}

/** Gerencia salas e roteia as mensagens de cada conexão. */
export class Lobby {
  readonly rooms = new Map<string, Room>();
  private readonly members = new Map<Conn, { member: Member; room: Room }>();

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  private createRoom(isPrivate: boolean): Room | null {
    if (this.rooms.size >= BALANCE.lobby.maxRooms) return null;
    const room = new Room(this.newCode(), isPrivate);
    this.rooms.set(room.code, room);
    return room;
  }

  handle(conn: Conn, msg: ClientMsg, now: number): void {
    const cur = this.members.get(conn);
    switch (msg.t) {
      case 'hello': {
        if (cur) this.disconnect(conn);
        const name = sanitizeName(msg.name);
        let room: Room | null | undefined;
        if (msg.mode === 'join') {
          room = this.rooms.get(String(msg.code ?? '').toUpperCase().trim());
          if (!room) return conn.send({ t: 'error', msg: 'Sala não encontrada.' });
          if (room.state !== 'lobby') return conn.send({ t: 'error', msg: 'Essa partida já começou.' });
          if (room.humans >= BALANCE.lobby.maxPlayers) return conn.send({ t: 'error', msg: 'Sala cheia.' });
        } else if (msg.mode === 'create') {
          room = this.createRoom(true);
        } else {
          room = [...this.rooms.values()].find((r) => !r.isPrivate && r.state === 'lobby' && r.humans < BALANCE.lobby.maxPlayers);
          room ??= this.createRoom(false);
        }
        if (!room) return conn.send({ t: 'error', msg: 'Servidor cheio: todas as arenas estão ocupadas. Tente em instantes.' });
        const member: Member = { conn, name, player: null };
        room.join(member, now);
        this.members.set(conn, { member, room });
        return;
      }
      case 'startnow':
        if (cur && cur.room.state === 'lobby') cur.room.startNow(now);
        return;
      case 'leave':
        this.disconnect(conn);
        return;
    }
    const p = cur?.member.player;
    if (!cur || !p || cur.room.state !== 'play') return;
    switch (msg.t) {
      case 'move':
        if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) cur.room.moveTo(p, msg.x, msg.y);
        return;
      case 'target':
        if (Number.isInteger(msg.id)) cur.room.setTarget(p, msg.id);
        return;
      case 'act':
        if (ACTIONS.includes(msg.a as Action)) cur.room.act(p, msg.a);
        return;
    }
  }

  disconnect(conn: Conn): void {
    const cur = this.members.get(conn);
    if (!cur) return;
    this.members.delete(conn);
    cur.room.leave(cur.member);
  }

  tick(now: number): void {
    for (const room of this.rooms.values()) {
      try {
        room.tick(now);
      } catch (err) {
        console.error(`[sala ${room.code}] erro no tick:`, err);
        room.state = 'fim';
        room.endedAt = now;
      }
      const empty = room.state === 'lobby' && room.humans === 0 && room.startsAt === null;
      const finished = room.state === 'fim' && now - room.endedAt > BALANCE.lobby.endLingerMs;
      if (empty || finished || room.abandoned) {
        this.rooms.delete(room.code);
        for (const [conn, cur] of this.members) if (cur.room === room) this.members.delete(conn);
      }
    }
  }

  stats() {
    let players = 0;
    for (const r of this.rooms.values()) players += r.humans;
    return {
      rooms: [...this.rooms.values()].map((r) => ({ code: r.code, state: r.state, humans: r.humans, private: r.isPrivate })),
      players,
    };
  }
}
