import { ACTIONS, BALANCE, type Action, type ClientMsg } from '@vb/shared';
import type { Conn } from './entities';
import { Room, type Member } from './room';
import type { Player } from './entities';
import { KeyedBuckets, SECURITY, SlidingWindow, TokenBucket, netKey, sanitizeName, type LobbyLimits, type SecKind, type SecurityConfig } from './security';

export { sanitizeName };

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const MSG = {
  helloRate: 'Calma! Espere alguns segundos antes de tentar de novo.',
  joinBrute: 'Muitas tentativas de código. Aguarde um minuto.',
  roomCap: 'Sua rede já está em salas demais ao mesmo tempo. Entre numa sala existente ou tente de novo em instantes (a partida em curso logo termina).',
  privateCap: 'Muitas salas privadas abertas agora. Use a partida rápida ou tente em instantes.',
  full: 'Servidor cheio: todas as arenas estão ocupadas. Tente em instantes.',
  createRate: 'Você criou salas demais em pouco tempo. Tente de novo em alguns minutos.',
};

export interface LobbyOptions {
  limits?: LobbyLimits;
  /** Chaves que pulam os limites por IP (local e VB_TRUSTED_IPS). */
  isExempt?: (key: string) => boolean;
  onSecurity?: (kind: SecKind, key: string, detail?: string) => void;
  game?: SecurityConfig['game'];
}

/** Gerencia salas e roteia as mensagens de cada conexão. */
export class Lobby {
  readonly rooms = new Map<string, Room>();
  private readonly members = new Map<Conn, { member: Member; room: Room }>();
  private readonly limits: LobbyLimits;
  private readonly isExempt: (key: string) => boolean;
  private readonly onSecurity: (kind: SecKind, key: string, detail?: string) => void;
  private readonly helloBuckets = new WeakMap<Conn, TokenBucket>();
  private readonly createBuckets: KeyedBuckets;
  private readonly failedJoins: SlidingWindow;
  /** Códigos errados de todas as chaves somados (contra força bruta com muitas chaves). */
  private readonly failedJoinsGlobal: SlidingWindow;
  /** Quem gastou a ficha de criação de cada sala (só chaves não isentas). */
  private readonly creators = new WeakMap<Room, string>();
  private readonly game: SecurityConfig['game'];

  constructor({ limits = SECURITY.lobby, isExempt = () => false, onSecurity = () => {}, game = SECURITY.game }: LobbyOptions = {}) {
    this.limits = limits;
    this.isExempt = isExempt;
    this.onSecurity = onSecurity;
    this.game = game;
    this.createBuckets = new KeyedBuckets(limits.roomCreate.capacity, limits.roomCreate.refillPerSec);
    this.failedJoins = new SlidingWindow(limits.failedJoin.windowMs, limits.failedJoin.max);
    this.failedJoinsGlobal = new SlidingWindow(limits.failedJoinGlobal.windowMs, limits.failedJoinGlobal.max);
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  private deny(conn: Conn, kind: SecKind, key: string, msg: string): void {
    this.onSecurity(kind, key);
    conn.send({ t: 'error', msg });
  }

  /** Quantas salas distintas têm membros com esta chave (ou, com net, deste bloco /48). */
  private roomsOf(match: (key: string) => boolean): number {
    const set = new Set<Room>();
    for (const [c, cur] of this.members) if (match(c.key ?? 'anon')) set.add(cur.room);
    return set.size;
  }

  /** Cria uma sala respeitando os limites; responde o erro e devolve null se não der. */
  private createRoom(conn: Conn, key: string, isPrivate: boolean, now: number): Room | null {
    const exempt = this.isExempt(key);
    if (!exempt) {
      const cap = isPrivate ? this.limits.maxRoomsPerIp : this.limits.maxQuickRoomsPerIp;
      const net = netKey(key);
      if (this.roomsOf((k) => k === key) >= cap || (net !== null && this.roomsOf((k) => netKey(k) === net) >= this.limits.maxRoomsPerNet)) {
        this.deny(conn, 'lobby_room_cap', key, MSG.roomCap);
        return null;
      }
    }
    if (isPrivate) {
      let privates = 0;
      for (const r of this.rooms.values()) if (r.isPrivate) privates++;
      if (privates >= this.limits.maxPrivateRooms) {
        this.deny(conn, 'lobby_private_cap', key, MSG.privateCap);
        return null;
      }
    }
    if (this.rooms.size >= this.limits.maxRooms) {
      conn.send({ t: 'error', msg: MSG.full });
      return null;
    }
    // O token só é gasto quando a sala é de fato criada.
    if (!exempt && !this.createBuckets.take(key, now)) {
      this.deny(conn, 'lobby_create_rate', key, MSG.createRate);
      return null;
    }
    const room = new Room(this.newCode(), isPrivate, undefined, { targetSlackTiles: this.game.targetSlackTiles });
    this.rooms.set(room.code, room);
    if (!exempt) this.creators.set(room, key);
    return room;
  }

  /**
   * Tira a sala da lista. Se ela nunca começou, a ficha de criação volta para quem a criou:
   * entrar e sair do lobby (ou Jogar agora / Sair) não pode esgotar a taxa de criação.
   */
  private dropRoom(room: Room, now: number): void {
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
    const creator = this.creators.get(room);
    if (creator === undefined) return;
    this.creators.delete(room);
    if (room.state === 'lobby') this.createBuckets.refund(creator, now);
  }

  handle(conn: Conn, msg: ClientMsg, now: number): void {
    const cur = this.members.get(conn);
    switch (msg.t) {
      case 'hello': {
        if (cur) this.disconnect(conn, now);
        const key = conn.key ?? 'anon';
        const exempt = this.isExempt(key);
        if (!exempt) {
          let b = this.helloBuckets.get(conn);
          if (!b) this.helloBuckets.set(conn, (b = new TokenBucket(this.limits.helloPerConn.capacity, this.limits.helloPerConn.refillPerSec, now)));
          if (!b.take(now)) return this.deny(conn, 'lobby_hello_rate', key, MSG.helloRate);
        }
        const name = sanitizeName(msg.name);
        let room: Room | null | undefined;
        if (msg.mode === 'join') {
          if (!exempt && this.failedJoins.count(key, now) >= this.limits.failedJoin.max) return this.deny(conn, 'lobby_join_bruteforce', key, MSG.joinBrute);
          if (!exempt && this.failedJoinsGlobal.count('', now) >= this.limits.failedJoinGlobal.max) return this.deny(conn, 'lobby_join_bruteforce', 'global', MSG.joinBrute);
          room = this.rooms.get((typeof msg.code === 'string' ? msg.code : '').toUpperCase().trim());
          if (!room) {
            if (!exempt) {
              this.failedJoins.hit(key, now);
              this.failedJoinsGlobal.hit('', now);
            }
            return conn.send({ t: 'error', msg: 'Sala não encontrada.' });
          }
          if (room.state !== 'lobby') return conn.send({ t: 'error', msg: 'Essa partida já começou.' });
          if (room.humans >= BALANCE.lobby.maxPlayers) return conn.send({ t: 'error', msg: 'Sala cheia.' });
        } else if (msg.mode === 'create') {
          room = this.createRoom(conn, key, true, now);
        } else {
          room = [...this.rooms.values()].find((r) => !r.isPrivate && r.state === 'lobby' && r.humans < BALANCE.lobby.maxPlayers);
          room ??= this.createRoom(conn, key, false, now);
        }
        if (!room) return; // createRoom já respondeu o motivo
        const member: Member = { conn, name, player: null };
        room.join(member, now);
        this.members.set(conn, { member, room });
        return;
      }
      case 'startnow':
        if (cur && cur.room.state === 'lobby') cur.room.startNow(now);
        return;
      case 'leave':
        this.disconnect(conn, now);
        return;
    }
    const p = cur?.member.player;
    if (!cur || !p || cur.room.state !== 'play') return;
    switch (msg.t) {
      case 'move':
        if (Number.isInteger(msg.x) && Number.isInteger(msg.y)) cur.room.commandMove(p, msg.x, msg.y);
        return;
      case 'target':
        if (Number.isInteger(msg.id)) cur.room.commandTarget(p, msg.id);
        return;
      case 'act':
        if (ACTIONS.includes(msg.a as Action)) cur.room.act(p, msg.a);
        return;
    }
  }

  disconnect(conn: Conn, now: number): void {
    const cur = this.members.get(conn);
    if (!cur) return;
    this.members.delete(conn);
    const room = cur.room;
    room.leave(cur.member);
    // Sala vazia some na hora: não fica ocupando vaga de maxRooms até o próximo tick.
    if (room.state === 'lobby' && room.humans === 0) this.dropRoom(room, now);
  }

  roomOf(conn: Conn): Room | null {
    return this.members.get(conn)?.room ?? null;
  }

  /** Jogador desta conexão numa partida em andamento (null fora de partida). */
  playerOf(conn: Conn): Player | null {
    const cur = this.members.get(conn);
    return cur && cur.room.state === 'play' ? cur.member.player : null;
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
        this.dropRoom(room, now);
        for (const [conn, cur] of this.members) if (cur.room === room) this.members.delete(conn);
      }
    }
  }

  /** Limpa baldes e janelas que já não guardam nada útil. */
  sweep(now: number): void {
    this.createBuckets.sweep(now);
    this.failedJoins.sweep(now);
    this.failedJoinsGlobal.sweep(now);
  }

  /** Números agregados; nunca expõe códigos de sala. */
  stats() {
    let players = 0;
    let privateRooms = 0;
    let lobbyRooms = 0;
    let playRooms = 0;
    for (const r of this.rooms.values()) {
      players += r.humans;
      if (r.isPrivate) privateRooms++;
      if (r.state === 'lobby') lobbyRooms++;
      else if (r.state === 'play') playRooms++;
    }
    return { rooms: this.rooms.size, privateRooms, lobbyRooms, playRooms, players };
  }
}
