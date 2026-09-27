import Phaser from 'phaser';
import type { Snap } from '@vb/shared';
import { flash, type EntView, type FxHost } from './fx';
import { FXC } from './fxpalette';
import { TILE } from './map';

/**
 * Zona como barreira mágica viva: só o arco visível é desenhado,
 * com runas correndo, anel-alvo, setas, rachaduras e fagulhas.
 */

// Glifos 3×3 da zona, cada um com até 2 retângulos [x, y, w, h].
const GLYPHS: readonly (readonly number[])[] = [
  [0, 0, 3, 1, 1, 1, 1, 2],
  [0, 1, 3, 1, 1, 0, 1, 3],
  [0, 0, 1, 3, 0, 2, 3, 1],
  [0, 0, 3, 1, 0, 2, 3, 1],
];
const MAX_RECTS = 140;
const PULSE_MS = 900;
const TAU = Math.PI * 2;
const BURN_PAT = [70] as const;

export class ZoneFx {
  /** centro do arco visível e meia-abertura (reaproveitados pelas fagulhas) */
  thetaC = 0;
  delta = Math.PI;
  private rects = 0;
  private phase = '';
  private phaseT0 = -1e9;
  private crackT = 0;
  private cracks = [
    { t0: -1e9, a: 0, seed: 0 },
    { t0: -1e9, a: 0, seed: 0 },
  ];
  private sparkAcc = 0;

  constructor(
    private host: FxHost,
    private g: Phaser.GameObjects.Graphics,
  ) {}

  reset(): void {
    this.phase = '';
    this.phaseT0 = -1e9;
    this.g.clear();
  }

  /** Troca de fase: a linha pulsa e as rachaduras correm pelo arco. */
  onSnap(s: Snap, now: number, fresh: boolean): void {
    if (s.ph !== this.phase) {
      if (!fresh && this.phase !== '') this.phaseT0 = now;
      this.phase = s.ph;
    }
  }

  private rect(x: number, y: number, w: number, h: number): void {
    if (this.rects >= MAX_RECTS) return;
    this.rects++;
    this.g.fillRect(x, y, w, h);
  }

  draw(s: Snap, now: number, delta: number): void {
    const g = this.g;
    const fx = this.host.fx;
    const rm = fx.rm;
    g.clear();
    this.rects = 0;
    const cx = s.z.x * TILE + TILE / 2;
    const cy = s.z.y * TILE + TILE / 2;
    const r = Math.max(0, s.z.r * TILE);
    const wv = this.host.fx.view;
    const camX = wv.centerX;
    const camY = wv.centerY;
    const half = Math.hypot(wv.width, wv.height) / 2;
    const duel = s.ph === 'duelo';
    const final = s.ph === 'final';
    this.thetaC = Math.atan2(camY - cy, camX - cx);
    this.delta = r > 0 ? Math.min(Math.PI, (half + 16) / r) : Math.PI;
    const dc = Math.hypot(camX - cx, camY - cy);
    const visible = r > 0 && Math.abs(dc - r) < half + 16;
    const a0 = this.thetaC - this.delta;
    const a1 = this.thetaC + this.delta;
    const full = this.delta >= Math.PI;
    const pe = now - this.phaseT0;
    const pulsing = pe >= 0 && pe < PULSE_MS && !rm;

    // (a) Escurecimento externo (respira na fase final) e névoa.
    const dark = final && !rm ? 0.55 + 0.05 * Math.sin((now / 1000) * TAU * 0.8) : 0.55;
    g.lineStyle(4000, FXC.zoneDark, dark);
    g.strokeCircle(cx, cy, r + 2000);
    if (!visible) {
      this.sparkAcc = 0;
      return;
    }
    this.arc(cx, cy, r + 2, 3, FXC.magenta, 0.18, full, a0, a1);
    this.arc(cx, cy, r + 5, 3, FXC.magenta, 0.12, full, a0, a1);
    this.arc(cx, cy, r + 8, 3, FXC.magenta, 0.06, full, a0, a1);

    // (b) Linha principal e anel interno.
    let w = duel ? 3 : 2;
    if (pulsing) w = Math.round(2 + 4 * Math.abs(Math.sin((pe / PULSE_MS) * Math.PI * 3)));
    this.arc(cx, cy, r, w, duel ? FXC.red : FXC.magenta, 0.95, full, a0, a1);
    this.arc(cx, cy, r - 2, 1, FXC.pink, 0.8, full, a0, a1);

    // (c) Runas a cada 14 px (28 no tier baixo) em r+5, correndo no sentido horário.
    const R = r + 5;
    const gap = fx.tier === 2 ? 28 : 14;
    const step = gap / R;
    const phi = rm ? 0 : ((now / 1000) * 12) / R;
    const kFrom = Math.ceil((a0 - phi) / step);
    const kTo = Math.floor((a1 - phi) / step);
    const blink = duel ? (Math.floor(now / 300) & 1 ? 1 : 0.35) : 1;
    for (let k = kFrom; k <= kTo; k++) {
      const a = k * step + phi;
      const x = Math.round(cx + Math.cos(a) * R) - 1;
      const y = Math.round(cy + Math.sin(a) * R) - 1;
      const pat = GLYPHS[((k % 4) + 4) % 4];
      const alpha = rm ? 1 : 0.8 + 0.2 * Math.sin((now / 600) * TAU + k);
      g.fillStyle(duel ? FXC.gold : k & 1 ? FXC.magenta : FXC.pink, alpha * blink);
      this.rect(x + pat[0], y + pat[1], pat[2], pat[3]);
      this.rect(x + pat[4], y + pat[5], pat[6], pat[7]);
    }

    // (e) Setas para dentro enquanto a zona fecha.
    const tr = s.z.tr * TILE;
    if (s.z.r > s.z.tr + 0.5) {
      const Rc = r - 7;
      const cs = 48 / Math.max(Rc, 1);
      const slide = rm ? 0 : Math.round(3 * ((now % 800) / 800));
      g.fillStyle(FXC.magenta, 0.7);
      for (let k = Math.ceil(a0 / cs); k <= Math.floor(a1 / cs); k++) {
        const a = k * cs;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const x = Math.round(cx + c * (Rc - slide));
        const y = Math.round(cy + sn * (Rc - slide));
        this.chevron(x, y, c, sn);
      }
    }

    // (f) Rachaduras: a cada 400 ms (200 na fase final), 1 ou 2 raios para fora.
    this.crackT += delta;
    const every = final ? 200 : 400;
    if (this.crackT >= every) {
      this.crackT = 0;
      const n = Math.random() < 0.5 ? 1 : 2;
      for (let i = 0; i < n; i++) {
        const c = this.cracks[i];
        c.t0 = now;
        c.a = a0 + Math.random() * (a1 - a0);
        c.seed = Math.random() * 100;
      }
    }
    const crackColor = final || duel ? FXC.red : FXC.magenta;
    for (const c of this.cracks) if (now - c.t0 < 80) this.crack(cx, cy, r, c.a, c.seed, crackColor);
    if (pulsing) {
      // (h) 30 rachaduras correm pelo arco na troca de fase.
      for (let k = 0; k < 30; k++) {
        const t = pe - k * 30;
        if (t >= 0 && t < 80) this.crack(cx, cy, r, a0 + ((a1 - a0) * (k + 0.5)) / 30, k * 3.7, crackColor);
      }
    }

    // (d) Anel-alvo: pontos brancos a cada 8 px, no sentido anti-horário.
    if (s.z.tr < s.z.r - 0.5 && tr > 0 && Math.abs(dc - tr) < half + 16) {
      const dt = Math.min(Math.PI, (half + 16) / tr);
      const st = 8 / tr;
      const ph = rm ? 0 : -((now / 1000) * 6) / tr;
      g.fillStyle(0xffffff, 0.35);
      for (let k = Math.ceil((this.thetaC - dt - ph) / st); k <= Math.floor((this.thetaC + dt - ph) / st); k++) {
        const a = k * st + ph;
        this.rect(Math.round(cx + Math.cos(a) * tr), Math.round(cy + Math.sin(a) * tr), 1, 1);
      }
    }

    // (g) Fagulhas subindo da borda (sem fagulhas no tier baixo e com reduced-motion).
    const cap = fx.zoneCap;
    if (cap > 0) {
      const period = (fx.tier === 0 ? 90 : 180) / (duel ? 2 : 1);
      this.sparkAcc += delta;
      while (this.sparkAcc >= period) {
        this.sparkAcc -= period;
        const a = a0 + Math.random() * (a1 - a0);
        const rr = r + (Math.random() * 4 - 2);
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (!fx.view.contains(x, y)) continue;
        const P = fx.reset();
        P.frame = 'p1';
        P.vx = -Math.cos(a) * 4;
        P.vy = -Math.sin(a) * 4 - (10 + Math.random() * 8);
        P.lifeMin = 700;
        P.lifeMax = 1100;
        P.a0 = 0.9;
        // Fagulhas #ff5fd2→#b9a7ff; no Duelo viram brasas #ffcf3f→#ff4f6d.
        P.c0 = duel ? FXC.gold : FXC.magenta;
        P.c1 = duel ? FXC.red : FXC.vapor;
        fx.wisp.emitParticleAt(x, y, 1);
      }
    }
  }

  private arc(cx: number, cy: number, rad: number, w: number, color: number, alpha: number, full: boolean, a0: number, a1: number): void {
    if (rad <= 0) return;
    const g = this.g;
    g.lineStyle(w, color, alpha);
    if (full) g.strokeCircle(cx, cy, rad);
    else {
      g.beginPath();
      g.arc(cx, cy, rad, a0, a1);
      g.strokePath();
    }
  }

  /** Seta 3×2 apontando para dentro (rotação só em degraus de 90°). */
  private chevron(x: number, y: number, c: number, s: number): void {
    if (Math.abs(c) > Math.abs(s)) {
      // aponta para a esquerda (c > 0) ou direita
      const tip = c > 0 ? 0 : 1;
      this.rect(x + 1 - tip, y - 1, 1, 1);
      this.rect(x + tip, y, 1, 1);
      this.rect(x + 1 - tip, y + 1, 1, 1);
    } else {
      const tip = s > 0 ? 0 : 1;
      this.rect(x - 1, y + 1 - tip, 1, 1);
      this.rect(x, y + tip, 1, 1);
      this.rect(x + 1, y + 1 - tip, 1, 1);
    }
  }

  private crack(cx: number, cy: number, r: number, a: number, seed: number, color: number): void {
    const g = this.g;
    const len = 6 + (seed % 5);
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (let pass = 0; pass < 2; pass++) {
      g.lineStyle(pass ? 1 : 2, pass ? 0xffffff : color, 1);
      let x0 = cx + c * r;
      let y0 = cy + s * r;
      for (let i = 1; i <= 3; i++) {
        const d = r + (len * i) / 3;
        const off = i < 3 ? (((seed * (i + 1)) | 0) % 5) - 2 : 0;
        const x1 = Math.round(cx + c * d - s * off);
        const y1 = Math.round(cy + s * d + c * off);
        g.lineBetween(Math.round(x0), Math.round(y0), x1, y1);
        x0 = x1;
        y0 = y1;
      }
    }
  }

  /** Queimando fora da zona: pixels magenta sobem e o sprite pisca a cada 600 ms. */
  burn(v: EntView, now: number, delta: number, mine: boolean): void {
    const fx = this.host.fx;
    v.burning = true;
    v.burnT += delta;
    const every = mine ? 300 : 450;
    if (v.burnT >= every) {
      v.burnT -= every;
      const P = fx.reset();
      P.frame = 'p1';
      P.pal = BURN_PAL;
      P.jit = 5;
      P.vy = -25;
      P.spMax = 5;
      P.lifeMin = P.lifeMax = 400;
      fx.emit(fx.spark, 2, v.x, v.y - 2, mine, true);
    }
    v.burnFlashT += delta;
    if (v.burnFlashT >= 600) {
      v.burnFlashT = 0;
      if (!v.flashPat) flash(v, FXC.magenta, BURN_PAT, now, false);
    }
  }
}

const BURN_PAL: readonly number[] = [FXC.magenta, FXC.pink];
