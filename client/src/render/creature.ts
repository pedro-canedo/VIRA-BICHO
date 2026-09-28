import type { Elem, Form, Look } from '@vb/shared';
import { ELEM_TONE, NEUTRAL_TONE, mix, type Tone } from './palette';

/**
 * Bichos procedurais: o corpo é sempre a mesma bolinha 16×16 e ganha peças
 * conforme o tipo e o estágio. Tudo desenhado pixel a pixel num canvas 32×32.
 * O estágio 0 é o bebê (corpo 13×12, olhos grandes e um detalhe mínimo do tipo);
 * o ovo da eclosão tem desenho próprio (drawEgg), com rachaduras e inclinação.
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
const INK = '#1a1423';
const BLUSH = 'rgba(255,120,150,0.55)';

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

/** Sprite com paleta própria (cada letra vira uma cor do mapa). */
function paintPal(ctx: CanvasRenderingContext2D, sprite: Sprite, ox: number, oy: number, pal: Record<string, string>): void {
  sprite.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = pal[row[x]];
      if (!c) continue;
      ctx.fillStyle = c;
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

// ---------------------------------------------------------------- bebê

const T = ELEM_TONE;
/** Detalhe do bebê por forma: sprite, paleta e deslocamento em relação ao topo da cabeça. */
const BABY_TUFT: Record<Form, { s: Sprite; pal: Record<string, string>; dx: number }> = {
  // Pedacinho da casca do ovo na cabeça
  neutro: { s: ['.ooo.', 'owwwo', 'w.w.w'], pal: { o: '#9d9580', w: '#ffffff' }, dx: -2 },
  // Chaminha
  brasa: { s: ['..l.', '.lb.', 'lbbl', '.bd.'], pal: { l: T.brasa.light, b: T.brasa.body, d: T.brasa.dark }, dx: -2 },
  // Topete de gota
  mare: { s: ['.l.', 'lb.', 'bbd', '.d.'], pal: { l: T.mare.light, b: T.mare.body, d: T.mare.dark }, dx: -1 },
  // Broto de duas folhas
  broto: { s: ['bl.lb', '.bdb.', '..d..'], pal: { l: T.broto.light, b: T.broto.body, d: T.broto.dark }, dx: -2 },
  // Nuvenzinha de vapor
  vapor: { s: ['.ww..', 'wvvw.', '.vwvv', '..v..'], pal: { w: '#ffffff', v: '#b9a7ff' }, dx: -2 },
  // Graveto em brasa
  cinza: { s: ['.y.', '.r.', 'ra.', '.a.'], pal: { y: T.brasa.light, r: T.brasa.body, a: '#6d5a44' }, dx: -1 },
  // Folhinha com gota de orvalho
  mangue: { s: ['l..w', 'bl.m', '.bd.', '..d.'], pal: { l: T.broto.light, b: '#3fb3a0', d: T.broto.dark, w: T.mare.light, m: T.mare.body }, dx: -2 },
  // Três fiozinhos, um de cada tipo
  quimera: { s: ['r.m.g', 'r.m.g', '.rmg.'], pal: { r: T.brasa.body, m: T.mare.body, g: T.broto.body }, dx: -2 },
};

/** Bebê (estágio 0): 13×12, olhos grandes com brilho, bochechas e o detalhe do tipo. */
function drawBaby(ctx: CanvasRenderingContext2D, look: Look, tone: Tone, parts: Elem[]): void {
  // Pezinhos
  ctx.fillStyle = tone.dark;
  ctx.fillRect(12, 26, 2, 1);
  ctx.fillRect(18, 26, 2, 1);
  disc(ctx, 16, 20.5, 6.4, 6, tone.dark);
  disc(ctx, 16, 20.5, 5.4, 5, tone.body);
  if (look.form === 'quimera' && parts.length === 3) {
    // Remendos das outras duas cores
    ctx.fillStyle = ELEM_TONE[parts[1]].body;
    ctx.fillRect(11, 23, 3, 2);
    ctx.fillRect(12, 22, 1, 1);
    ctx.fillStyle = ELEM_TONE[parts[2]].body;
    ctx.fillRect(19, 23, 2, 2);
    ctx.fillRect(18, 17, 2, 1);
  }
  // Brilho
  ctx.fillStyle = tone.light;
  ctx.fillRect(12, 16, 2, 1);
  ctx.fillRect(11, 17, 1, 1);
  // Olhos grandes (3×3) com brilho branco
  ctx.fillStyle = INK;
  ctx.fillRect(12, 19, 3, 3);
  ctx.fillRect(17, 19, 3, 3);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(12, 19, 1, 1);
  ctx.fillRect(17, 19, 1, 1);
  // Bochechas e boquinha
  ctx.fillStyle = BLUSH;
  ctx.fillRect(10, 22, 2, 1);
  ctx.fillRect(20, 22, 2, 1);
  ctx.fillStyle = tone.dark;
  ctx.fillRect(15, 23, 2, 1);
  const tuft = BABY_TUFT[look.form];
  paintPal(ctx, tuft.s, 16 + tuft.dx, 15 - tuft.s.length + 1, tuft.pal);
}

// ---------------------------------------------------------------- filhote em diante

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
  ctx.fillStyle = INK;
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
    ctx.fillStyle = BLUSH;
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

function newCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = CREATURE_SIZE;
  return [c, c.getContext('2d')!];
}

function silhouette(ctx: CanvasRenderingContext2D): void {
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#2b2440';
  ctx.fillRect(0, 0, CREATURE_SIZE, CREATURE_SIZE);
  ctx.globalCompositeOperation = 'source-over';
}

/** Desenha (com cache) o bicho de um visual num canvas 32×32. */
export function drawCreature(look: Look, opts: DrawOpts = {}): HTMLCanvasElement {
  const key = lookKey(look) + (opts.silhouette ? '-s' : '');
  const hit = cache.get(key);
  if (hit) return hit;
  const [c, ctx] = newCanvas();

  // Sombra
  disc(ctx, 16, 26.5, look.stage === 0 ? 6 : 7, 1.6, 'rgba(0,0,0,0.28)');

  const { body, parts } = toneFor(look);
  if (look.stage === 0) {
    drawBaby(ctx, look, body, parts);
  } else {
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

  if (opts.silhouette) silhouette(ctx);
  cache.set(key, c);
  return c;
}

// ---------------------------------------------------------------- ovo da eclosão

export interface EggOpts {
  /** 0 inteiro, 1-3 rachaduras crescentes */
  crack?: number;
  /** inclinação em degraus: -1 esquerda, 0 em pé, 1 direita (balança apoiado na base) */
  tilt?: number;
  /** padrão das manchas (0-3), para os ovos do começo da partida não saírem iguais */
  variant?: number;
  silhouette?: boolean;
}

const EGG_CX = 16;
const EGG_CY = 19.5;
const EGG_RX = 6;
const EGG_RY = 7.5;
const EGG_BASE = 26;
const SHEAR = 0.14;

// Manchas por variante: [dx, dy, w, h] a partir do centro do ovo.
const SPOTS: [number, number, number, number][][] = [
  [
    [1, -3, 2, 2],
    [-3, 1, 2, 2],
    [2, 3, 2, 1],
    [-1, -6, 1, 1],
  ],
  [
    [-2, -4, 2, 2],
    [2, 0, 2, 2],
    [-3, 3, 2, 1],
    [1, 4, 1, 1],
  ],
  [
    [0, -2, 3, 2],
    [-4, 2, 1, 2],
    [2, 4, 2, 1],
    [3, -4, 1, 1],
  ],
  [
    [-3, -2, 2, 1],
    [1, 1, 2, 2],
    [-1, 4, 2, 1],
    [2, -5, 1, 1],
  ],
];

// Rachadura em zigue-zague: uma linha por coluna, acumulada por estágio da direita para a esquerda.
const ZIG = [0, 1, 2, 1];
/** Linha da rachadura na coluna x (a casca se parte por ela na eclosão). */
const crackRow = (x: number): number => 17 - ZIG[(((21 - x) % 4) + 4) % 4];
const CRACK_COLS: number[][] = [[], [21, 20, 19, 18], [17, 16, 15, 14], [13, 12, 11, 10]];
const CRACK_TWIGS: [number, number][][] = [
  [],
  [],
  [
    [16, 15],
    [15, 14],
  ],
  [
    [12, 17],
    [13, 18],
  ],
];

/** Meia-largura do ovo na linha y (mais estreito em cima). */
function eggHalf(y: number): number {
  const t = (y + 0.5 - EGG_CY) / EGG_RY;
  if (t <= -1 || t >= 1) return -1;
  return EGG_RX * Math.sqrt(1 - t * t) * (t < 0 ? 1 + 0.22 * t : 1);
}

function eggInside(x: number, y: number): boolean {
  const hw = eggHalf(y);
  return hw > 0 && Math.abs(x + 0.5 - EGG_CX) <= hw;
}

const eggCache = new Map<string, HTMLCanvasElement>();

/** Ovo da eclosão (cache por visual, rachadura, inclinação e variante), no mesmo quadro 32×32 do bicho. */
export function drawEgg(look: Look, opts: EggOpts = {}): HTMLCanvasElement {
  const crack = Math.max(0, Math.min(3, opts.crack ?? 0));
  const tilt = Math.max(-1, Math.min(1, opts.tilt ?? 0));
  const variant = (opts.variant ?? 0) & 3;
  const key = `${look.form}-${look.order.join('')}-${crack}-${tilt}-${variant}${opts.silhouette ? '-s' : ''}`;
  const hit = eggCache.get(key);
  if (hit) return hit;
  const [c, ctx] = newCanvas();
  disc(ctx, 16, 26.5, 6, 1.6, 'rgba(0,0,0,0.28)');

  const e0 = look.order[0];
  const shell = e0 ? mix(NEUTRAL_TONE.body, ELEM_TONE[e0].body, 0.18) : NEUTRAL_TONE.body;
  const shellLight = NEUTRAL_TONE.light;
  const shellDark = e0 ? mix(NEUTRAL_TONE.dark, ELEM_TONE[e0].dark, 0.25) : NEUTRAL_TONE.dark;
  const shade = mix(shell, shellDark, 0.45);
  // Desloca cada linha para balançar apoiado na base.
  const sh = (y: number) => Math.round((EGG_BASE - y) * SHEAR * tilt);
  const put = (x: number, y: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x + sh(y), y, 1, 1);
  };
  for (let y = 8; y <= EGG_BASE + 1; y++) {
    for (let x = 6; x < 26; x++) {
      if (!eggInside(x, y)) continue;
      const edge = !eggInside(x - 1, y) || !eggInside(x + 1, y) || !eggInside(x, y - 1) || !eggInside(x, y + 1);
      const hw = eggHalf(y);
      const dx = x + 0.5 - EGG_CX;
      const t = (y + 0.5 - EGG_CY) / EGG_RY;
      let col = shell;
      if (edge) col = shellDark;
      else if (dx > hw * 0.35 && t > -0.45) col = shade;
      else if (t > 0.72) col = shade;
      put(x, y, col);
    }
  }
  // Brilho
  const hx = EGG_CX - 3;
  put(hx, 15, shellLight);
  put(hx, 16, shellLight);
  put(hx + 1, 14, shellLight);
  put(hx - 1, 17, shellLight);
  // Manchas nas cores dos tipos (o neutro tem pintinhas de pedra)
  const spots = SPOTS[variant];
  spots.forEach(([dx, dy, w, h], i) => {
    const e = look.order.length ? look.order[i % look.order.length] : undefined;
    const col = e ? (i === 3 ? ELEM_TONE[e].light : ELEM_TONE[e].body) : i === 3 ? shellLight : mix(shell, shellDark, 0.7);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const px = Math.round(EGG_CX + dx - 0.5) + xx;
        const py = Math.round(EGG_CY + dy - 0.5) + yy;
        if (eggInside(px - 1, py) && eggInside(px + 1, py) && eggInside(px, py - 1) && eggInside(px, py + 1)) put(px, py, col);
      }
    }
  });
  // Rachaduras (e a luz do bebê vazando pela última)
  if (crack > 0) {
    const glow = e0 ? ELEM_TONE[e0].light : '#fffaf0';
    for (let k = 1; k <= crack; k++) {
      for (const x of CRACK_COLS[k]) {
        const y = crackRow(x);
        if (!eggInside(x, y)) continue;
        put(x, y, INK);
        if (crack === 3 && eggInside(x, y + 1)) put(x, y + 1, glow);
      }
      for (const [x, y] of CRACK_TWIGS[k]) if (eggInside(x, y)) put(x, y, INK);
    }
  }
  if (opts.silhouette) silhouette(ctx);
  eggCache.set(key, c);
  return c;
}

export type EggPart = 'top' | 'left' | 'right';

/** Pedaço da casca partida pela rachadura: a tampa (top) e as duas metades de baixo. */
export function drawEggPart(look: Look, variant: number, part: EggPart): HTMLCanvasElement {
  const key = `${look.form}-${look.order.join('')}-${variant & 3}-${part}`;
  const hit = eggCache.get(key);
  if (hit) return hit;
  const [c, ctx] = newCanvas();
  ctx.drawImage(drawEgg(look, { crack: 3, variant }), 0, 0);
  for (let y = 0; y < CREATURE_SIZE; y++) {
    for (let x = 0; x < CREATURE_SIZE; x++) {
      const r = crackRow(x);
      const keep = eggInside(x, y) && (part === 'top' ? y < r : y > r + 1 && (part === 'left' ? x < 16 : x >= 16));
      if (!keep) ctx.clearRect(x, y, 1, 1);
    }
  }
  eggCache.set(key, c);
  return c;
}

/** Ovo ampliado (sem suavização) para a interface HTML. */
export function eggImg(look: Look, scale = 3, opts: EggOpts = {}): HTMLCanvasElement {
  return scaled(drawEgg(look, opts), scale, 'creature egg');
}

const pixelCache = new Map<string, Float32Array>();
let readCtx: CanvasRenderingContext2D | null = null;

/** Pixels opacos de um canvas 32×32 como [x, y, rgb, ...] (getImageData uma única vez por chave). */
function pixelsOf(key: string, src: HTMLCanvasElement): Float32Array {
  const hit = pixelCache.get(key);
  if (hit) return hit;
  if (!readCtx) {
    const rc = document.createElement('canvas');
    rc.width = rc.height = CREATURE_SIZE;
    readCtx = rc.getContext('2d', { willReadFrequently: true })!;
  }
  readCtx.clearRect(0, 0, CREATURE_SIZE, CREATURE_SIZE);
  readCtx.drawImage(src, 0, 0);
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

/** Pixels opacos do bicho como [x, y, rgb, ...] (cache por lookKey; getImageData uma única vez). */
export function creaturePixels(look: Look): Float32Array {
  return pixelsOf(lookKey(look), drawCreature(look));
}

function scaled(src: HTMLCanvasElement, scale: number, cls: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = CREATURE_SIZE * scale;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  c.className = cls;
  return c;
}

/** Versão ampliada (sem suavização) para a interface HTML. */
export function creatureImg(look: Look, scale = 3, opts: DrawOpts = {}): HTMLCanvasElement {
  return scaled(drawCreature(look, opts), scale, 'creature');
}
