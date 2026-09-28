import type { Action, Elem, HistoryItem, Line, ServerMsg, SkillId, SkillMods, Stage, TypePoints, Vec } from '@vb/shared';

export interface Conn {
  send(msg: ServerMsg): void;
  /** Chave de rate limit (IP ou /64). Opcional: o Lobby usa 'anon' sem ela. */
  key?: string;
}

export interface BotBrain {
  pref: Elem;
  nextThinkAt: number;
  /** Agressividade (0..1): chance de caçar jogadores quando possível. */
  aggro: number;
  /** Linha de habilidades preferida (compra primeiro as dela). */
  line: Line;
  /** Segunda linha (as vagas que sobram depois da linha preferida). */
  second: Line;
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
  /** Destino pedido pelo humano, aplicado no próximo tick (no máximo 1 A* por tick). */
  pendingDest: Vec | null;
  /** Último destino de moveTo, para não refazer o A* com o mesmo pedido. */
  lastDest: Vec | null;
  lastToastAt: number;
  eliminatedBy: string | null;
  killerId: number | null;
  place: number;
  history: HistoryItem[];
  /** buys = compras; earned = Essência ganha na partida (métricas e simulação). */
  stats: { wins: number; steals: number; wilds: number; deaths: number; buys: number; earned: number };
  /** Moeda da loja. */
  essence: number;
  /** Habilidades compradas, na ordem da compra. */
  skills: SkillId[];
  /** modsOf(skills), recalculado a cada compra. */
  mods: SkillMods;
  /** Chocando até este instante (nasceu ou renasceu): não anda, não mira e não pode ser alvo. */
  hatchUntil: number;
  /** Força no início do Duelo Final (ordena o ranking de quem ficou de fora). */
  duelPower: number | null;
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
  kind: 'pvp' | 'wild' | 'final';
  a: Player;
  b: Entity;
  turn: number;
  phase: 'choose' | 'reveal';
  deadline: number;
  choice: { a: Action | null; b: Action | null };
  /** Quando um bot/selvagem vai escolher. */
  autoAt: { a: number | null; b: number | null };
  charged: { a: boolean; b: boolean };
  /** Estado da build de cada lado nesta batalha: usos do Especial e passivas de uma vez. */
  specialLeft: { a: number; b: number };
  shieldUsed: { a: boolean; b: boolean };
  dodgeUsed: { a: boolean; b: boolean };
  cx: number;
  cy: number;
}
