/** Modos de partida: duração, tamanho do mapa e profundidade das builds. */
export type GameMode = 'rapido' | 'classico' | 'avancado';
export const GAME_MODES: readonly GameMode[] = ['rapido', 'classico', 'avancado'];

export interface ModeConfig {
  id: GameMode;
  name: string;
  icon: string;
  minutes: number;
  desc: string;
  /** Fim de cada fase em ms de partida. finalEnd = início do Duelo Final. */
  phases: { coletaEnd: number; cacadaEnd: number; finalEnd: number; hardCap: number };
  /** Multiplica o lado do mapa (48/64 tiles no modo rápido). */
  mapScale: number;
  /** Quantas habilidades cada bicho pode ter ao mesmo tempo. */
  slots: number;
  /** Habilidades de maestria (nível 3 da loja) liberadas. */
  mastery: boolean;
  /** Máximo de troféus acumulados na forma final. */
  trophyMax: number;
}

export const MODES: Record<GameMode, ModeConfig> = {
  rapido: {
    id: 'rapido',
    name: 'Rápido',
    icon: '⚡',
    minutes: 5,
    desc: '5 min · arena pequena · 4 habilidades',
    phases: { coletaEnd: 120_000, cacadaEnd: 240_000, finalEnd: 300_000, hardCap: 480_000 },
    mapScale: 1,
    slots: 4,
    mastery: false,
    trophyMax: 3,
  },
  classico: {
    id: 'classico',
    name: 'Clássico',
    icon: '⚔️',
    minutes: 10,
    desc: '10 min · arena maior · 6 habilidades e maestrias',
    phases: { coletaEnd: 210_000, cacadaEnd: 480_000, finalEnd: 600_000, hardCap: 780_000 },
    mapScale: 1.25,
    slots: 6,
    mastery: true,
    trophyMax: 5,
  },
  avancado: {
    id: 'avancado',
    name: 'Avançado',
    icon: '🧠',
    minutes: 30,
    desc: '30 min · arena enorme · 8 habilidades · builds completas',
    phases: { coletaEnd: 540_000, cacadaEnd: 1_380_000, finalEnd: 1_800_000, hardCap: 1_980_000 },
    mapScale: 1.5,
    slots: 8,
    mastery: true,
    trophyMax: 8,
  },
};

export function isGameMode(v: unknown): v is GameMode {
  return typeof v === 'string' && (GAME_MODES as readonly string[]).includes(v);
}
