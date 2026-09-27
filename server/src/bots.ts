import { ELEMS, biomeAt, chebyshev, isWalkable, maxHp, type Action, type Rng, type Vec } from '@vb/shared';
import type { BotBrain, Player } from './entities';
import type { Room } from './room';

export function makeBrain(rng: Rng): BotBrain {
  return { pref: rng.pick(ELEMS), nextThinkAt: 0, aggro: 0.35 + rng.next() * 0.55 };
}

function weighted(rng: Rng, w: Record<Action, number>): Action {
  const total = w.ataque + w.defesa + w.carga;
  let r = rng.next() * total;
  for (const a of ['ataque', 'defesa', 'carga'] as const) {
    r -= w[a];
    if (r <= 0) return a;
  }
  return 'defesa';
}

/** Escolha do bot na batalha: um pouco de leitura, bastante imprevisibilidade. */
export function botChoose(rng: Rng, selfCharged: boolean, oppCharged: boolean, hpPct: number): Action {
  if (selfCharged) return weighted(rng, { ataque: 0.5, defesa: 0.2, carga: 0.3 });
  if (oppCharged) return weighted(rng, { ataque: 0.3, defesa: 0.45, carga: 0.25 });
  if (hpPct < 0.35) return weighted(rng, { ataque: 0.3, defesa: 0.4, carga: 0.3 });
  return weighted(rng, { ataque: 0.4, defesa: 0.3, carga: 0.3 });
}

export function wildChoose(rng: Rng): Action {
  return weighted(rng, { ataque: 0.45, defesa: 0.3, carga: 0.25 });
}

const hpPct = (p: Player) => p.hp / maxHp(p.stage);

/** Ponto aleatório dentro da zona, de preferência no bioma escolhido. */
function randomSpot(room: Room, pref: Vec | null, elem: BotBrain['pref'] | null): Vec | null {
  const m = room.map;
  for (let i = 0; i < 30; i++) {
    const base = pref ?? { x: room.zone.x, y: room.zone.y };
    const spread = pref ? 8 : room.zone.r * 0.8;
    const x = Math.round(base.x + (room.rng.next() * 2 - 1) * spread);
    const y = Math.round(base.y + (room.rng.next() * 2 - 1) * spread);
    if (!isWalkable(m, x, y) || !room.inZone({ x, y }, 2)) continue;
    if (elem && i < 20 && biomeAt(m, x, y) !== elem) continue;
    return { x, y };
  }
  return null;
}

export function botThink(room: Room, p: Player, now: number): void {
  const brain = p.bot!;
  brain.nextThinkAt = now + 500 + room.rng.next() * 500;
  const zone = room.zone;

  // 1. Fugir da zona: vai em direção ao centro.
  const distCenter = Math.hypot(p.x - zone.x, p.y - zone.y);
  if (distCenter > Math.max(0.5, zone.r - 2) && zone.r < zone.r0) {
    const t = Math.max(0, (zone.r * 0.5) / Math.max(1, distCenter));
    room.moveTo(p, zone.x + (p.x - zone.x) * t, zone.y + (p.y - zone.y) * t);
    return;
  }

  const players = room.alivePlayers().filter((q) => q !== p);
  const hunting = room.phase !== 'coleta';

  // 2. Com pouca vida e alguém forte por perto: recuar.
  if (hunting && hpPct(p) < 0.35) {
    const threat = players.find((q) => chebyshev(p, q) <= 5 && q.stage >= p.stage && !q.battle);
    if (threat) {
      const dx = p.x - threat.x;
      const dy = p.y - threat.y;
      const len = Math.hypot(dx, dy) || 1;
      room.moveTo(p, p.x + (dx / len) * 6, p.y + (dy / len) * 6);
      return;
    }
  }

  // Mantém um alvo válido já escolhido.
  if (p.target !== null && room.entity(p.target)) return;

  // 3. Caçar jogadores na Caçada/Final.
  const endgame = room.phase === 'final' || room.phase === 'subita';
  if (hunting && (endgame ? hpPct(p) > 0.25 : hpPct(p) > 0.45 && room.rng.chance(brain.aggro))) {
    const prey = players
      .filter((q) => chebyshev(p, q) <= 10 && q.shieldUntil <= now)
      .filter((q) => q.stage < p.stage || (q.stage === p.stage && hpPct(q) <= hpPct(p)) || q.id === room.crownId || hpPct(q) < 0.4 || endgame)
      .sort((a, b) => chebyshev(p, a) - chebyshev(p, b))[0];
    if (prey) {
      room.setTarget(p, prey.id);
      return;
    }
  }

  // 4. Fruta rara próxima.
  const fruitIdx = room.map.fruits.findIndex((f, i) => room.fruitRespawnAt[i] <= now && chebyshev(p, f) <= 10 && room.inZone(f, 1));
  if (fruitIdx >= 0) {
    const f = room.map.fruits[fruitIdx];
    room.moveTo(p, f.x, f.y);
    return;
  }

  // 5. Comer bichos selvagens, preferindo o bioma favorito.
  let best: { id: number; score: number } | null = null;
  for (const w of room.wilds.values()) {
    const d = chebyshev(p, w);
    if (d > 16 || w.battle || !room.inZone(w, 1)) continue;
    const score = d + (w.elem === brain.pref ? 0 : 5);
    if (!best || score < best.score) best = { id: w.id, score };
  }
  if (best) {
    room.setTarget(p, best.id);
    return;
  }

  // 6. Passear pelo bioma favorito.
  if (p.path.length === 0) {
    const home = room.map.fruits.find((f) => f.elem === brain.pref) ?? null;
    const spot = randomSpot(room, room.rng.chance(0.6) ? home : null, room.rng.chance(0.7) ? brain.pref : null);
    if (spot) room.moveTo(p, spot.x, spot.y);
  }
}

