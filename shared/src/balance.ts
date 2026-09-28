/**
 * Todos os números do jogo em um só lugar, para facilitar o balanceamento.
 * Tempos em milissegundos, distâncias em tiles.
 */
export const BALANCE = {
  tickMs: 100,
  /** Tempo para andar 1 tile. */
  stepMs: 150,
  /** Selvagens andam mais devagar. */
  wildStepMs: 420,

  /** XP necessário para sair de cada estágio (ovo→filhote, filhote→adulto, adulto→final). Cumulativo: 3 / 7 / 12. */
  xpToEvolve: [3, 4, 5] as readonly number[],
  hp: [40, 60, 85, 110] as const,
  dmg: [10, 14, 18, 22] as const,

  typeStrong: 1.5,
  typeWeak: 0.67,
  /** O 2º tipo precisa ter pelo menos esta fração do 1º para virar híbrido. */
  hybridRatio: 0.4,
  /** O 3º tipo precisa ter pelo menos esta fração do 1º para virar Quimera. */
  quimeraRatio: 0.7,
  quimeraMinPoints: 3,

  battle: {
    choiceMsPlayer: 5000,
    choiceMsWild: 3000,
    revealMs: 1400,
    maxTurns: 4,
    /** Multiplicadores por resultado do turno. */
    attackHit: 1,
    defenseCounter: 0.5,
    chargeHit: 0.5,
    tieAttack: 0.5,
    chargedMult: 2,
  },

  regenPctPerSec: 0.02,
  healOnWildPct: 0.15,
  /** HP (fração do máximo) com que o perdedor de uma batalha volta ao mapa. */
  loserHpPct: 0.5,
  /** HP com que o jogador volta depois de perder para um selvagem. */
  wildLossHpPct: 0.25,

  trophyBonus: 0.1,
  trophyMax: 3,
  /** Na fase Final, perder custa este número de estágios ("derrota dobrada"). */
  finalLossStages: 2,
  /** Fração dos pontos de tipo do perdedor absorvida pelo vencedor. */
  absorbFrac: 0.5,

  crownXpBonus: 3,
  crownPingEveryMs: 20000,
  crownPingShowMs: 4000,

  hungerShieldMs: 5000,
  hungerXpMs: 30000,
  hungerXpMult: 2,
  drawShieldMs: 3000,
  zoneLossShieldMs: 3000,

  fruitPoints: 3,
  fruitXp: 1,
  fruitRespawnMs: 45000,

  phases: {
    coletaEnd: 120_000,
    cacadaEnd: 240_000,
    /** Início do Duelo Final entre os 2 mais evoluídos. */
    finalEnd: 300_000,
    /** Trava de segurança: o duelo sempre termina bem antes disso. */
    hardCap: 480_000,
  },
  zone: {
    /** Raio no fim da Caçada, como fração do raio inicial. */
    cacadaFrac: 0.5,
    finalRadius: 6,
    /** Dano por segundo fora da zona, como fração do HP máximo. */
    dpsPct: 0.06,
  },

  /** Duelo Final: os 2 mais evoluídos lutam até um cair, com HP cheio. */
  duel: {
    choiceMs: 6000,
    /** A partir deste turno, a "fúria da arena" tira HP dos dois a cada turno, garantindo um fim. */
    furyFromTurn: 5,
    furyPct: 0.1,
  },

  wild: {
    hpMin: 8,
    hpMax: 14,
    dmg: 6,
    perPlayer: 3,
    /** Multiplicador da população de selvagens por fase. */
    phaseMult: { coleta: 1, cacada: 0.5, final: 0, duelo: 0, fim: 0 },
    min: 14,
    max: 44,
    respawnMs: 5000,
  },

  lobby: {
    minPlayers: 8,
    maxPlayers: 16,
    waitMs: 30_000,
    maxRooms: 10,
    endLingerMs: 20_000,
  },

  /** Essência: moeda da loja de habilidades. */
  essence: {
    start: 2,
    wild: 1,
    fruit: 2,
    pvpWin: 3,
    /** Bônus extra por derrubar quem está com a Coroa. */
    crown: 3,
    /** Por mandar alguém de volta ao ovo. */
    kill: 2,
  },

  /** Ninguém é eliminado: quem morre renasce do ovo, perdendo parte do que juntou. */
  respawn: {
    /** Tempo chocando (sem andar, sem ser alvo) no início da partida e a cada renascimento. */
    hatchMs: 2500,
    essenceKeep: 0.5,
    pointsKeep: 0.5,
    /** Distância mínima (tiles) de outros jogadores ao renascer. */
    minDist: 6,
  },

  /** Raio de visão enviado nos snapshots. */
  viewRadius: 15,
  /** Distância (Chebyshev) para iniciar uma batalha. */
  engageRange: 1,
} as const;

export type Balance = typeof BALANCE;

/** XP total acumulado necessário para chegar ao estágio `s`. */
export function xpForStage(s: number): number {
  let total = 0;
  for (let i = 0; i < s; i++) total += BALANCE.xpToEvolve[i] ?? 0;
  return total;
}
