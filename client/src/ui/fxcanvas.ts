import type { Form } from '@vb/shared';
import { reduced } from './anim';

// Camada de pixels da interface: um único canvas em tela cheia, a 1/3 da resolução CSS.
// Tudo o que é desenhado aqui sai em quadradinhos de 3 px CSS. A API recebe px de tela.

const S = 3;
const N = 192;
const F = 10;
const X = 0,
  Y = 1,
  VX = 2,
  VY = 3,
  LIFE = 4,
  MAX = 5,
  COL = 6,
  SIZE = 7,
  GRAV = 8,
  FLAGS = 9;
const ADD = 1,
  FLUTTER = 2,
  STEP = 4,
  SHRINK = 8;
const STEP_MS = 75;

/** Rampas [claro, corpo, escuro] por forma: as mesmas do mundo (tokens --fx-* no CSS). */
export const QUIMERA = ['#ff7a3d', '#ffcf3f', '#52c95f', '#4aa3ff', '#ff5fd2'];
export const RAMP: Record<Form, string[]> = {
  brasa: ['#ffd27a', '#ff7a3d', '#b8400f'],
  mare: ['#c4e6ff', '#4aa3ff', '#1b4fc4'],
  broto: ['#d2f7b8', '#52c95f', '#17803a'],
  vapor: ['#ffffff', '#b9a7ff', '#c4e6ff'],
  cinza: ['#ff7a3d', '#a8845c', '#6d6a80'],
  mangue: ['#d2f7b8', '#3fb3a0', '#17803a'],
  quimera: QUIMERA,
  neutro: ['#fffaf0', '#e9e1cc', '#9d9580'],
};

type Style = 'fogo' | 'jato' | 'folha' | 'raio' | 'poeira';
const STYLE: Record<Form, Style> = { brasa: 'fogo', vapor: 'fogo', cinza: 'fogo', mare: 'jato', mangue: 'jato', broto: 'folha', quimera: 'raio', neutro: 'poeira' };
/** Rastro de cada forma: cores, gravidade (px lógicos/s², negativa sobe) e blend ADD. */
const TRAIL: Record<Form, { c: string[]; g: number; add: boolean }> = {
  brasa: { c: ['#ff7a3d', '#b8400f'], g: -70, add: true },
  vapor: { c: ['#b9a7ff', '#ffffff'], g: -40, add: false },
  cinza: { c: ['#a8845c', '#6d6a80'], g: 60, add: false },
  mare: { c: ['#c4e6ff', '#4aa3ff'], g: -30, add: false },
  mangue: { c: ['#3fb3a0', '#52c95f'], g: 25, add: false },
  broto: { c: ['#d2f7b8', '#52c95f'], g: 12, add: false },
  quimera: { c: QUIMERA, g: 0, add: true },
  neutro: { c: ['#e9e1cc', '#fffaf0'], g: 20, add: false },
};

export interface Pt {
  x: number;
  y: number;
}

export interface BurstOpts {
  /** px CSS por segundo */
  speed?: [number, number];
  /** ms */
  life?: [number, number];
  /** em pixels lógicos (1 = 3 px CSS) */
  size?: number;
  /** px CSS/s² (negativa sobe) */
  gravity?: number;
  /** graus: 0 = direita, -90 = cima */
  angle?: [number, number];
  /** ângulos distribuídos por igual (anel) */
  even?: boolean;
  add?: boolean;
  /** anda em 4 degraus em vez de deslizar */
  step?: boolean;
  shrink?: boolean;
  /** nasce espalhado num retângulo de ±spread px CSS */
  spread?: number;
  spreadY?: number;
}

const P = new Float32Array(N * F);
const colors: string[] = [];
const colorIdx = new Map<string, number>();
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let last = 0;
let alive = 0;
let cursor = 0;
let tier = 1;

interface Spell {
  on: boolean;
  form: Form;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t0: number;
  dur: number;
  size: number;
  charged: boolean;
  acc: number;
}
const spells: Spell[] = Array.from({ length: 6 }, () => ({ on: false, form: 'neutro' as Form, x0: 0, y0: 0, x1: 0, y1: 0, t0: 0, dur: 1, size: 1, charged: false, acc: 0 }));

interface Bolt {
  on: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t0: number;
  tEnd: number;
  color: string;
}
const bolts: Bolt[] = Array.from({ length: 4 }, () => ({ on: false, x0: 0, y0: 0, x1: 0, y1: 0, t0: 0, tEnd: 0, color: '#fff' }));

function col(c: string): number {
  let i = colorIdx.get(c);
  if (i === undefined) {
    i = colors.length;
    colors.push(c);
    colorIdx.set(c, i);
  }
  return i;
}

/** Relê o tier de efeitos gravado no menu ('vb.fx') ou o último automático do mundo. */
export function refreshFxTier(): void {
  try {
    const v = localStorage.getItem('vb.fx');
    const t = v && v !== 'auto' ? v : localStorage.getItem('vb.fx.auto');
    tier = t === 'baixo' ? 0.35 : t === 'medio' ? 0.6 : 1;
  } catch {
    tier = 1;
  }
}

function resize(): void {
  if (!canvas) return;
  canvas.width = Math.ceil(innerWidth / S);
  canvas.height = Math.ceil(innerHeight / S);
  canvas.style.width = `${canvas.width * S}px`;
  canvas.style.height = `${canvas.height * S}px`;
  ctx = canvas.getContext('2d');
  if (ctx) ctx.imageSmoothingEnabled = false;
}

function ensure(): CanvasRenderingContext2D | null {
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'fxlayer';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.append(canvas);
    resize();
    refreshFxTier();
    window.addEventListener('resize', resize);
  }
  return ctx;
}

function start(): void {
  if (raf || !ensure()) return;
  last = performance.now();
  raf = requestAnimationFrame(frame);
}

function spawn(x: number, y: number, vx: number, vy: number, life: number, c: number, size: number, grav: number, flags: number): void {
  for (let k = 0; k < N; k++) {
    const i = ((cursor + k) % N) * F;
    if (P[i + LIFE] > 0) continue;
    cursor = (cursor + k + 1) % N;
    P[i + X] = x;
    P[i + Y] = y;
    P[i + VX] = vx;
    P[i + VY] = vy;
    P[i + LIFE] = life;
    P[i + MAX] = life;
    P[i + COL] = c;
    P[i + SIZE] = size;
    P[i + GRAV] = grav;
    P[i + FLAGS] = flags;
    alive++;
    return;
  }
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Explosão de quadradinhos a partir de (x, y) em px de tela. */
export function burst(x: number, y: number, n: number, cs: string[], o: BurstOpts = {}): void {
  if (!ensure() || !cs.length) return;
  const count = Math.max(1, Math.round(n * tier * (reduced() ? 0.4 : 1)));
  const [s0, s1] = o.speed ?? [40, 120];
  const [l0, l1] = o.life ?? [300, 500];
  const [a0, a1] = o.angle ?? [0, 360];
  const flags = (o.add ? ADD : 0) | (o.step ? STEP : 0) | (o.shrink ? SHRINK : 0);
  const sp = o.spread ?? 0;
  const spy = o.spreadY ?? sp;
  for (let k = 0; k < count; k++) {
    const ang = ((o.even ? a0 + ((a1 - a0) * k) / count : rnd(a0, a1)) * Math.PI) / 180;
    const v = rnd(s0, s1) / S;
    spawn((x + rnd(-sp, sp)) / S, (y + rnd(-spy, spy)) / S, Math.cos(ang) * v, Math.sin(ang) * v, rnd(l0, l1), col(cs[k % cs.length]), o.size ?? 1, (o.gravity ?? 0) / S, flags);
  }
  start();
}

/** Confete pixelado que tremula (scaleX = cos). Desligado com reduced-motion. */
export function confetti(x: number, y: number, n: number, cs: string[], o: { angle?: [number, number]; speed?: [number, number]; gravity?: number; life?: number; spread?: number } = {}): void {
  if (reduced() || !ensure()) return;
  const count = Math.max(1, Math.round(n * tier));
  const [a0, a1] = o.angle ?? [-120, -60];
  const [s0, s1] = o.speed ?? [180, 420];
  const sp = o.spread ?? 0;
  for (let k = 0; k < count; k++) {
    const ang = (rnd(a0, a1) * Math.PI) / 180;
    const v = rnd(s0, s1) / S;
    spawn((x + rnd(-sp, sp)) / S, y / S, Math.cos(ang) * v, Math.sin(ang) * v, o.life ?? 1400, col(cs[k % cs.length]), 2, (o.gravity ?? 900) / S, FLUTTER);
  }
  start();
}

/** Quadradinhos que nascem num anel de raio `radius` (px) e convergem para (x, y) em `ms`. */
export function converge(x: number, y: number, n: number, cs: string[], radius: number, ms: number): void {
  if (!ensure() || !cs.length) return;
  const count = Math.max(1, Math.round(n * tier * (reduced() ? 0.4 : 1)));
  const v = radius / S / (ms / 1000);
  for (let k = 0; k < count; k++) {
    const ang = (k / count) * Math.PI * 2 + rnd(-0.2, 0.2);
    const cx = Math.cos(ang);
    const cy = Math.sin(ang);
    spawn((x + cx * radius) / S, (y + cy * radius) / S, -cx * v, -cy * v, ms, col(cs[k % cs.length]), 1, 0, 0);
  }
  start();
}

/** Feitiço da forma `form` de `from` até `to`, começando em t0 (performance.now) e durando `dur` ms. */
export function spell(form: Form, from: Pt, to: Pt, t0: number, dur: number, o: { size?: number; charged?: boolean } = {}): void {
  if (!ensure() || STYLE[form] === 'poeira') return;
  const s = spells.find((x) => !x.on);
  if (!s) return;
  s.on = true;
  s.form = form;
  s.x0 = from.x / S;
  s.y0 = from.y / S;
  s.x1 = to.x / S;
  s.y1 = to.y / S;
  s.t0 = t0;
  s.dur = Math.max(1, dur);
  s.size = o.size ?? 1;
  s.charged = !!o.charged;
  s.acc = 0;
  start();
}

/** Raio em zigue-zague de `from` até `to`, trocando de forma a cada 40 ms. */
export function bolt(from: Pt, to: Pt, ms = 140, color = '#ffe066', t0 = performance.now()): void {
  if (!ensure()) return;
  const b = bolts.find((x) => !x.on);
  if (!b) return;
  b.on = true;
  b.x0 = from.x / S;
  b.y0 = from.y / S;
  b.x1 = to.x / S;
  b.y1 = to.y / S;
  b.t0 = t0;
  b.tEnd = t0 + ms;
  b.color = color;
  start();
}

/** Para tudo e limpa a camada (troca de tela). */
export function clearFx(): void {
  P.fill(0);
  alive = 0;
  for (const s of spells) s.on = false;
  for (const b of bolts) b.on = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ---------- desenho ----------

let blendAdd = false;
function blend(c: CanvasRenderingContext2D, add: boolean): void {
  if (add === blendAdd) return;
  blendAdd = add;
  c.globalCompositeOperation = add ? 'lighter' : 'source-over';
}

function rect(c: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, color: string): void {
  c.fillStyle = color;
  c.fillRect(Math.round(x), Math.round(y), w, hh);
}

/** Linha ponto a ponto (sem antialias). */
function line(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const n = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy))));
  for (let i = 0; i <= n; i++) c.fillRect(Math.round(x0 + (dx * i) / n), Math.round(y0 + (dy * i) / n), 1, 1);
}

/** Zigue-zague entre dois pontos; o desenho muda a cada 40 ms. */
function zigzag(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, now: number, amp: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const segs = Math.max(2, Math.round(len / 6));
  const seed = Math.floor(now / 40);
  let px = x0;
  let py = y0;
  for (let i = 1; i <= segs; i++) {
    const k = i / segs;
    const off = i === segs ? 0 : (((seed * 7919 + i * 104729) % 7) - 3) * (amp / 3);
    const qx = x0 + dx * k + nx * off;
    const qy = y0 + dy * k + ny * off;
    line(c, px, py, qx, qy);
    px = qx;
    py = qy;
  }
}

function drawSpell(c: CanvasRenderingContext2D, s: Spell, now: number, dt: number): void {
  const p = (now - s.t0) / s.dur;
  if (p < 0) return;
  if (p >= 1) {
    s.on = false;
    return;
  }
  const r = RAMP[s.form];
  const tr = TRAIL[s.form];
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const style = STYLE[s.form];
  let hx = s.x0 + dx * p;
  let hy = s.y0 + dy * p;
  const z = Math.max(1, Math.round(s.size));
  const sz = (base: number) => Math.max(1, Math.round(base * s.size));
  s.acc += dt;
  const emit = s.acc >= 16;
  if (emit) s.acc = 0;

  if (style === 'fogo') {
    hy -= len * 0.22 * Math.sin(Math.PI * p);
    const w = sz(3);
    blend(c, true);
    if (s.charged) rect(c, hx - w / 2 - 1, hy - w / 2 - 1, w + 2, w + 2, '#ffe066');
    else rect(c, hx - w / 2 - 1, hy - w / 2, w + 2, w, r[1]);
    rect(c, hx - w / 2, hy - w / 2, w, w, r[0]);
    if (emit) {
      spawn(hx + rnd(-1, 1), hy + rnd(-1, 1), rnd(-6, 6), rnd(-18, -4), rnd(160, 300), col(tr.c[Math.random() < 0.5 ? 0 : 1]), 1, tr.g, (tr.add ? ADD : 0) | SHRINK);
    }
  } else if (style === 'jato') {
    const ph = p * Math.PI * 4;
    const a = 3 * s.size;
    const w = sz(2);
    blend(c, false);
    for (let k = 0; k < 2; k++) {
      const off = (k ? -1 : 1) * a * Math.sin(ph);
      const x = hx + nx * off;
      const y = hy + ny * off;
      if (s.charged) rect(c, x - w / 2 - 1, y - w / 2 - 1, w + 2, w + 2, '#ffe066');
      rect(c, x - w / 2, y - w / 2, w, w, r[k]);
      if (emit && Math.random() < 0.5) spawn(x, y, rnd(-4, 4), rnd(-10, 0), rnd(200, 320), col(tr.c[k % tr.c.length]), 1, tr.g, 0);
    }
  } else if (style === 'folha') {
    blend(c, false);
    const flip = Math.floor(now / 60) % 2 === 0;
    for (let k = 0; k < 5; k++) {
      const q = p - k * 0.07;
      if (q < 0) continue;
      const off = 4 * z * Math.sin(q * Math.PI * 3 + k);
      const x = s.x0 + dx * q + nx * off;
      const y = s.y0 + dy * q + ny * off;
      const lw = (flip ? 2 : 1) * z;
      const lh = (flip ? 1 : 2) * z;
      if (s.charged && k === 0) rect(c, x - 1, y - 1, lw + 2, lh + 2, '#ffe066');
      rect(c, x, y, lw, lh, r[k % 2]);
    }
    if (emit && Math.random() < 0.6) spawn(hx, hy, rnd(-8, 8), rnd(-6, 6), rnd(200, 360), col(tr.c[0]), 1, tr.g, 0);
  } else if (style === 'raio') {
    blend(c, true);
    c.fillStyle = s.charged ? '#ffe066' : QUIMERA[Math.floor(now / 40) % QUIMERA.length];
    zigzag(c, s.x0, s.y0, hx, hy, now, 3 * z);
    rect(c, hx - z, hy - z, 2 * z, 2 * z, '#ffffff');
  }
  // Mangue solta folhinhas; Cinza solta cinza caindo; Vapor solta baforadas
  if (emit && s.form === 'mangue' && Math.random() < 0.3) spawn(hx, hy, rnd(-6, 6), rnd(-4, 4), 300, col('#52c95f'), 1, 20, 0);
  if (emit && s.form === 'vapor' && Math.random() < 0.4) spawn(hx, hy, rnd(-10, 10), rnd(-12, -4), 320, col('#b9a7ff'), 2, -20, SHRINK);
}

function frame(now: number): void {
  const c = ctx;
  if (!c || !canvas) {
    raf = 0;
    return;
  }
  const dtMs = Math.min(50, now - last);
  last = now;
  const dt = dtMs / 1000;
  c.clearRect(0, 0, canvas.width, canvas.height);
  blendAdd = false;
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;

  if (alive > 0) {
    for (let k = 0; k < N; k++) {
      const i = k * F;
      if (P[i + LIFE] <= 0) continue;
      const before = P[i + MAX] - P[i + LIFE];
      P[i + LIFE] -= dtMs;
      if (P[i + LIFE] <= 0) {
        alive--;
        continue;
      }
      const flags = P[i + FLAGS];
      if (flags & STEP) {
        // anda só na virada de cada degrau
        const steps = Math.floor((before + dtMs) / STEP_MS) - Math.floor(before / STEP_MS);
        if (steps > 0) {
          P[i + X] += (P[i + VX] * STEP_MS * steps) / 1000;
          P[i + Y] += (P[i + VY] * STEP_MS * steps) / 1000;
        }
      } else {
        P[i + VY] += P[i + GRAV] * dt;
        P[i + X] += P[i + VX] * dt;
        P[i + Y] += P[i + VY] * dt;
      }
      const lifeK = P[i + LIFE] / P[i + MAX];
      let w = P[i + SIZE];
      let hh = w;
      if (flags & SHRINK) w = hh = Math.max(1, Math.ceil(w * lifeK));
      if (flags & FLUTTER) {
        const t = (P[i + MAX] - P[i + LIFE]) / 1000;
        w = Math.max(1, Math.round(w * Math.abs(Math.cos(t * 12 + k))));
        hh = 2;
      }
      blend(c, (flags & ADD) !== 0);
      c.globalAlpha = lifeK < 0.25 ? 0.5 : 1;
      c.fillStyle = colors[P[i + COL]];
      c.fillRect(Math.round(P[i + X] - w / 2), Math.round(P[i + Y] - hh / 2), w, hh);
    }
    c.globalAlpha = 1;
  }

  let busy = alive > 0;
  for (const s of spells) {
    if (!s.on) continue;
    busy = true;
    drawSpell(c, s, now, dtMs);
  }
  for (const b of bolts) {
    if (!b.on) continue;
    busy = true;
    if (now >= b.tEnd) {
      b.on = false;
      continue;
    }
    if (now < b.t0) continue;
    blend(c, true);
    c.fillStyle = b.color;
    zigzag(c, b.x0, b.y0, b.x1, b.y1, now, 4);
  }
  raf = busy ? requestAnimationFrame(frame) : 0;
  if (!busy) c.clearRect(0, 0, canvas.width, canvas.height);
}

// ---------- círculo de runas (canvas gerado ponto a ponto, uma vez por cor e tamanho) ----------

const GLYPH5 = ['00100|01110|10101|00100|00100', '10001|01010|00100|01010|10001', '11111|00100|01110|00100|11111', '10100|10100|11111|00101|00101', '01110|10001|10101|10001|01110', '11100|00100|11111|00100|00111', '10001|11011|10101|10001|10001', '00100|01010|10001|01010|00100'];
const GLYPH3 = ['010|111|010', '101|010|101', '111|010|111', '110|010|011', '010|101|010', '111|101|111', '100|111|001', '011|010|110'];
const runeCache = new Map<string, HTMLCanvasElement>();

function plotRing(c: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const n = Math.ceil(Math.PI * 2 * r * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    c.fillRect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), 1, 1);
  }
}

function drawRunes(size: number, color: string): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const c = cv.getContext('2d');
  if (!c) return cv;
  const m = (size - 1) / 2;
  const big = size >= 96;
  const r1 = m - 1;
  const r2 = r1 - (big ? 3 : 2);
  const g = big ? 5 : 3;
  const r3 = r2 - g - (big ? 6 : 4);
  c.fillStyle = color;
  plotRing(c, m, m, r1);
  plotRing(c, m, m, r2);
  plotRing(c, m, m, r3);
  // Hexagrama: dois triângulos inscritos no anel de dentro
  for (const base of [-90, 90]) {
    const pts = [0, 1, 2].map((k) => {
      const a = ((base + k * 120) * Math.PI) / 180;
      return [m + Math.cos(a) * (r3 - 1), m + Math.sin(a) * (r3 - 1)];
    });
    for (let k = 0; k < 3; k++) line(c, pts[k][0], pts[k][1], pts[(k + 1) % 3][0], pts[(k + 1) % 3][1]);
  }
  // 8 runas entre os anéis e um ponto branco entre elas
  const rr = (r2 + r3) / 2;
  const set = big ? GLYPH5 : GLYPH3;
  for (let k = 0; k < 8; k++) {
    const a = ((k * 45 - 90) * Math.PI) / 180;
    const gx = Math.round(m + Math.cos(a) * rr - (g - 1) / 2);
    const gy = Math.round(m + Math.sin(a) * rr - (g - 1) / 2);
    const rows = set[k].split('|');
    c.fillStyle = color;
    for (let y = 0; y < g; y++) for (let x = 0; x < g; x++) if (rows[y][x] === '1') c.fillRect(gx + x, gy + y, 1, 1);
    const b = a + Math.PI / 8;
    c.fillStyle = '#ffffff';
    c.fillRect(Math.round(m + Math.cos(b) * r1), Math.round(m + Math.sin(b) * r1), 1, 1);
  }
  return cv;
}

/** Cópia de um círculo de runas `size`×`size` na cor pedida (o desenho é gerado uma vez por cor e tamanho). */
export function runeCanvas(color: string, size = 128): HTMLCanvasElement {
  const key = `${color}|${size}`;
  let src = runeCache.get(key);
  if (!src) runeCache.set(key, (src = drawRunes(size, color)));
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  cv.className = 'runes';
  cv.getContext('2d')?.drawImage(src, 0, 0);
  return cv;
}
