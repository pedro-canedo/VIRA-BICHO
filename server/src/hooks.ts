// Ganchos de observabilidade chamados pela partida e pelo lobby (implementados por GameMetrics).
// Ficam num arquivo à parte para o room.ts depender só destes tipos: o jogo roda igual sem eles.
import type { Battle, Conn, Player } from './entities';
import type { Member, Room } from './room';

/** Chamados pela Room em momentos raros da partida (nunca a cada tick). Não podem lançar. */
export interface RoomHooks {
  matchStart(room: Room): void;
  matchEnd(room: Room, winner: Player | null): void;
  duel(room: Room, a: Player, b: Player): void;
  battle(room: Room, kind: Battle['kind']): void;
  /** Morte (o jogador renasce) ou saída da partida no Duelo Final. */
  eliminated(room: Room, p: Player): void;
}

/** Chamados pelo Lobby. `reason` da saída é um rótulo curto (saiu, fechou, caiu, ocioso...). */
export interface LobbyHooks extends RoomHooks {
  roomCreated(room: Room, now: number): void;
  join(conn: Conn, member: Member, room: Room, mode: string): void;
  leave(member: Member, room: Room, reason: string): void;
  error(where: string, err: unknown): void;
}
