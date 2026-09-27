import Phaser from 'phaser';
import type { Elem, Form, FxEvent, Stage } from '@vb/shared';
import { creaturePixels, drawCreature, lookKey } from './creature';
import { flash, squash, type EntView, type FxHost } from './fx';
import { FORM_TINT, FXC, RAMP, bodyTint, lightTint } from './fxpalette';
import { TILE } from './map';

/**
 * Círculos de runas (evolução e eliminação), desmoronar de estágio,
 * orbe da evolução roubada e o bicho que se desfaz nos próprios pixels.
 */

type Steal = Extract<FxEvent, { k: 's' }>;
type Elim = Extract<FxEvent, { k: 'x' }>;

const SWAPS_FULL = [140, 120, 100, 80, 60, 50, 40] as const;
const SWAPS_SHORT = [110, 110, 110] as const;
const PAT_RED2 = [80, 60, 80] as const;
const RUNE_FRAMES = ['rune0', 'rune1', 'rune2', 'rune3'] as const;
const TAU = Math.PI * 2;

const enum Mode {
  Full,
  Short,
  Inverse,
}

interface Circle {
  on: boolean;
  id: number;
  t0: number;
  x: number;
  y: number;
  mode: Mode;
  final: boolean;
  mine: boolean;
  body: number;
  light: number;
  popAt: number;
  dur: number;
  popped: boolean;
  nRunes: number;
  nParts: number;
  emitted: number;
  runes: (Phaser.GameObjects.Image | null)[];
  column: Phaser.GameObjects.Image | null;
  oldKey: string;
  pal: number[];
}

interface Orb {
  on: boolean;
  t0: number;
  w: number;
  l: number;
  lx: number;
  ly: number;
  second: boolean;
  first: boolean;
  tr: boolean;
  crown: boolean;
  mine: boolean;
  pal: number[];
  img: Phaser.GameObjects.Image | null;
  crownImg: Phaser.GameObjects.Image | null;
  runes: (Phaser.GameObjects.Image | null)[];
  acc: number;
  arrived: boolean;
  hx: number;
  hy: number;
}

interface Death {
  on: boolean;
  t0: number;
  id: number;
  x: number;
  y: number;
  sc: number;
  f: Form;
  s: Stage;
  o: Elem[];
  by: number;
  r: 'b' | 'z' | 'd';
  mine: boolean;
  exploded: boolean;
  circled: boolean;
  soul: Phaser.GameObjects.Image | null;
  column: Phaser.GameObjects.Image | null;
  absorbed: boolean;
}

const BO = Phaser.Math.Easing.Back.Out;
const SIO = Phaser.Math.Easing.Sine.InOut;
const bez = Phaser.Math.Interpolation.QuadraticBezier;

export class Runes {
  private circles: Circle[] = [];
  private orbs: Orb[] = [];
  private deaths: Death[] = [];
  private souls: Phaser.GameObjects.Image[] = [];
  private soulBusy = [false, false, false];
  private gray: Phaser.Filters.ColorMatrix | null = null;
  private grayT0 = 0;

  constructor(
    private scene: Phaser.Scene,
    private host: FxHost,
  ) {
    for (let i = 0; i < 3; i++) {
      this.circles.push({ on: false, id: 0, t0: 0, x: 0, y: 0, mode: Mode.Full, final: false, mine: false, body: 0, light: 0, popAt: 0, dur: 0, popped: false, nRunes: 0, nParts: 0, emitted: 0, runes: [null, null, null, null, null, null, null, null], column: null, oldKey: '', pal: [0, 0] });
    }
    for (let i = 0; i < 2; i++) {
      this.orbs.push({ on: false, t0: 0, w: 0, l: 0, lx: 0, ly: 0, second: false, first: false, tr: false, crown: false, mine: false, pal: [], img: null, crownImg: null, runes: [null, null, null], acc: 0, arrived: false, hx: 0, hy: 0 });
    }
    for (let i = 0; i < 6; i++) {
      this.deaths.push({ on: false, t0: 0, id: 0, x: 0, y: 0, sc: 1, f: 'neutro', s: 0, o: [], by: 0, r: 'b', mine: false, exploded: false, circled: false, soul: null, column: null, absorbed: false });
    }
    for (let i = 0; i < 3; i++) {
      this.souls.push(scene.add.image(0, 0, 'fx', 'p1').setVisible(false).setDepth(890).setOrigin(0.5, 0.62));
    }
  }

  clear(): void {
    const fx = this.host.fx;
    for (const c of this.circles) if (c.on) this.endCircle(c);
    for (const o of this.orbs) if (o.on) this.endOrb(o);
    for (const d of this.deaths) {
      d.on = false;
      d.column = fx.freeImage(d.column);
    }
    for (let i = 0; i < 3; i++) this.freeSoul(this.souls[i]);
    this.removeGray();
  }

  // ---------------------------------------------------------------- evolução

  /** Evolução: 'full' para o seu bicho, 'short' para os outros e para o vencedor do roubo. */
  evolve(v: EntView, s: Stage, now: number, full: boolean): void {
    const fx = this.host.fx;
    let c: Circle | null = null;
    for (const k of this.circles) if (!k.on) c ??= k;
    const d = v.data;
    const body = bodyTint(d.f, d.o);
    const light = lightTint(d.f, d.o);
    const mode = full ? Mode.Full : Mode.Short;
    const popAt = full ? 600 : 330;
    // A textura antiga fica presa até o estouro.
    v.texSwapAt = now + popAt;
    v.texPop = 1.5;
    flash(v, 0xffffff, full ? SIL_FULL : SIL_SHORT, now, false);
    if (!c) {
      // 4º simultâneo: só as partículas.
      const P = fx.reset();
      P.frame = 'plus';
      P.pal = [light, body];
      P.spMin = 60;
      P.spMax = 110;
      P.lifeMin = P.lifeMax = 400;
      fx.emit(fx.spark, 12, v.x, v.y - 2, full);
      return;
    }
    c.on = true;
    c.id = d.id;
    c.t0 = now;
    c.x = v.x;
    c.y = v.y + 6;
    c.mode = mode;
    c.final = full && s === 3;
    c.mine = full;
    c.body = c.pal[1] = body;
    c.light = c.pal[0] = light;
    c.popAt = popAt;
    c.dur = full ? (c.final ? 1300 : 900) : 500;
    c.popped = false;
    c.nRunes = full ? (c.final ? 8 : 6) : 4;
    c.nParts = full ? (c.final ? 40 : 24) : 12;
    c.emitted = 0;
    c.oldKey = v.key;
    this.takeRunes(c);
    c.column = fx.takeImage('p1');
    c.column?.setOrigin(0.5, 1).setDisplaySize(4, 40).setTint(light).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
  }

  private takeRunes(c: Circle): void {
    const fx = this.host.fx;
    for (let i = 0; i < c.nRunes; i++) {
      const r = fx.takeImage(RUNE_FRAMES[i % 4]);
      if (!r) break;
      r.setTint(c.mode === Mode.Inverse ? FXC.red : c.light).setBlendMode(Phaser.BlendModes.ADD).setDepth(8).setVisible(false);
      c.runes[i] = r;
    }
  }

  /** Círculo invertido da eliminação (#ff4f6d, rx 16→0 em 500 ms). */
  private inverse(x: number, y: number, now: number, mine: boolean): void {
    let c: Circle | null = null;
    for (const k of this.circles) if (!k.on) c ??= k;
    if (!c) return;
    c.on = true;
    c.id = -1;
    c.t0 = now;
    c.x = x;
    c.y = y;
    c.mode = Mode.Inverse;
    c.final = false;
    c.mine = mine;
    c.body = c.light = FXC.red;
    c.popAt = 1e9;
    c.dur = 500;
    c.popped = true;
    c.nRunes = 4;
    c.nParts = 0;
    c.emitted = 0;
    this.takeRunes(c);
    c.column = null;
  }

  private endCircle(c: Circle): void {
    const fx = this.host.fx;
    for (let i = 0; i < c.runes.length; i++) c.runes[i] = fx.freeImage(c.runes[i]);
    c.column = fx.freeImage(c.column);
    c.on = false;
  }

  private updateCircle(c: Circle, now: number): void {
    const h = this.host;
    const fx = h.fx;
    const el = now - c.t0;
    if (el >= c.dur) {
      this.endCircle(c);
      return;
    }
    const v = c.id >= 0 ? h.view(c.id) : undefined;
    if (v) {
      c.x = v.x;
      c.y = v.y + 6;
    }
    const g = h.groundG;
    const rot = fx.rm ? 0 : (el / 1000) * (Math.PI / 6);
    // Raio: abre com Back.easeOut em 220 ms; depois do estouro, fecha até o fim.
    let rx: number;
    if (c.mode === Mode.Inverse) rx = 16 * (1 - el / c.dur);
    else {
      const open = Math.min(1, el / 220);
      rx = 12 * BO(open);
      if (el > c.popAt) rx *= 1 - (el - c.popAt) / (c.dur - c.popAt);
    }
    const alpha = c.mode === Mode.Inverse ? 1 : el > c.popAt ? 1 - (el - c.popAt) / (c.dur - c.popAt) : 1;
    if (rx >= 1) {
      this.ellipse(g, c.x, c.y, rx, rx * 0.4, rot, c.body, alpha);
      if (c.mode !== Mode.Inverse && rx > 8) this.ellipse(g, c.x, c.y, rx * (8 / 12), rx * (8 / 12) * 0.4, -rot, c.light, alpha);
      if (c.final) {
        this.ellipse(g, c.x, c.y, rx * (16 / 12), rx * (16 / 12) * 0.4, rot * 0.5, c.body, alpha * 0.8);
        this.ellipse(g, c.x, c.y, rx * (20 / 12), rx * (20 / 12) * 0.4, -rot * 0.5, c.light, alpha * 0.6);
      }
    }
    // Runas nos vértices do hexagrama, acendendo uma a cada 60 ms.
    for (let i = 0; i < c.nRunes; i++) {
      const r = c.runes[i];
      if (!r) continue;
      const lit = el >= i * 60 && rx >= 2;
      r.setVisible(lit);
      if (!lit) continue;
      const a = rot + (i / c.nRunes) * TAU;
      r.setPosition(Math.round(c.x + Math.cos(a) * rx), Math.round(c.y + Math.sin(a) * rx * 0.4 - 3)).setAlpha(alpha);
    }
    if (c.mode === Mode.Inverse) return;
    // Silhueta alternando textura antiga e nova até o estouro.
    if (v && el < c.popAt) {
      const swaps = c.mode === Mode.Full ? SWAPS_FULL : SWAPS_SHORT;
      let e = el;
      let i = 0;
      while (i < swaps.length && e >= swaps[i]) e -= swaps[i++];
      const key = i & 1 ? h.texFor(v.data) : c.oldKey;
      if (v.img.texture.key !== key) v.img.setTexture(key);
    }
    // Partículas convergindo da borda do anel para o centro.
    const p0 = c.mode === Mode.Full ? 150 : 60;
    const p1 = c.mode === Mode.Full ? 550 : 300;
    if (el >= p0 && c.emitted < c.nParts) {
      const due = Math.min(c.nParts, Math.ceil(((el - p0) / (p1 - p0)) * c.nParts));
      const P = fx.reset();
      P.frame = 'p1';
      P.pal = c.pal;
      P.mt = true;
      P.tx = c.x;
      P.ty = c.y - 8;
      P.lifeMin = P.lifeMax = 400;
      P.a0 = 1;
      P.a1 = 0.7;
      for (; c.emitted < due; c.emitted++) {
        const a = Math.random() * TAU;
        P.frame = c.emitted & 1 ? 'p2' : 'p1';
        fx.emit(fx.magic, 1, c.x + Math.cos(a) * 12, c.y + Math.sin(a) * 5, c.mine, true);
      }
    }
    // Coluna de luz: alpha 0 → 0,7 → 0 em 500 ms.
    if (c.column) {
      const ce = el - 100;
      if (ce >= 0 && ce < 500) c.column.setPosition(Math.round(c.x), Math.round(c.y)).setAlpha(0.7 * Math.sin((ce / 500) * Math.PI));
      else c.column.setAlpha(0);
    }
    if (!c.popped && el >= c.popAt) {
      c.popped = true;
      this.burst(c, v, now);
    }
    if (c.final && el >= c.popAt && el < c.popAt + 500) {
      // Onda de choque desenhada: rx 4→40, 2→1 px, alpha 1→0.
      const k = (el - c.popAt) / 500;
      const w = k < 0.5 ? 2 : 1;
      this.ellipse(g, c.x, c.y, 4 + 36 * k, (4 + 36 * k) * 0.4, 0, c.light, 1 - k, w);
    }
  }

  private burst(c: Circle, v: EntView | undefined, now: number): void {
    const h = this.host;
    const fx = h.fx;
    const form = v ? v.data.f : 'neutro';
    let P = fx.reset();
    P.frame = 'plus';
    P.pal = c.pal;
    P.spMin = 60;
    P.spMax = 110;
    P.lifeMin = P.lifeMax = 400;
    P.a1 = 0.3;
    fx.emit(fx.spark, 16, c.x, c.y - 8, c.mine);
    P = fx.reset();
    P.seq = h.fx.GROW_BIG;
    P.c0 = FORM_TINT[form];
    P.lifeMin = P.lifeMax = 300;
    P.a1 = 0.2;
    fx.emit(fx.ring, 1, c.x, c.y, c.mine, true);
    if (c.mode === Mode.Full) {
      h.addTrauma(0.35);
      h.punch(0.06, 120, 300);
    }
    if (c.final) {
      P = fx.reset();
      P.frame = 'star';
      P.c0 = FXC.gold;
      P.spMin = 40;
      P.spMax = 90;
      P.lifeMin = P.lifeMax = 500;
      fx.emit(fx.spark, 6, c.x, c.y - 8, true);
      fx.screenFlash(FORM_TINT[form], 0.25, 150, now);
    }
  }

  /** Elipse pixelada: pontos 1×1 com Math.round (32-48 por anel), dentro do teto do groundG. */
  private ellipse(g: Phaser.GameObjects.Graphics, cx: number, cy: number, rx: number, ry: number, rot: number, color: number, alpha: number, w = 1): void {
    const h = this.host;
    const n = Math.max(12, Math.min(48, Math.round(rx * 3)));
    if (h.groundBudget + n > 220) return;
    h.groundBudget += n;
    g.fillStyle(color, alpha);
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * TAU;
      g.fillRect(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), w, 1);
    }
  }

  // ---------------------------------------------------------------- desmoronar

  /** Perda de estágio ('z' ou perdedor do roubo): fragmentos, pisca e a textura menor entra com pop. */
  crumble(v: EntView, now: number, swapMs: number, zone: boolean): void {
    const fx = this.host.fx;
    const mine = v.data.id === this.host.focusId();
    const P = fx.reset();
    P.frame = 'p2';
    P.pal = [FXC.stone, FORM_TINT[v.data.f]];
    P.spMin = 20;
    P.spMax = 30;
    P.ay = 160;
    P.lifeMin = P.lifeMax = 450;
    P.a1 = 0.5;
    fx.emit(fx.ground, 10, v.x, v.y - 2, mine);
    v.blinkT0 = now;
    v.blinkUntil = now + 360;
    v.texSwapAt = now + swapMs;
    v.texPop = 0.6;
    if (zone) {
      fx.number('m', '-1', v.x, v.y - 6, 1, 0, v.data.id, now);
      if (mine) this.host.addTrauma(0.3);
    }
  }

  // ---------------------------------------------------------------- roubo

  steal(e: Steal, now: number): void {
    const h = this.host;
    const fx = h.fx;
    const wv = h.view(e.w);
    const lv = h.view(e.l);
    const focus = h.focusId();
    const mine = e.w === focus || e.l === focus;
    if (lv) {
      flash(lv, FXC.red, PAT_RED2, now, fx.rm);
      squash(lv, 1.2, 0.7, 120, 0, 150, now);
      const P = fx.reset();
      P.frame = 'shard';
      P.c0 = FORM_TINT[lv.data.f];
      P.spMin = 20;
      P.spMax = 50;
      P.angMin = 180;
      P.angMax = 360;
      P.ay = 150;
      P.lifeMin = P.lifeMax = 400;
      fx.emit(fx.ground, 8, lv.x, lv.y - 2, mine);
      lv.texSwapAt = now + 150;
      lv.texPop = 0.6;
      fx.number('r', `-${e.n}`, lv.x, lv.y - 4, 1, 0, e.l, now);
    }
    if (mine) {
      h.punch(0.08, 250, 400);
      h.addTrauma(0.4);
    }
    if (!wv) return;
    // O vencedor segura a textura até o orbe chegar (e a versão curta estourar).
    wv.texSwapAt = now + 1000 + (e.n === 2 ? 180 : 0) + 330;
    wv.texPop = 1.5;
    for (let i = 0; i < e.n; i++) {
      let o: Orb | null = null;
      for (const k of this.orbs) if (!k.on) o ??= k;
      if (!o) break;
      o.on = true;
      o.t0 = now + 150 + i * 180;
      o.w = e.w;
      o.l = e.l;
      o.lx = lv ? lv.x : (e.x + 0.5) * TILE;
      o.ly = lv ? lv.y - 6 : (e.y + 0.5) * TILE;
      o.second = i === 1;
      o.first = i === 0;
      o.tr = !!e.tr && i === e.n - 1;
      o.crown = !!e.cr && i === 0;
      o.mine = mine;
      o.pal.length = 0;
      const types = lv ? lv.data.o : [];
      for (const t of types) o.pal.push(RAMP[t][1]);
      if (o.pal.length === 0) o.pal.push(RAMP.neutro[1]);
      o.acc = 0;
      o.arrived = !lv;
      o.img = fx.takeImage('orb');
      o.img?.setTint(o.second ? FXC.red : lv ? FORM_TINT[lv.data.f] : FXC.gold).setScale(0).setVisible(false);
      for (let r = 0; r < 3; r++) o.runes[r] = fx.takeImage(RUNE_FRAMES[r])?.setTint(FXC.gold2).setBlendMode(Phaser.BlendModes.ADD).setVisible(false) ?? null;
      o.crownImg = o.crown ? (fx.takeImage('crown')?.setTint(FXC.gold).setVisible(false) ?? null) : null;
      if (!lv) {
        // Sem o perdedor na tela: só a chegada no vencedor.
        o.t0 = now + 150 + i * 180 - 850;
      }
    }
  }

  private endOrb(o: Orb): void {
    const fx = this.host.fx;
    o.img = fx.freeImage(o.img);
    o.crownImg = fx.freeImage(o.crownImg);
    for (let r = 0; r < 3; r++) o.runes[r] = fx.freeImage(o.runes[r]);
    o.on = false;
  }

  private updateOrb(o: Orb, now: number, delta: number): void {
    const h = this.host;
    const fx = h.fx;
    const el = now - o.t0;
    if (el < 0) return;
    const wv = h.view(o.w);
    const lv = h.view(o.l);
    if (lv) {
      o.lx = lv.x;
      o.ly = lv.y - 6;
    }
    if (!wv) {
      this.endOrb(o);
      return;
    }
    const wx = wv.x;
    const wy = wv.y - 6;
    const img = o.img;
    if (el < 850) {
      // Nasce (escala 0→2 em 2 degraus) e voa de 100 a 850 ms num arco alto.
      const p = el < 100 ? 0 : SIO((el - 100) / 750);
      const dist = Math.hypot(wx - o.lx, wy - o.ly);
      const x = bez(p, o.lx, (o.lx + wx) / 2, wx);
      const y = bez(p, o.ly, (o.ly + wy) / 2 - 2 * (28 + dist * 0.2), wy);
      o.hx = x;
      o.hy = y;
      img?.setVisible(true).setScale(el < 60 ? 1 : 2).setPosition(Math.round(x), Math.round(y));
      const spin = fx.rm ? 0 : (el / 400) * TAU;
      for (let r = 0; r < 3; r++) {
        const a = spin + (r / 3) * TAU;
        o.runes[r]?.setVisible(true).setPosition(Math.round(x + Math.cos(a) * 6), Math.round(y + Math.sin(a) * 6));
      }
      if (el >= 100) {
        // Rastro nas cores dos tipos do perdedor e linha tracejada entre os dois.
        o.acc += delta;
        const P = fx.reset();
        P.frame = 'p2';
        P.pal = o.second ? RED_PAL : o.pal;
        P.jit = 2;
        P.ay = 30;
        P.lifeMin = P.lifeMax = 400;
        while (o.acc >= 25) {
          o.acc -= 25;
          fx.emit(fx.pixels, 2, x, y, o.mine);
        }
        if (o.first) this.dashed(o.lx, o.ly, wx, wy);
      }
      if (o.crownImg) {
        const ce = el;
        if (ce < 500) {
          const k = ce / 500;
          const cx = bez(k, o.lx, (o.lx + wx) / 2, wx);
          const cy = bez(k, o.ly - 8, Math.min(o.ly, wy) - 30, wy - 12);
          o.crownImg.setVisible(true).setPosition(Math.round(cx), Math.round(cy));
          // 4 brilhos ao longo do voo
          const step = (ce / 125) | 0;
          if (step >= 1 && step !== (((ce - delta) / 125) | 0)) {
            const P = fx.reset();
            P.frame = 'plus';
            P.c0 = FXC.ghost;
            P.lifeMin = P.lifeMax = 300;
            fx.emit(fx.spark, 1, cx, cy, o.mine, true);
          }
        } else o.crownImg = fx.freeImage(o.crownImg);
      }
      return;
    }
    if (!o.arrived) {
      o.arrived = true;
      for (let r = 0; r < 3; r++) o.runes[r] = fx.freeImage(o.runes[r]);
      o.crownImg = fx.freeImage(o.crownImg);
      const P = fx.reset();
      P.frame = 'p1';
      P.pal = o.second ? RED_PAL : o.pal;
      P.rad = 18;
      P.mt = true;
      P.tx = wx;
      P.ty = wy;
      P.lifeMin = P.lifeMax = 300;
      P.a1 = 0.8;
      fx.emit(fx.magic, 16, wx, wy, o.mine);
      if (o.first) this.evolve(wv, wv.data.s, now, false);
      fx.number('y', '+1', wx, wy - 2, 1, 0, o.w, now);
      if (!o.tr) img?.setVisible(false);
    }
    const ae = el - 850;
    // Anel de choque dourado: rx 4→22 em 300 ms.
    if (ae < 300) {
      const k = ae / 300;
      this.ellipseAir(wx, wv.y + 2, 4 + 18 * k, (4 + 18 * k) * 0.5, FXC.gold, 1 - k);
    }
    if (o.tr && img && ae < 600) {
      // Troféu: vira estrela dourada que sobe girando em degraus de 90°.
      img.setTexture('fx', 'star').setTint(FXC.gold).setScale(1).setVisible(true).setAngle(Math.floor(ae / 100) * 90).setPosition(Math.round(wx), Math.round(wy - 10 - 12 * (ae / 600)));
    }
    if (ae >= 600 || (!o.tr && ae >= 300)) this.endOrb(o);
  }

  private dashed(x0: number, y0: number, x1: number, y1: number): void {
    const g = this.host.airG;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.min(40, Math.floor(len / 4));
    g.fillStyle(FXC.gold, 0.35);
    for (let i = 0; i < n; i++) {
      const k = (i * 4) / len;
      g.fillRect(Math.round(x0 + (x1 - x0) * k), Math.round(y0 + (y1 - y0) * k), 2, 1);
    }
  }

  private ellipseAir(cx: number, cy: number, rx: number, ry: number, color: number, alpha: number): void {
    const g = this.host.airG;
    const n = Math.max(16, Math.min(40, Math.round(rx * 2.5)));
    g.fillStyle(color, alpha);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      g.fillRect(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), 1, 1);
    }
  }

  // ---------------------------------------------------------------- eliminação

  /** 'x': o bicho se desfaz nos próprios pixels e a alma sobe (a EntView já está na lista dying). */
  eliminate(e: Elim, v: EntView | undefined, now: number): void {
    const h = this.host;
    const fx = h.fx;
    let d: Death | null = null;
    for (const k of this.deaths) if (!k.on) d ??= k;
    const focus = h.view(h.focusId());
    const x = v ? v.x : (e.x + 0.5) * TILE;
    const y = v ? v.y : (e.y + 0.5) * TILE;
    const mine = e.id === h.meId() || e.id === h.focusId();
    if (focus && e.id !== h.focusId() && Math.hypot(focus.x - x, focus.y - y) < 6 * TILE) h.addTrauma(0.5);
    if (e.id === h.meId()) {
      h.addTrauma(0.6);
      h.punch(0.15, 600, 1500);
      this.startGray(now);
    }
    if (v) {
      v.dieAt = now + (e.r === 'd' ? 260 : 200);
      v.fadeMs = 0;
      if (v.label) v.label.setVisible(false);
      v.hidden = true;
      if (e.r === 'd') squash(v, 0.01, 1, 240, 1000, 0, now, 3);
      else {
        flash(v, 0xffffff, WHITE_180, now, false);
        squash(v, 0.7, 1.3, 180, 1000, 0, now, 3);
      }
    }
    if (!d) {
      if (e.r !== 'd') this.explode(e, x, y, v ? v.base : 1, mine);
      return;
    }
    d.on = true;
    d.t0 = now;
    d.id = e.id;
    d.x = x;
    d.y = y;
    d.sc = v ? v.base : 1;
    d.f = e.f;
    d.s = e.s;
    d.o = e.o;
    d.by = e.by;
    d.r = e.r;
    d.mine = mine;
    d.exploded = false;
    d.circled = false;
    d.absorbed = false;
    d.soul = null;
    d.column = fx.takeImage('p1');
    if (e.r === 'd') {
      d.column?.setOrigin(0.5, 1).setDisplaySize(6, 48).setTint(FXC.lilac).setBlendMode(Phaser.BlendModes.ADD).setPosition(Math.round(x), Math.round(y + 6)).setAlpha(0.8);
      const P = fx.reset();
      P.frame = 'plus';
      P.c0 = FXC.lilac;
      P.angMin = 250;
      P.angMax = 290;
      P.spMin = 20;
      P.spMax = 40;
      P.ay = -40;
      P.lifeMin = P.lifeMax = 600;
      fx.emit(fx.spark, 6, x, y - 2, mine);
    } else d.column?.setOrigin(0.5, 1).setDisplaySize(4, 40).setTint(FXC.magenta).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
  }

  private explode(e: { f: Form; s: Stage; o: Elem[]; r: 'b' | 'z' | 'd' }, x: number, y: number, sc: number, mine: boolean): void {
    const h = this.host;
    const fx = h.fx;
    const look = { form: e.f, stage: e.s, order: e.o };
    const px = creaturePixels(look);
    const count = px.length / 3;
    let stride = fx.tier + 2;
    if (count / stride > 110) stride = Math.ceil(count / 110);
    const z = h.zoneWorld();
    const P = fx.reset();
    P.spMin = 30;
    P.spMax = 90;
    P.ay = -40;
    P.lifeMin = 700;
    P.lifeMax = 1100;
    P.a1 = 0;
    const form = FORM_TINT[e.f];
    let n = 0;
    for (let i = 0; i < px.length; i += 3 * stride) {
      const wx = x + (px[i] + 0.5 - 16) * sc;
      const wy = y + (px[i + 1] + 0.5 - 19.84) * sc;
      const ang = Math.atan2(wy - (y - 2), wx - x) / (Math.PI / 180);
      P.angMin = P.angMax = ang;
      P.frame = 'p1';
      P.seq = null;
      if (e.r === 'z') {
        // Puxados para a borda da zona, de #ff5fd2 a #2a0840.
        const a = Math.atan2(wy - z.y, wx - z.x);
        P.mt = true;
        P.tx = z.x + Math.cos(a) * z.r;
        P.ty = z.y + Math.sin(a) * z.r;
        P.c0 = FXC.magenta;
        P.c1 = FXC.zoneDark;
      } else {
        P.mt = false;
        P.c0 = px[i + 2];
        P.c1 = -1;
      }
      fx.emit(fx.pixels, 1, wx, wy, mine, true);
      if (++n % 5 === 0) {
        const c0 = P.c0;
        const c1 = P.c1;
        const mt = P.mt;
        P.frame = 'plus';
        P.c0 = form;
        P.c1 = -1;
        P.mt = false;
        fx.emit(fx.spark, 1, wx, wy, mine, true);
        P.c0 = c0;
        P.c1 = c1;
        P.mt = mt;
      }
    }
  }

  private takeSoul(key: string): Phaser.GameObjects.Image | null {
    for (let i = 0; i < 3; i++) {
      if (this.soulBusy[i]) continue;
      this.soulBusy[i] = true;
      return this.souls[i].setTexture(key).setVisible(true).setAlpha(0.6).setTint(FXC.lilac).setTintMode(Phaser.TintModes.FILL);
    }
    return null;
  }

  private freeSoul(img: Phaser.GameObjects.Image | null): null {
    if (!img) return null;
    const i = this.souls.indexOf(img);
    if (i >= 0) this.soulBusy[i] = false;
    img.setVisible(false);
    return null;
  }

  private updateDeath(d: Death, now: number): void {
    const h = this.host;
    const fx = h.fx;
    const el = now - d.t0;
    if (d.r === 'd') {
      if (d.column) d.column.setAlpha(0.8 * Math.max(0, 1 - el / 500));
      if (el >= 500) {
        d.column = fx.freeImage(d.column);
        d.on = false;
      }
      return;
    }
    if (!d.exploded && el >= 180) {
      d.exploded = true;
      this.explode(d, d.x, d.y, d.sc, d.mine);
    }
    if (!d.circled && el >= 250) {
      d.circled = true;
      this.inverse(d.x, d.y + 6, now, d.mine);
    }
    if (d.column) {
      const ce = el - 250;
      if (ce >= 0 && ce < 500) d.column.setPosition(Math.round(d.x), Math.round(d.y + 6)).setAlpha(0.7 * Math.sin((ce / 500) * Math.PI));
      else if (ce >= 500) d.column = fx.freeImage(d.column);
    }
    // Alma: sobe 24 px ondulando; se quem eliminou está na tela, voa até ele.
    const killer = d.by ? h.view(d.by) : undefined;
    if (el >= 300 && !d.soul && !d.absorbed) {
      const key = `sil:${lookKey({ form: d.f, stage: d.s, order: d.o })}`;
      if (!this.scene.textures.exists(key)) this.scene.textures.addCanvas(key, drawCreature({ form: d.f, stage: d.s, order: d.o }, { silhouette: true }));
      d.soul = this.takeSoul(key);
      d.absorbed = !d.soul;
    }
    const soul = d.soul;
    if (soul) {
      const se = el - 300;
      const wob = fx.rm ? 0 : Math.round(Math.sin(se / 120) * 2);
      if (killer && se >= 400) {
        const k = Math.min(1, (se - 400) / 500);
        const sx = d.x;
        const sy = d.y - 12;
        const x = bez(k, sx, (sx + killer.x) / 2, killer.x);
        const y = bez(k, sy, Math.min(sy, killer.y) - 24, killer.y - 2);
        soul.setPosition(Math.round(x), Math.round(y)).setAlpha(0.6).setScale(k > 0.7 ? 0.5 : 1);
        if (k >= 1) {
          const P = fx.reset();
          P.seq = fx.GROW_BIG;
          P.c0 = FXC.magenta;
          P.lifeMin = P.lifeMax = 260;
          P.a1 = 0.2;
          fx.emit(fx.ringAir, 1, killer.x, killer.y - 2, d.mine || d.by === h.focusId(), true);
          d.soul = this.freeSoul(soul);
          d.absorbed = true;
        }
      } else {
        const k = Math.min(1, se / 800);
        const rise = killer ? Math.min(12, (se / 400) * 12) : 24 * k;
        soul.setPosition(Math.round(d.x + wob), Math.round(d.y - rise)).setScale(1).setAlpha(killer ? 0.6 : 0.6 * (1 - k * k));
        if (!killer && k >= 1) {
          d.soul = this.freeSoul(soul);
          d.absorbed = true;
        }
      }
    }
    if (d.absorbed && !d.column && el > 800) d.on = false;
  }

  // ---------------------------------------------------------------- cinza da sua eliminação

  private startGray(now: number): void {
    if (this.host.fx.tier === 2 || this.gray) return;
    try {
      this.gray = this.scene.cameras.main.filters.internal.addColorMatrix();
      this.grayT0 = now;
    } catch {
      this.gray = null;
    }
  }

  private removeGray(): void {
    if (!this.gray) return;
    this.scene.cameras.main.filters.internal.remove(this.gray);
    this.gray = null;
  }

  private updateGray(now: number): void {
    if (!this.gray) return;
    const el = now - this.grayT0;
    // 0→1 em 500 ms, volta em 600 ms aos 2500 ms e sai.
    const k = el < 500 ? el / 500 : el < 2500 ? 1 : Math.max(0, 1 - (el - 2500) / 600);
    this.gray.colorMatrix.reset().saturate(-k);
    if (el >= 3100) this.removeGray();
  }

  update(now: number, delta: number): void {
    for (const c of this.circles) if (c.on) this.updateCircle(c, now);
    for (const o of this.orbs) if (o.on) this.updateOrb(o, now, delta);
    for (const d of this.deaths) if (d.on) this.updateDeath(d, now);
    this.updateGray(now);
  }
}

const SIL_FULL = [600] as const;
const SIL_SHORT = [330] as const;
const WHITE_180 = [180] as const;
const RED_PAL: readonly number[] = [FXC.red, 0xffafe8];
