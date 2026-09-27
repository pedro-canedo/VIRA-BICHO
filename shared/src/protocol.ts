import type { Fruit } from './mapgen';
import type { Action, Elem, Form, Look, Phase, Stage, TypePoints } from './types';

// ---------- Cliente → servidor ----------

export type ClientMsg =
  | { t: 'hello'; name: string; mode: 'quick' | 'create' | 'join'; code?: string }
  | { t: 'move'; x: number; y: number }
  | { t: 'target'; id: number }
  | { t: 'act'; a: Action }
  | { t: 'startnow' }
  | { t: 'leave' };

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
  | { t: 'b_start'; id: number; kind: 'pvp' | 'wild'; you: FighterInfo; opp: FighterInfo; turn: number; ms: number }
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
  | { t: 'b_end'; id: number; result: 'win' | 'lose' | 'draw' | 'flee'; text: string }
  | { t: 'feed'; text: string; kind: 'steal' | 'elim' | 'evo' | 'info' | 'phase' }
  | { t: 'toast'; text: string }
  | { t: 'elim'; by: string | null; place: number }
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
