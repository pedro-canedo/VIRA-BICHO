import { ELEMS, ROCK, type Elem } from '@vb/shared';
import { BIOME_COLORS, ELEM_TONE } from './palette';

export const TILE = 16;

/** Hash determinístico por tile para variar o desenho sem aleatoriedade global. */
function hash(x: number, y: number, k = 0): number {
  let h = (x * 374761393 + y * 668265263 + k * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tipos de decoração que o chão vivo anima na GPU (lista plana [tipo, x, y, ...] em px). */
export const DECOR = { tuft: 0, mark: 1, crack: 2, glint: 3 } as const;

export interface MapOpts {
  /** false: tufos e lava ficam fora do canvas (vão para a SpriteGPULayer) */
  bakeDecor?: boolean;
  /** recebe as decorações */
  decor?: number[];
}

function drawTile(ctx: CanvasRenderingContext2D, elem: Elem, x: number, y: number, bake: boolean, out: number[] | null): void {
  const c = BIOME_COLORS[elem];
  const px = x * TILE;
  const py = y * TILE;
  ctx.fillStyle = hash(x, y) < 0.5 ? c.base : c.alt;
  ctx.fillRect(px, py, TILE, TILE);
  const r = hash(x, y, 1);
  ctx.fillStyle = c.accent;
  if (elem === 'brasa') {
    // Brasas e rachaduras de lava
    if (r < 0.35) {
      const mx = px + Math.floor(hash(x, y, 2) * 13);
      const my = py + Math.floor(hash(x, y, 3) * 13);
      if (bake) ctx.fillRect(mx, my, 2, 1);
      out?.push(DECOR.mark, mx, my);
    }
    if (r > 0.85 && !bake) out?.push(DECOR.crack, px + 3, py + 8);
    else if (r > 0.85) {
      ctx.globalAlpha = 0.5;
      ctx.fillRect(px + 3, py + 8, 6, 1);
      ctx.fillRect(px + 8, py + 9, 4, 1);
      ctx.globalAlpha = 1;
    }
  } else if (elem === 'mare') {
    // Brilho da água (só no chão vivo)
    if (hash(x, y, 7) < 0.15) out?.push(DECOR.glint, px + 2 + Math.floor(hash(x, y, 8) * 11), py + 2 + Math.floor(hash(x, y, 9) * 12));
    // Ondinhas
    if (r < 0.45) {
      const ox = px + Math.floor(hash(x, y, 2) * 10);
      const oy = py + 3 + Math.floor(hash(x, y, 3) * 10);
      ctx.globalAlpha = 0.55;
      ctx.fillRect(ox, oy, 3, 1);
      ctx.fillRect(ox + 3, oy - 1, 2, 1);
      ctx.globalAlpha = 1;
    }
  } else {
    // Tufos de grama e florzinhas
    if (r < 0.5) {
      const ox = px + 2 + Math.floor(hash(x, y, 2) * 11);
      const oy = py + 4 + Math.floor(hash(x, y, 3) * 9);
      if (bake) {
        ctx.fillRect(ox, oy, 1, 2);
        ctx.fillRect(ox + 2, oy - 1, 1, 3);
      }
      out?.push(DECOR.tuft, ox, oy - 1);
    }
    if (r > 0.92) {
      ctx.fillStyle = '#ffd6f0';
      ctx.fillRect(px + 6, py + 6, 2, 2);
    }
  }
}

function drawRock(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const px = x * TILE;
  const py = y * TILE;
  ctx.fillStyle = '#2c2a36';
  ctx.fillRect(px + 1, py + 2, 14, 13);
  ctx.fillStyle = '#4b4859';
  ctx.fillRect(px + 2, py + 2, 12, 10);
  ctx.fillStyle = '#6d6a80';
  ctx.fillRect(px + 3, py + 3, 5, 3);
  if (hash(x, y, 5) < 0.5) {
    ctx.fillStyle = '#3a3847';
    ctx.fillRect(px + 9, py + 7, 3, 1);
  }
}

/** Desenha o mapa inteiro num canvas (w×16 por h×16 pixels). Com bakeDecor = false, as decorações vivas ficam só na lista. */
export function renderMap(w: number, h: number, tiles: Uint8Array, opts: MapOpts = {}): HTMLCanvasElement {
  const bake = opts.bakeDecor ?? true;
  const c = document.createElement('canvas');
  c.width = w * TILE;
  c.height = h * TILE;
  const ctx = c.getContext('2d')!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = tiles[y * w + x];
      // Rochas ficam sobre o bioma vizinho para não deixar buracos.
      const below = t === ROCK ? tiles[y * w + Math.max(0, x - 1)] : t;
      drawTile(ctx, ELEMS[below === ROCK ? 0 : below], x, y, bake, t === ROCK ? null : (opts.decor ?? null));
      if (t === ROCK) drawRock(ctx, x, y);
    }
  }
  // Bordas suaves entre biomas
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#000';
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const a = tiles[y * w + x];
      const b = tiles[y * w + x - 1];
      if (a !== b && a !== ROCK && b !== ROCK) ctx.fillRect(x * TILE - 1, y * TILE, 2, TILE);
    }
  }
  ctx.globalAlpha = 1;
  return c;
}

/** Miniatura do mapa (1 pixel por tile) para o minimapa. */
export function renderMinimap(w: number, h: number, tiles: Uint8Array): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = tiles[y * w + x];
      ctx.fillStyle = t === ROCK ? '#3b3947' : ELEM_TONE[ELEMS[t]].dark;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

/** Fruta rara (8×8). */
export function drawFruit(elem: Elem): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 12;
  const ctx = c.getContext('2d')!;
  const t = ELEM_TONE[elem];
  const rows = ['....dd......', '.....d......', '...bbbbb....', '..bllbbbb...', '..blbbbbbd..', '..bbbbbbbd..', '..bbbbbbdd..', '...bbbbdd...', '....dddd....'];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      ctx.fillStyle = ch === 'b' ? t.body : ch === 'l' ? '#ffffff' : t.dark;
      ctx.fillRect(x, y + 2, 1, 1);
    }
  });
  ctx.fillStyle = '#6fdc6f';
  ctx.fillRect(6, 1, 3, 1);
  return c;
}
