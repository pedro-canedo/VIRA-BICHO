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
  /** Eventos visuais dentro do raio de visão. Ausente quando não há evento. */
  fx?: FxEvent[];
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

// ---------- Efeitos visuais (não mudam o jogo) ----------

/** Bits de FxEvent 'h'.fl */
export const FX_CHARGED = 1; // golpe carregado (×2): o atacante estava Carregado no início do turno
export const FX_CLASH = 2; // "Ataques se chocaram": sai um 'h' para cada lado no mesmo tick
export const FX_KO = 4; // o alvo terminou o turno com HP <= 0

/** Ms depois de receber o b_reveal (painel) ou o snapshot com o 'h' (mundo) em que o golpe acerta. Relógio único das duas frentes de cliente. */
export const FX_IMPACT_MS = 600;

/** Teto de eventos por tick; o excedente é descartado. */
export const FX_MAX_PER_TICK = 48;

/**
 * Eventos visuais do tick. x/y em tiles (o centro de uma batalha pode ser .5).
 * A ordem do array segue a ordem em que tudo aconteceu no tick (ex.: 'c' vem antes do 'v' que ele causou).
 */
export type FxEvent =
  /** Batalha começou. a = quem iniciou (sempre jogador), b = alvo. kd: p = PvP, w = selvagem, f = Duelo Final. */
  | { k: 'bt'; x: number; y: number; id: number; a: number; b: number; kd: 'p' | 'w' | 'f' }
  /** Golpe com dano > 0. bt = id da batalha. act = ação do atacante. m = eficácia: 1 (>1), -1 (<1), 0. fl = bits FX_*. hp = HP do alvo depois do turno. */
  | { k: 'h'; x: number; y: number; bt: number; a: number; d: number; v: number; act: Action; m: -1 | 0 | 1; fl: number; hp: number }
  /** Fúria da arena no Duelo Final: dano va em a e vb em b, sem atacante. */
  | { k: 'fu'; x: number; y: number; bt: number; a: number; b: number; va: number; vb: number }
  /** O jogador p comeu o selvagem w, do elemento e. x2 = XP em dobro pela Fome. x/y = tile do selvagem. */
  | { k: 'c'; x: number; y: number; p: number; w: number; e: Elem; x2?: 1 }
  /** Roubo de estágio: w venceu l, que perdeu n estágios. tr = w já estava na forma final e ganhou troféu. cr = l tinha a Coroa. x/y = vencedor. */
  | { k: 's'; x: number; y: number; w: number; l: number; n: 1 | 2; tr?: 1; cr?: 1 }
  /** Evolução por XP. s = estágio novo. */
  | { k: 'v'; x: number; y: number; id: number; s: Stage }
  /** A zona queimou um estágio. s = estágio novo. */
  | { k: 'z'; x: number; y: number; id: number; s: Stage }
  /** Eliminação (a entidade já some do snapshot deste tick). by = id de quem eliminou (0 = ninguém). r: b = batalha, z = zona, d = cortado no Duelo Final. */
  | { k: 'x'; x: number; y: number; id: number; f: Form; s: Stage; o: Elem[]; by: number; r: 'b' | 'z' | 'd' }
  /** Selvagem surgiu (não é emitido no povoamento inicial). */
  | { k: 'w'; x: number; y: number; id: number; e: Elem };

export type FxKind = FxEvent['k'];

export const WS_PATH = '/ws';
