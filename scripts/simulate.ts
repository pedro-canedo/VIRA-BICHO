import { BALANCE, MODES, type GameMode } from '@vb/shared';
import { dominantLine } from '../server/src/bots';
import type { Player } from '../server/src/entities';
import { Room } from '../server/src/room';

export type LineKey = 'guerreiro' | 'mago' | 'cacador' | 'nenhuma';

export interface SimResult {
  seed: number;
  gm: GameMode;
  durationMs: number;
  alive: number;
  mapSize: number;
  players: number;
  winnerStage: number;
  winnerForm: string;
  /** Linha dominante (mais habilidades) do vencedor. */
  winnerLine: LineKey;
  /** Linha dominante dos 2 finalistas. */
  finalistLines: LineKey[];
  /** Quantos jogadores terminaram com cada linha dominante. */
  lineCount: Record<LineKey, number>;
  /** Somas por linha dominante (para médias): Força no duelo, vitórias, mortes e Essência ganha. */
  lineSums: Record<LineKey, { power: number; wins: number; deaths: number; earned: number }>;
  battles: { wild: number; pvp: number; final: number };
  /** Momento em que o Duelo Final começou (ms de partida) e se os finalistas eram as 2 maiores Forças. */
  duelAt: number | null;
  duelTopTwo: boolean;
  /** Força dos finalistas no início do duelo (maior primeiro). */
  finalistPower: number[];
  /** Força média de todos no início do duelo. */
  avgPower: number;
  steals: number;
  /** Médias por jogador. */
  avgBuys: number;
  avgDeaths: number;
  avgSkills: number;
  finalistSkills: number;
  avgEssenceLeft: number;
  /** Habilidades no início de cada fase (média por jogador): [fim da Coleta, fim da Caçada]. */
  skillsAt: [number, number];
  /** O líder de Força no meio da Caçada venceu a partida? */
  leaderMidWon: boolean;
  stageAtColetaEnd: number[];
  forms: Record<string, number>;
  ranking: { place: number; power: number; deaths: number; wins: number }[];
}

const lineOf = (p: Player): LineKey => dominantLine(p.skills) ?? 'nenhuma';
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Roda uma partida inteira só com bots, em tempo simulado. */
export function simulate(seed: number, players: number, gm: GameMode = 'rapido'): SimResult {
  const room = new Room('SIM', true, seed, { gm });
  const P = MODES[gm].phases;
  let now = 1_000_000;
  room.start(now, players);
  const battlesSeen = new Set<number>();
  const counts = { wild: 0, pvp: 0, final: 0 };
  let duelAt: number | null = null;
  let duelTopTwo = false;
  let topBefore: number[] = [];
  let leaderMid: number | null = null;
  let stageAtColetaEnd: number[] = [];
  let skillsColeta = -1;
  let skillsCacada = -1;
  const mid = (P.coletaEnd + P.cacadaEnd) / 2;
  const all = () => [...room.players.values()];
  const byPower = () => room.alivePlayers().sort((p, q) => room.powerOf(q) - room.powerOf(p) || p.stats.deaths - q.stats.deaths || q.stats.wins - p.stats.wins || p.id - q.id);
  while (room.state === 'play') {
    now += BALANCE.tickMs;
    // Ranking antes do tick: o duelo pode começar dentro dele.
    if (duelAt === null && room.elapsed + BALANCE.tickMs >= P.finalEnd) topBefore = byPower().map((p) => p.id);
    room.tick(now);
    if (duelAt === null && room.duel) {
      duelAt = room.elapsed;
      const ids = [room.duel.a.id, room.duel.b.id].sort();
      duelTopTwo = JSON.stringify(ids) === JSON.stringify(topBefore.slice(0, 2).sort());
    }
    for (const bt of room.battles.values()) {
      if (battlesSeen.has(bt.id)) continue;
      battlesSeen.add(bt.id);
      counts[bt.kind]++;
    }
    if (stageAtColetaEnd.length === 0 && room.elapsed >= P.coletaEnd) {
      stageAtColetaEnd = room.alivePlayers().map((p) => p.stage);
      skillsColeta = avg(all().map((p) => p.skills.length));
    }
    if (skillsCacada < 0 && room.elapsed >= P.cacadaEnd) skillsCacada = avg(all().map((p) => p.skills.length));
    if (leaderMid === null && room.elapsed >= mid) leaderMid = byPower()[0]?.id ?? -1;
    if (room.elapsed > P.hardCap + 10_000) throw new Error('partida não terminou');
  }
  const ps = all();
  const winner = ps.find((p) => p.place === 1)!;
  const forms: Record<string, number> = {};
  const lineCount: Record<LineKey, number> = { guerreiro: 0, mago: 0, cacador: 0, nenhuma: 0 };
  const zero = () => ({ power: 0, wins: 0, deaths: 0, earned: 0 });
  const lineSums: SimResult['lineSums'] = { guerreiro: zero(), mago: zero(), cacador: zero(), nenhuma: zero() };
  for (const p of ps) {
    const f = room.look(p).form;
    forms[f] = (forms[f] ?? 0) + 1;
    const l = lineOf(p);
    lineCount[l]++;
    lineSums[l].power += p.duelPower ?? 0;
    lineSums[l].wins += p.stats.wins;
    lineSums[l].deaths += p.stats.deaths;
    lineSums[l].earned += p.stats.earned;
  }
  const finalists = room.duel ? [room.duel.a, room.duel.b] : [];
  return {
    seed,
    gm,
    durationMs: room.elapsed,
    alive: room.alivePlayers().length,
    mapSize: room.map.w,
    players: ps.length,
    winnerStage: winner.stage,
    winnerForm: room.look(winner).form,
    winnerLine: lineOf(winner),
    finalistLines: finalists.map(lineOf),
    lineCount,
    lineSums,
    battles: counts,
    duelAt,
    duelTopTwo,
    finalistPower: finalists.map((p) => p.duelPower ?? 0).sort((a, b) => b - a),
    avgPower: avg(ps.map((p) => p.duelPower ?? 0)),
    steals: ps.reduce((s, p) => s + p.stats.steals, 0),
    avgBuys: avg(ps.map((p) => p.stats.buys)),
    avgDeaths: avg(ps.map((p) => p.stats.deaths)),
    avgSkills: avg(ps.map((p) => p.skills.length)),
    finalistSkills: avg(finalists.map((p) => p.skills.length)),
    avgEssenceLeft: avg(ps.map((p) => p.essence)),
    skillsAt: [skillsColeta, skillsCacada],
    leaderMidWon: leaderMid === winner.id,
    stageAtColetaEnd,
    forms,
    ranking: ps
      .sort((p, q) => p.place - q.place)
      .map((p) => ({ place: p.place, power: p.duelPower ?? 0, deaths: p.stats.deaths, wins: p.stats.wins })),
  };
}
