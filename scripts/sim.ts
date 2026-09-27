// Roda várias partidas só com bots e imprime estatísticas de balanceamento.
// Uso: npm run sim -- [partidas] [jogadores]
import { simulate } from './simulate';

const games = Number(process.argv[2] ?? 30);
const players = Number(process.argv[3] ?? 16);
const rs = Array.from({ length: games }, (_, i) => simulate(1000 + i, players));
const d = rs.map((r) => r.durationMs / 1000).sort((a, b) => a - b);
const s2 = rs.flatMap((r) => r.stageAt2);
const forms: Record<string, number> = {};
for (const r of rs) forms[r.winnerForm] = (forms[r.winnerForm] ?? 0) + 1;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
console.log(`${games} partidas com ${players} jogadores`);
console.log(`  duração: mín ${fmt(d[0])}  mediana ${fmt(d[Math.floor(games / 2)])}  máx ${fmt(d.at(-1)!)}`);
console.log(`  decididas no limite de 6:00: ${rs.filter((r) => r.durationMs >= 360_000).length}`);
console.log(`  líder aos 3:00 venceu: ${rs.filter((r) => r.leaderAt3Won).length}/${games}`);
console.log(`  batalhas por partida: ${(rs.reduce((s, r) => s + r.battles.wild, 0) / games).toFixed(0)} contra selvagens, ${(rs.reduce((s, r) => s + r.battles.pvp, 0) / games).toFixed(0)} entre jogadores`);
console.log(`  estágio médio ao fim da Coleta: ${(s2.reduce((a, b) => a + b, 0) / s2.length).toFixed(2)}`);
console.log(`  formas vencedoras: ${JSON.stringify(forms)}`);
