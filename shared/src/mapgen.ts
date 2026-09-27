import { Rng } from './rng';
import { ELEMS, type Elem, type Vec } from './types';

/** Valores de tile: 0..2 = índice do bioma em ELEMS, 3 = pedra. */
export const ROCK = 3;

export interface Fruit extends Vec {
  elem: Elem;
}

export interface GameMap {
  w: number;
  h: number;
  tiles: Uint8Array;
  fruits: Fruit[];
  spawns: Vec[];
}

export function mapSizeFor(players: number): number {
  return players <= 8 ? 48 : 64;
}

export const tileAt = (m: GameMap, x: number, y: number): number => m.tiles[y * m.w + x];

export function inBounds(m: GameMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < m.w && y < m.h;
}

export function isWalkable(m: GameMap, x: number, y: number): boolean {
  return inBounds(m, x, y) && m.tiles[y * m.w + x] !== ROCK;
}

export function biomeAt(m: GameMap, x: number, y: number): Elem | null {
  const t = tileAt(m, x, y);
  return t === ROCK || t === undefined ? null : ELEMS[t];
}

/** Ruído de valor suave em [-1, 1], com grade grossa interpolada. */
function valueNoise(rng: Rng, w: number, h: number, cell: number): (x: number, y: number) => number {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const grid = Array.from({ length: gw * gh }, () => rng.next() * 2 - 1);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = x / cell;
    const fy = y / cell;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const g = (i: number, j: number) => grid[(j % gh) * gw + (i % gw)];
    const top = g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx;
    const bot = g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bot * ty;
  };
}

/** Tile caminhável mais próximo (busca em largura). */
export function nearestWalkable(m: GameMap, x: number, y: number): Vec {
  const sx = Math.max(0, Math.min(m.w - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(m.h - 1, Math.round(y)));
  if (isWalkable(m, sx, sy)) return { x: sx, y: sy };
  const seen = new Uint8Array(m.w * m.h);
  const queue: Vec[] = [{ x: sx, y: sy }];
  seen[sy * m.w + sx] = 1;
  while (queue.length) {
    const p = queue.shift()!;
    for (const [dx, dy] of DIRS) {
      const nx = p.x + dx;
      const ny = p.y + dy;
      if (!inBounds(m, nx, ny) || seen[ny * m.w + nx]) continue;
      if (isWalkable(m, nx, ny)) return { x: nx, y: ny };
      seen[ny * m.w + nx] = 1;
      queue.push({ x: nx, y: ny });
    }
  }
  return { x: sx, y: sy };
}

export const DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Marca como alcançáveis os tiles conectados a (x, y). */
export function floodFill(m: GameMap, x: number, y: number): Uint8Array {
  const reach = new Uint8Array(m.w * m.h);
  if (!isWalkable(m, x, y)) return reach;
  const stack: number[] = [y * m.w + x];
  reach[y * m.w + x] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const cx = i % m.w;
    const cy = (i - cx) / m.w;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(m, nx, ny)) continue;
      const ni = ny * m.w + nx;
      if (reach[ni]) continue;
      reach[ni] = 1;
      stack.push(ni);
    }
  }
  return reach;
}

/**
 * Gera o mapa: biomas por Voronoi com bordas deformadas por ruído, blocos de pedra,
 * garantia de conectividade, frutas raras no coração de cada bioma e nascimentos em anel.
 */
export function generateMap(seed: number, players: number): GameMap {
  const rng = new Rng(seed);
  const size = mapSizeFor(players);
  const w = size;
  const h = size;
  const tiles = new Uint8Array(w * h);
  const m: GameMap = { w, h, tiles, fruits: [], spawns: [] };
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;

  // Sementes do Voronoi: 2 regiões por tipo (48×48) ou 3 (64×64).
  const perElem = size >= 64 ? 3 : 2;
  const elems = rng.shuffle(ELEMS.flatMap((e) => Array<Elem>(perElem).fill(e)));
  const minDist = size / (Math.sqrt(elems.length) + 0.8);
  const seeds: (Vec & { elem: Elem })[] = [];
  for (const elem of elems) {
    let best: Vec = { x: 0, y: 0 };
    let bestD = -1;
    for (let tries = 0; tries < 60; tries++) {
      const p = { x: rng.int(4, w - 5), y: rng.int(4, h - 5) };
      const d = Math.min(Infinity, ...seeds.map((s) => Math.hypot(s.x - p.x, s.y - p.y)));
      if (d >= minDist) {
        best = p;
        bestD = d;
        break;
      }
      if (d > bestD) {
        best = p;
        bestD = d;
      }
    }
    seeds.push({ ...best, elem });
  }

  // Biomas com bordas irregulares (deformação de domínio).
  const nx = valueNoise(rng, w, h, 9);
  const ny = valueNoise(rng, w, h, 9);
  const warp = size >= 64 ? 6 : 5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const wx = x + nx(x, y) * warp;
      const wy = y + ny(x + 101, y + 57) * warp;
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < seeds.length; i++) {
        const d = (seeds[i].x - wx) ** 2 + (seeds[i].y - wy) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      tiles[y * w + x] = ELEMS.indexOf(seeds[bi].elem);
    }
  }

  // Blocos de pedra por passeio aleatório, longe do centro e das sementes.
  const blobs = Math.round((w * h) / 170);
  for (let b = 0; b < blobs; b++) {
    let x = rng.int(1, w - 2);
    let y = rng.int(1, h - 2);
    const len = rng.int(3, 9);
    for (let s = 0; s < len; s++) {
      const nearCenter = Math.hypot(x - cx, y - cy) < 5;
      const nearSeed = seeds.some((sd) => Math.abs(sd.x - x) <= 2 && Math.abs(sd.y - y) <= 2);
      if (!nearCenter && !nearSeed && inBounds(m, x, y)) tiles[y * w + x] = ROCK;
      const [dx, dy] = rng.pick(DIRS);
      x = Math.max(1, Math.min(w - 2, x + dx));
      y = Math.max(1, Math.min(h - 2, y + dy));
    }
  }

  // Conectividade: bolsões isolados viram pedra.
  const start = nearestWalkable(m, Math.round(cx), Math.round(cy));
  const reach = floodFill(m, start.x, start.y);
  for (let i = 0; i < tiles.length; i++) if (tiles[i] !== ROCK && !reach[i]) tiles[i] = ROCK;

  m.fruits = seeds.map((s) => ({ ...nearestWalkable(m, s.x, s.y), elem: s.elem }));

  const ringR = size * 0.38;
  const offset = rng.next() * Math.PI * 2;
  for (let i = 0; i < players; i++) {
    const a = offset + (i / players) * Math.PI * 2;
    m.spawns.push(nearestWalkable(m, cx + Math.cos(a) * ringR, cy + Math.sin(a) * ringR));
  }
  return m;
}

export function encodeTiles(tiles: Uint8Array): string {
  let s = '';
  for (const t of tiles) s += t === ROCK ? '#' : String(t);
  return s;
}

export function decodeTiles(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] === '#' ? ROCK : Number(s[i]);
  return out;
}
