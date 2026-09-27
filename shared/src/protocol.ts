import type { Fruit } from './mapgen';
import { ACTIONS, type Action, type Elem, type Form, type Look, type Phase, type Stage, type TypePoints } from './types';

// ---------- Cliente → servidor ----------

export type ClientMsg =
  | { t: 'hello'; name: string; mode: 'quick' | 'create' | 'join'; code?: string }
  | { t: 'move'; x: number; y: number }
  | { t: 'target'; id: number }
  | { t: 'act'; a: Action }
  | { t: 'startnow' }
  | { t: 'leave' };

export const PROTOCOL_LIMITS = { nameMaxRaw: 64, codeMaxRaw: 8, coordAbs: 1024 } as const;

const MODES = ['quick', 'create', 'join'] as const;
const coord = (v: unknown): v is number => Number.isSafeInteger(v) && Math.abs(v as number) <= PROTOCOL_LIMITS.coordAbs;

/**
 * Valida uma mensagem do cliente vinda do JSON. Devolve sempre um objeto novo só com os campos
 * conhecidos (nunca o objeto recebido), ou null se algo estiver fora do formato.
 */
export function parseClientMsg(v: unknown): ClientMsg | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  switch (m.t) {
    case 'hello': {
      const { name, mode, code } = m;
      if (typeof name !== 'string' || name.length > PROTOCOL_LIMITS.nameMaxRaw) return null;
      if (!MODES.includes(mode as (typeof MODES)[number])) return null;
      if (code !== undefined && (typeof code !== 'string' || code.length > PROTOCOL_LIMITS.codeMaxRaw)) return null;
      const out: ClientMsg = { t: 'hello', name, mode: mode as (typeof MODES)[number] };
      if (code !== undefined) out.code = code;
      return out;
    }
    case 'move':
      return coord(m.x) && coord(m.y) ? { t: 'move', x: m.x, y: m.y } : null;
    case 'target':
      return Number.isSafeInteger(m.id) && (m.id as number) > 0 ? { t: 'target', id: m.id as number } : null;
    case 'act':
      return ACTIONS.includes(m.a as Action) ? { t: 'act', a: m.a as Action } : null;
    case 'startnow':
      return { t: 'startnow' };
    case 'leave':
      return { t: 'leave' };
    default:
      return null;
  }
}

// ---------- Servidor → cliente ----------

export interface EntSnap {
  id: number;
  /** p = jogador, w = selvagem */
  k: 'p' | 'w';
  x: number;
  y: number;
  n?: string;
  f: Form;
  s: Stage;
  o: Elem[];
  hp: number;
  mhp: number;
  /** id da batalha em andamento */
  b?: number;
  cr?: 1;
  sh?: 1;
  ch?: 1;
  tr?: number;
}

export interface BattleSnap {
  id: number;
  x: number;
  y: number;
}

export interface SelfSnap {
  id: number;
  x: number;
  y: number;
  look: Look;
  xp: number;
  xpNeed: number;
  hp: number;
  mhp: number;
  points: TypePoints;
  trophies: number;
  shieldMs: number;
  hungerMs: number;
  alive: boolean;
  crown: boolean;
  battle: number | null;
  target: number | null;
}

export interface LeaderRow {
  id: number;
  n: string;
  s: Stage;
  f: Form;
  cr?: 1;
}

export interface Snap {
  t: 'snap';
  /** tempo de partida decorrido (ms) */
  el: number;
  ph: Phase;
  /** zona atual e raio alvo ao fim da fase */
  z: { x: number; y: number; r: number; tr: number };
  al: number;
  ents: EntSnap[];
  bs: BattleSnap[];
  /** índices das frutas disponíveis */
  fr: number[];
  me: SelfSnap | null;
  /** entidade seguida pela câmera (você ou quem você assiste) */
  view: number | null;
  crown: { x: number; y: number } | null;
  lb: LeaderRow[];
  /** Finalistas do Duelo Final, quando ele está acontecendo. */
  duel: { a: string; b: string } | null;
}

export interface FighterInfo {
  name: string;
  look: Look;
  hp: number;
  mhp: number;
  charged: boolean;
  trophies: number;
  wild: boolean;
}

export interface HistoryItem {
  el: number;
  look: Look;
  ev: string;
}

export type ServerMsg =
  | {
      t: 'lobby';
      code: string;
      private: boolean;
      players: string[];
      startsIn: number | null;
      min: number;
      max: number;
    }
  | { t: 'start'; you: number; w: number; h: number; tiles: string; fruits: Fruit[]; players: number }
  | Snap
  | {
      t: 'b_start';
      id: number;
      kind: 'pvp' | 'wild' | 'final';
      you: FighterInfo;
      opp: FighterInfo;
      turn: number;
      ms: number;
      /** true para quem só assiste (o Duelo Final é transmitido para todos). */
      spectate?: boolean;
    }
  | { t: 'b_turn'; id: number; turn: number; ms: number }
  | {
      t: 'b_reveal';
      id: number;
      turn: number;
      you: Action;
      opp: Action;
      dmgYou: number;
      dmgOpp: number;
      hpYou: number;
      hpOpp: number;
      chYou: boolean;
      chOpp: boolean;
      winner: 'you' | 'opp' | 'tie';
      text: string;
    }
  | { t: 'b_end'; id: number; result: 'win' | 'lose' | 'draw' | 'flee' | 'over'; text: string }
  | { t: 'feed'; text: string; kind: 'steal' | 'elim' | 'evo' | 'info' | 'phase' }
  | { t: 'toast'; text: string }
  | { t: 'elim'; by: string | null; place: number; reason: 'batalha' | 'zona' | 'duelo' }
  | {
      t: 'end';
      winner: { name: string; look: Look } | null;
      place: number;
      total: number;
      you: { name: string; look: Look; wins: number; steals: number; wilds: number };
      history: HistoryItem[];
    }
  | { t: 'error'; msg: string };

export const WS_PATH = '/ws';
