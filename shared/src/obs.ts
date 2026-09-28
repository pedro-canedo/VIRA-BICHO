// Contrato entre o servidor do jogo e o observador (serviço vira-bicho-obs).
//
// O jogo expõe, só em 127.0.0.1, um endpoint interno:
//   GET {GAME_INTERNAL_URL}/internal/stats?since=<seq>
//   cabeçalho obrigatório "x-obs-token: <OBS_INTERNAL_TOKEN>" (sem ele: 401)
// e responde um ObsStats em JSON. Os contadores são cumulativos desde startedAt;
// se startedAt mudar, o jogo reiniciou e o observador recomeça a leitura dos eventos do zero.

/** Caminho do endpoint interno de estatísticas. */
export const OBS_STATS_PATH = '/internal/stats';
/** Cabeçalho com o segredo compartilhado (OBS_INTERNAL_TOKEN). */
export const OBS_TOKEN_HEADER = 'x-obs-token';
/** Endereço padrão do endpoint interno (env GAME_INTERNAL_URL). */
export const OBS_INTERNAL_DEFAULT_URL = 'http://127.0.0.1:3002';

export interface ObsQuantiles {
  p50: number;
  p99: number;
  max: number;
}

export type ObsRoomState = 'lobby' | 'play' | 'fim';

export interface ObsRoom {
  code: string;
  private: boolean;
  state: ObsRoomState;
  humans: number;
  bots: number;
  alive: number;
  /** Fase da partida (coleta, cacada, final, duelo, fim) ou "lobby". */
  phase: string;
  elapsedMs: number;
}

export interface ObsCounters {
  joins: number;
  matchesStarted: number;
  matchesEnded: number;
  battles: { wild: number; pvp: number; final: number };
  eliminations: number;
  rateLimited: number;
  rejectedConnections: number;
  originRejected: number;
  errors: number;
}

export type ObsDevice = 'mobile' | 'desktop';

export const OBS_EVENT_TYPES = ['join', 'leave', 'match_start', 'match_end', 'duel', 'security', 'error'] as const;
export type ObsEventType = (typeof OBS_EVENT_TYPES)[number];

export type ObsEventValue = string | number | boolean | null;

/**
 * Campos de cada tipo de evento (documentação; no fio o data é um Record genérico):
 * - join: { name, mode, room, country, device, gm? }
 * - leave: { name, room, reason, inMatch }
 * - match_start: { room, humans, bots, players, gm? }
 * - match_end: { room, winner, form, durationMs, humans, gm? }
 * gm = modo de jogo da sala (rapido, classico, avancado); opcional para aceitar jogos antigos.
 * - duel: { room, a, b }
 * - security: { kind, ipHash, detail }
 * - error: { message }
 */
export interface ObsEventDataMap {
  join: { name: string; mode: string; room: string; country: string; device: ObsDevice; gm?: string };
  leave: { name: string; room: string; reason: string; inMatch: boolean };
  match_start: { room: string; humans: number; bots: number; players: number; gm?: string };
  match_end: { room: string; winner: string | null; form: string | null; durationMs: number; humans: number; gm?: string };
  duel: { room: string; a: string; b: string };
  security: { kind: string; ipHash: string; detail: string };
  error: { message: string };
}

export interface ObsEvent {
  /** Sequência crescente do jogo (reinicia junto com o processo). */
  seq: number;
  /** Instante em ms desde a época. */
  t: number;
  type: ObsEventType;
  data: Record<string, ObsEventValue>;
}

export interface ObsStats {
  now: number;
  startedAt: number;
  version: string;
  process: {
    rssMB: number;
    heapUsedMB: number;
    cpuPct: number;
    eventLoopLagMs: ObsQuantiles;
    tickMs: ObsQuantiles;
  };
  connections: { open: number; total: number };
  players: { online: number; lobby: number; playing: number; spectating: number };
  rooms: ObsRoom[];
  counters: ObsCounters;
  breakdown: {
    countries: Record<string, number>;
    devices: Record<ObsDevice, number>;
  };
  /** Eventos com seq >= since (o jogo guarda um buffer limitado). */
  events: ObsEvent[];
  /** Valor a mandar em ?since= na próxima consulta. */
  nextSeq: number;
}
