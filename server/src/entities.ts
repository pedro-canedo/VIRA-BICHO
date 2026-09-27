import type { Action, Elem, HistoryItem, ServerMsg, Stage, TypePoints, Vec } from '@vb/shared';

export interface Conn {
  send(msg: ServerMsg): void;
}

export interface BotBrain {
  pref: Elem;
  nextThinkAt: number;
  /** Agressividade (0..1): chance de caçar jogadores quando possível. */
  aggro: number;
}

interface EntityBase {
  id: number;
  x: number;
  y: number;
  path: Vec[];
  nextStepAt: number;
  hp: number;
  battle: Battle | null;
}

export interface Player extends EntityBase {
  kind: 'player';
  name: string;
  conn: Conn | null;
  bot: BotBrain | null;
  stage: Stage;
  xp: number;
  points: TypePoints;
  trophies: number;
  alive: boolean;
  shieldUntil: number;
  hungerUntil: number;
  target: number | null;
  targetSeenAt: Vec | null;
  repathAt: number;
  lastToastAt: number;
  eliminatedBy: string | null;
  killerId: number | null;
  place: number;
  history: HistoryItem[];
  stats: { wins: number; steals: number; wilds: number };
}

export interface Wild extends EntityBase {
  kind: 'wild';
  elem: Elem;
  maxHp: number;
  wanderAt: number;
}

export type Entity = Player | Wild;

export type Side = 'a' | 'b';

export interface Battle {
  id: number;
  kind: 'pvp' | 'wild';
  a: Player;
  b: Entity;
  turn: number;
  phase: 'choose' | 'reveal';
  deadline: number;
  choice: { a: Action | null; b: Action | null };
  /** Quando um bot/selvagem vai escolher. */
  autoAt: { a: number | null; b: number | null };
  charged: { a: boolean; b: boolean };
  cx: number;
  cy: number;
}
