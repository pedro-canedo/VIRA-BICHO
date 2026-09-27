import type { Elem, Look } from '@vb/shared';
import { ELEM_TONE, NEUTRAL_TONE, mix, type Tone } from './palette';

/**
 * Bichos procedurais: o corpo é sempre a mesma bolinha 16×16 e ganha peças
 * conforme o tipo e o estágio. Tudo desenhado pixel a pixel num canvas 32×32.
 */
export const CREATURE_SIZE = 32;

type Sprite = string[];

// Legenda: . vazio | b corpo | d escuro | l claro | w branco | k preto | p rosa | y amarelo
const PARTS: Record<Elem, { head: Sprite; side: Sprite; tail: Sprite; final?: Sprite }> = {
  brasa: {
    head: ['..l..', '.lb..', '.lbb.', 'lbbbl', 'bbdbb', '.bdb.'],
    side: ['d...', 'dd..', '.dd.', '..dd'],
    tail: ['....l', '...lb', '..lbl', '.lbb.', 'lbd..', 'bd...'],
    final: ['.l...l.', 'lb.l.bl', '.bbbbb.', 'bbdbdbb', '.bdddb.'],
  },
  mare: {
    head: ['..l..', '.lbb.', '.bbbb', 'bbbbd'],
    side: ['..bd', '.bbd', 'lbd.', 'bd..'],
    tail: ['.....lb', '....lbb', '.bbbbd.', '....dbb', '.....db'],
    final: ['l.l.l', 'bbbbb', 'dbdbd'],
  },
  broto: {
    head: ['l...l', 'bl.lb', '.bbb.', '..d..', '..d..'],
    side: ['.lb', 'lbb', 'bd.', 'd..'],
    tail: ['..lb.', '.bb..', 'd....', '.d...', '..dbl'],
    final: ['.p.p.', 'ppwpp', '.pyp.', '..d..', '..d..'],
  },
};

const EXTRA: Record<string, string> = { w: '#ffffff', k: '#1a1423', p: '#ff8fc8', y: '#ffd23f' };

function paint(ctx: CanvasRenderingContext2D, sprite: Sprite, ox: number, oy: number, tone: Tone, flip = false): void {
  sprite.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = flip ? row[row.length - 1 - x] : row[x];
      if (ch === '.') continue;
      ctx.fillStyle = ch === 'b' ? tone.body : ch === 'd' ? tone.dark : ch === 'l' ? tone.light : EXTRA[ch];
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  });
}

function disc(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, color: string): void {
  ctx.fillStyle = color;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) ctx.fillRect(x, y, 1, 1);
    }
  }
}

function toneFor(look: Look): { body: Tone; parts: Elem[] } {
  const [a, b, c] = look.order;
  if (!a || look.form === 'neutro') return { body: NEUTRAL_TONE, parts: [] };
  const ta = ELEM_TONE[a];
  if (look.form === a) return { body: ta, parts: [a] };
  if (look.form === 'quimera' && b && c) {
    return { body: { body: mix(ta.body, ELEM_TONE[b].body, 0.25), dark: ta.dark, light: ta.light }, parts: [a, b, c] };
  }
  if (b) {
    const tb = ELEM_TONE[b];
    return { body: { body: mix(ta.body, tb.body, 0.4), dark: mix(ta.dark, tb.dark, 0.4), light: mix(ta.light, tb.light, 0.4) }, parts: [a, b] };
  }
  return { body: ta, parts: [a] };
}

function drawEgg(ctx: CanvasRenderingContext2D, look: Look): void {
  const tint = look.order[0] ? mix(NEUTRAL_TONE.body, ELEM_TONE[look.order[0]].body, 0.25) : NEUTRAL_TONE.body;
  disc(ctx, 16, 19, 6.5, 8, NEUTRAL_TONE.dark);
  disc(ctx, 16, 19, 5.5, 7, tint);
  disc(ctx, 14.5, 16, 1.5, 2, '#ffffff');
  const spots: [number, number][] = [
    [18, 18],
    [14, 22],
    [19, 23],
  ];
  spots.forEach(([x, y], i) => {
    const e = look.order[i % Math.max(1, look.order.length)];
    ctx.fillStyle = e ? ELEM_TONE[e].body : NEUTRAL_TONE.dark;
    ctx.fillRect(x, y, 2, 2);
  });
}

function drawBody(ctx: CanvasRenderingContext2D, look: Look, tone: Tone, parts: Elem[]): void {
  disc(ctx, 16, 18, 8, 8, tone.dark);
  disc(ctx, 16, 18, 7, 7, tone.body);
  if (look.form === 'quimera' && parts.length === 3) {
    // Faixa e manchas das outras duas cores: um bicho remendado.
    ctx.fillStyle = ELEM_TONE[parts[1]].body;
    ctx.fillRect(10, 20, 13, 2);
    ctx.fillStyle = ELEM_TONE[parts[2]].body;
    ctx.fillRect(12, 13, 2, 2);
    ctx.fillRect(19, 22, 2, 2);
  }
  // Brilho
  ctx.fillStyle = tone.light;
  ctx.fillRect(11, 13, 2, 1);
  ctx.fillRect(10, 14, 1, 2);
  // Olhos
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(12, 16, 3, 3);
  ctx.fillRect(18, 16, 3, 3);
  ctx.fillStyle = '#1a1423';
  ctx.fillRect(13, 17, 2, 2);
  ctx.fillRect(19, 17, 2, 2);
  if (look.stage >= 3) {
    // Sobrancelhas bravas na forma final
    ctx.fillRect(11, 14, 2, 1);
    ctx.fillRect(13, 15, 1, 1);
    ctx.fillRect(20, 14, 2, 1);
    ctx.fillRect(19, 15, 1, 1);
  }
  // Boca e bochechas
  ctx.fillStyle = tone.dark;
  ctx.fillRect(15, 21, 3, 1);
  if (look.stage >= 2) {
    ctx.fillStyle = 'rgba(255,120,150,0.55)';
    ctx.fillRect(10, 19, 2, 1);
    ctx.fillRect(21, 19, 2, 1);
  }
}

export interface DrawOpts {
  silhouette?: boolean;
}

const cache = new Map<string, HTMLCanvasElement>();

export function lookKey(look: Look): string {
  return `${look.form}-${look.stage}-${look.order.join('')}`;
}

/** Desenha (com cache) o bicho de um visual num canvas 32×32. */
export function drawCreature(look: Look, opts: DrawOpts = {}): HTMLCanvasElement {
  const key = lookKey(look) + (opts.silhouette ? '-s' : '');
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = CREATURE_SIZE;
  const ctx = c.getContext('2d')!;

  // Sombra
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  disc(ctx, 16, 26.5, 7, 1.6, 'rgba(0,0,0,0.28)');

  if (look.stage === 0) {
    drawEgg(ctx, look);
  } else {
    const { body, parts } = toneFor(look);
    const s = look.stage;
    const head = parts[0];
    const side = look.form === 'quimera' ? parts[1] : parts[1] ?? parts[0];
    const tail = look.form === 'quimera' ? parts[2] : parts[0];
    const tailFrom = look.form === 'quimera' ? 2 : 3;
    if (tail && s >= tailFrom) paint(ctx, PARTS[tail].tail, 22, 17, ELEM_TONE[tail]);
    if (side && s >= 2) {
      paint(ctx, PARTS[side].side, 6, 9, ELEM_TONE[side]);
      paint(ctx, PARTS[side].side, 32 - 6 - PARTS[side].side[0].length, 9, ELEM_TONE[side], true);
    }
    drawBody(ctx, look, body, parts);
    if (head) {
      const sprite = s >= 3 && PARTS[head].final ? PARTS[head].final! : PARTS[head].head;
      paint(ctx, sprite, 16 - Math.floor(sprite[0].length / 2), 10 - sprite.length + 1, ELEM_TONE[head]);
    }
    if (s >= 3 && parts[1] && look.form !== 'quimera') {
      // Aura do segundo tipo nos híbridos
      const t = ELEM_TONE[parts[1]];
      ctx.fillStyle = t.light;
      for (const [x, y] of [
        [5, 20],
        [26, 12],
        [7, 26],
        [27, 25],
      ]) ctx.fillRect(x, y, 1, 1);
    }
  }

  if (opts.silhouette) {
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#2b2440';
    ctx.fillRect(0, 0, CREATURE_SIZE, CREATURE_SIZE);
    ctx.globalCompositeOperation = 'source-over';
  }
  cache.set(key, c);
  return c;
}

const pixelCache = new Map<string, Float32Array>();
let readCtx: CanvasRenderingContext2D | null = null;

/** Pixels opacos do bicho como [x, y, rgb, ...] (cache por lookKey; getImageData uma única vez). */
export function creaturePixels(look: Look): Float32Array {
  const key = lookKey(look);
  const hit = pixelCache.get(key);
  if (hit) return hit;
  if (!readCtx) {
    const rc = document.createElement('canvas');
    rc.width = rc.height = CREATURE_SIZE;
    readCtx = rc.getContext('2d', { willReadFrequently: true })!;
  }
  readCtx.clearRect(0, 0, CREATURE_SIZE, CREATURE_SIZE);
  readCtx.drawImage(drawCreature(look), 0, 0);
  const d = readCtx.getImageData(0, 0, CREATURE_SIZE, CREATURE_SIZE).data;
  const out: number[] = [];
  for (let y = 0; y < CREATURE_SIZE; y++) {
    for (let x = 0; x < CREATURE_SIZE; x++) {
      const i = (y * CREATURE_SIZE + x) * 4;
      // A sombra (alpha baixo) fica de fora.
      if (d[i + 3] < 128) continue;
      out.push(x, y, (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
  }
  const arr = new Float32Array(out);
  pixelCache.set(key, arr);
  return arr;
}

/** Versão ampliada (sem suavização) para a interface HTML. */
export function creatureImg(look: Look, scale = 3, opts: DrawOpts = {}): HTMLCanvasElement {
  const src = drawCreature(look, opts);
  const c = document.createElement('canvas');
  c.width = c.height = CREATURE_SIZE * scale;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  c.className = 'creature';
  return c;
}
