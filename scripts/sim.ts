// Roda várias partidas só com bots e imprime estatísticas de balanceamento.
// Uso: npm run sim -- [partidas] [jogadores] [modo: rapido | classico | avancado]
import { isGameMode, MODES, type GameMode } from '@vb/shared';
import { simulate, type LineKey } from './simulate';

const games = Number(process.argv[2] ?? 30);
const players = Number(process.argv[3] ?? 16);
const gmArg = process.argv[4] ?? 'rapido';
if (!isGameMode(gmArg)) throw new Error(`modo desconhecido: ${gmArg} (use rapido, classico ou avancado)`);
const gm: GameMode = gmArg;

const t0 = performance.now();
const rs = Array.from({ length: games }, (_, i) => simulate(1000 + i, players, gm));
const ms = performance.now() - t0;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const pct = (n: number, d: number) => `${Math.round((100 * n) / Math.max(1, d))}%`;

const d = rs.map((r) => r.durationMs / 1000).sort((a, b) => a - b);
const duels = rs.filter((r) => r.duelAt !== null);
const s2 = rs.flatMap((r) => r.stageAtColetaEnd);
const forms: Record<string, number> = {};
for (const r of rs) forms[r.winnerForm] = (forms[r.winnerForm] ?? 0) + 1;

console.log(`${games} partidas com ${players} jogadores no modo ${MODES[gm].name} (${(ms / 1000).toFixed(1)} s de simulação, mapa ${rs[0].mapSize}×${rs[0].mapSize})`);
console.log(`  duração: mín ${fmt(d[0])}  mediana ${fmt(med(d))}  máx ${fmt(d.at(-1)!)}`);
console.log(
  `  Duelo Final: ${duels.length}/${games} partidas, aos ${fmt(avg(duels.map((r) => r.duelAt! / 1000)))}; finalistas eram as 2 maiores Forças em ${rs.filter((r) => r.duelTopTwo).length}; duelo dura (mediana) ${fmt(med(duels.map((r) => (r.durationMs - r.duelAt!) / 1000)))}`,
);
console.log(
  `  Força dos finalistas: 1º ${avg(rs.map((r) => r.finalistPower[0] ?? 0)).toFixed(0)} e 2º ${avg(rs.map((r) => r.finalistPower[1] ?? 0)).toFixed(0)} (média geral ${avg(rs.map((r) => r.avgPower)).toFixed(0)})`,
);
console.log(`  líder de Força no meio da Caçada venceu: ${rs.filter((r) => r.leaderMidWon).length}/${games}`);
console.log(
  `  batalhas por partida: ${avg(rs.map((r) => r.battles.wild)).toFixed(0)} contra selvagens, ${avg(rs.map((r) => r.battles.pvp)).toFixed(0)} entre jogadores`,
);
console.log(`  estágio médio ao fim da Coleta: ${avg(s2).toFixed(2)}`);
console.log(
  `  por jogador: ${avg(rs.map((r) => r.avgBuys)).toFixed(1)} compras, ${avg(rs.map((r) => r.avgDeaths)).toFixed(1)} mortes, ${avg(rs.map((r) => r.avgSkills)).toFixed(1)} habilidades no duelo (finalistas ${avg(rs.map((r) => r.finalistSkills)).toFixed(1)}), ${avg(rs.map((r) => r.avgEssenceLeft)).toFixed(1)} ✨ sobrando`,
);
console.log(
  `  habilidades (média): fim da Coleta ${avg(rs.map((r) => r.skillsAt[0])).toFixed(1)}, fim da Caçada ${avg(rs.map((r) => r.skillsAt[1])).toFixed(1)}, duelo ${avg(rs.map((r) => r.avgSkills)).toFixed(1)} (vagas: ${MODES[gm].slots})`,
);
const lines: LineKey[] = ['guerreiro', 'mago', 'cacador', 'nenhuma'];
const winsBy = (l: LineKey) => rs.filter((r) => r.winnerLine === l).length;
const finalsBy = (l: LineKey) => rs.reduce((s, r) => s + r.finalistLines.filter((x) => x === l).length, 0);
const countBy = (l: LineKey) => rs.reduce((s, r) => s + r.lineCount[l], 0);
const totalPlayers = rs.reduce((s, r) => s + r.players, 0);
const sumBy = (l: LineKey, k: 'power' | 'wins' | 'deaths' | 'earned') => rs.reduce((s, r) => s + r.lineSums[l][k], 0) / Math.max(1, countBy(l));
console.log('  por linha dominante: vitórias da partida | vagas no duelo | jogadores | médias por jogador (Força no duelo, vitórias PvP, mortes, ✨ ganha)');
for (const l of lines) {
  if (countBy(l) === 0 && winsBy(l) === 0) continue;
  console.log(
    `    ${l.padEnd(9)} ${String(winsBy(l)).padStart(3)} (${pct(winsBy(l), games).padStart(4)}) | ${pct(finalsBy(l), 2 * duels.length).padStart(4)} | ${pct(countBy(l), totalPlayers).padStart(4)} | Força ${sumBy(l, 'power').toFixed(0)}, ${sumBy(l, 'wins').toFixed(1)} vitórias, ${sumBy(l, 'deaths').toFixed(1)} mortes, ${sumBy(l, 'earned').toFixed(0)} ✨`,
  );
}
console.log(`  formas vencedoras: ${JSON.stringify(forms)}`);
