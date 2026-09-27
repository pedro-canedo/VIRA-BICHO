import { BALANCE } from '@vb/shared';
import { Room } from '../server/src/room';

export interface SimResult {
  seed: number;
  durationMs: number;
  alive: number;
  mapSize: number;
  winnerStage: number;
  winnerForm: string;
  battles: { wild: number; pvp: number };
  steals: number;
  /** O líder aos 3:00 venceu a partida? */
  leaderAt3Won: boolean;
  stageAt2: number[];
  forms: Record<string, number>;
}

/** Roda uma partida inteira só com bots, em tempo simulado. */
export function simulate(seed: number, players: number): SimResult {
  const room = new Room('SIM', true, seed);
  let now = 1_000_000;
  room.start(now, players);
  const battlesSeen = new Set<number>();
  const counts = { wild: 0, pvp: 0 };
  let leaderAt3: number | null = null;
  let stageAt2: number[] = [];
  while (room.state === 'play') {
    now += BALANCE.tickMs;
    room.tick(now);
    for (const bt of room.battles.values()) {
      if (battlesSeen.has(bt.id)) continue;
      battlesSeen.add(bt.id);
      counts[bt.kind]++;
    }
    if (stageAt2.length === 0 && room.elapsed >= BALANCE.phases.coletaEnd) stageAt2 = room.alivePlayers().map((p) => p.stage);
    if (leaderAt3 === null && room.elapsed >= 180_000) leaderAt3 = room.crownId ?? -1;
    if (room.elapsed > BALANCE.phases.hardCap + 10_000) throw new Error('partida não terminou');
  }
  const all = [...room.players.values()];
  const winner = all.find((p) => p.place === 1)!;
  const forms: Record<string, number> = {};
  for (const p of all) {
    const f = room.look(p).form;
    forms[f] = (forms[f] ?? 0) + 1;
  }
  return {
    seed,
    durationMs: room.elapsed,
    alive: room.alivePlayers().length,
    mapSize: room.map.w,
    winnerStage: winner.stage,
    winnerForm: room.look(winner).form,
    battles: counts,
    steals: all.reduce((s, p) => s + p.stats.steals, 0),
    leaderAt3Won: leaderAt3 === winner.id,
    stageAt2,
    forms,
  };
}
