import Phaser from 'phaser';
import { BALANCE, ELEMS, type Elem, type FxEvent } from '@vb/shared';
import { dotEllipse, flash, nudge, squash, type EntView, type FxHost } from './fx';
import { ELEM_FRAME, ELEM_RAMP, FXC, PRISM } from './fxpalette';
import { TILE } from './map';

/**
 * Bichos vivos: passos com salto e squash, pegadas e rastro elemental,
 * comer selvagem (sucção e nhac), selvagem que foge e o portal de surgimento.
 */

type Eat = Extract<FxEvent, { k: 'c' }>;
type Spawn = Extract<FxEvent, { k: 'w' }>;

interface EatSlot {
  on: boolean;
  t0: number;
  w: EntView | null;
  p: number;
  e: Elem;
  x2: boolean;
  hp0: number;
  wx: number;
  wy: number;
  nhac: boolean;
  icons: (Phaser.GameObjects.Image | null)[];
}

interface Portal {
  on: boolean;
  t0: number;
  x: number;
  y: number;
  e: Elem;
}

const CI = Phaser.Math.Easing.Cubic.In;
const WHITE_120 = [120] as const;
/** distância em px da origem do sprite (0,62) até os pés */
const FEET = 7;
const LOD_TILES = 6;

export class Critters {
  private eats: EatSlot[] = [];
  private portals: Portal[] = [];
  private pending = new Map<number, number>();
  private readonly RIPPLE: Phaser.Textures.Frame[];

  constructor(private host: FxHost) {
    this.RIPPLE = [host.fx.frame('ring3'), host.fx.frame('ring5')];
    for (let i = 0; i < 4; i++) {
      this.eats.push({ on: false, t0: 0, w: null, p: 0, e: 'brasa', x2: false, hp0: 0, wx: 0, wy: 0, nhac: false, icons: [null, null] });
      this.portals.push({ on: false, t0: 0, x: 0, y: 0, e: 'brasa' });
    }
  }

  clear(): void {
    const fx = this.host.fx;
    for (const s of this.eats) {
      s.on = false;
      s.w = null;
      s.icons[0] = fx.freeImage(s.icons[0]);
      s.icons[1] = fx.freeImage(s.icons[1]);
    }
    for (const p of this.portals) p.on = false;
    this.pending.clear();
  }

  // ---------------------------------------------------------------- passos

  /** Salto por passo, squash quantizado em 1/16, virada e respiração parado. */
  animate(v: EntView, now: number, frozen: boolean): void {
    const e = v.data;
    const rm = this.host.fx.rm;
    if (v.img.flipX !== v.dir > 0) v.img.setFlipX(v.dir > 0);
    // Portal: sobe dos pés com scaleY 0→1 em 3 degraus e alpha 0→1 em 250 ms.
    const pe = now - v.portalT0;
    if (pe >= 0 && pe < 250) {
      const k = Math.ceil((pe / 250) * 3) / 3;
      v.fxSy = k;
      v.fxY = FEET * v.base * (1 - k);
      v.alpha = pe / 250;
    } else if (v.portalT0 > 0) {
      v.portalT0 = 0;
      v.fxSy = 1;
      v.fxY = 0;
      v.alpha = 1;
    }
    if (frozen) return;
    const ms = e.k === 'w' ? BALANCE.wildStepMs : BALANCE.stepMs;
    const se = now - v.stepAt;
    let sx = 1;
    let sy = 1;
    let hop = 0;
    if (se >= 0 && se < ms) {
      const t = se / ms;
      hop = -(rm || e.k === 'w' ? 1 : 2) * Math.sin(Math.PI * t);
      if (!rm) {
        if (t < 0.2) {
          sx = 1.12;
          sy = 0.88;
        } else if (t < 0.8) {
          sx = 0.94;
          sy = 1.08;
        } else {
          sx = 1.1;
          sy = 0.9;
        }
      }
    } else if (!rm && se >= ms && se < ms + 60) {
      const k = (se - ms) / 60;
      sx = 1.1 - 0.1 * k;
      sy = 0.9 + 0.1 * k;
    } else if (!rm) {
      // Respiração: sy 1↔1,04 em 1,3 s (quantizada em 1/32).
      sy = 1 + 0.02 * (1 - Math.cos(((now + e.id * 97) / 1300) * Math.PI * 2));
      v.wsx = 1;
      v.wsy = Math.round(sy * 32) / 32;
      v.hop = 0;
      return;
    }
    v.wsx = Math.round(sx * 16) / 16;
    v.wsy = Math.round(sy * 16) / 16;
    v.hop = Math.round(hop);
  }

  /** O tile mudou: pegadas no tile de onde saiu e rastro da forma. */
  step(v: EntView, fromX: number, fromY: number, now: number, focus: EntView | undefined): void {
    v.stepN++;
    const h = this.host;
    const fx = h.fx;
    const e = v.data;
    const mine = e.id === h.focusId();
    // Nível de detalhe: alto, todos na câmera; médio, até 6 tiles de você; baixo, só você.
    if (!mine) {
      if (fx.tier === 2 || fx.rm) return;
      if (fx.tier === 1 && (!focus || Math.abs(focus.data.x - e.x) > LOD_TILES || Math.abs(focus.data.y - e.y) > LOD_TILES)) return;
    }
    const x = (fromX + 0.5) * TILE;
    const y = (fromY + 0.5) * TILE + 7;
    if (!mine && !fx.view.contains(x, y)) return;
    const half = e.s === 0 ? 0.5 : 1;
    const b = h.biomeAt(fromX, fromY);
    let P = fx.reset();
    if (b === 0) {
      P.frame = 'ash';
      P.c0 = FXC.ash;
      P.spMax = 8;
      P.lifeMin = P.lifeMax = 350;
      fx.emit(fx.ground, 2 * half, x, y, mine, false, 0.5);
      P = fx.reset();
      P.c0 = FXC.ember;
      P.vy = -8;
      P.lifeMin = P.lifeMax = 350;
      fx.emit(fx.spark, 1 * half, x, y, mine, false, 0.5);
    } else if (b === 1) {
      P.c0 = ELEM_RAMP.mare[0];
      P.spMin = 18;
      P.spMax = 26;
      P.angMin = 220;
      P.angMax = 320;
      P.ay = 120;
      P.lifeMin = P.lifeMax = 300;
      fx.emit(fx.ground, 3 * half, x, y, mine, false, 0.5);
      P = fx.reset();
      P.seq = this.RIPPLE;
      P.c0 = FXC.blue;
      P.a0 = 0.6;
      P.lifeMin = P.lifeMax = 250;
      fx.emit(fx.ring, 1, x, y, mine, true, 0.5);
    } else if (b === 2) {
      P.frame = 'p12';
      P.pal = BLADES;
      P.spMin = P.spMax = 12;
      P.angMin = 200;
      P.angMax = 340;
      P.ay = 80;
      P.lifeMin = P.lifeMax = 300;
      fx.emit(fx.ground, 2 * half, x, y, mine, false, 0.5);
    }
    if (e.s >= 1) this.trail(v, mine);
  }

  /** Rastro da forma: 1, 2 ou 3 partículas por passo (filhote, adulto, final). */
  private trail(v: EntView, mine: boolean): void {
    const fx = this.host.fx;
    const e = v.data;
    const n = e.s;
    const x = v.x;
    const y = v.y;
    const P = fx.reset();
    P.jit = 3;
    switch (e.f) {
      case 'brasa': {
        const r = ELEM_RAMP.brasa;
        P.c0 = r[0];
        P.c1 = r[1];
        P.c2 = r[2];
        P.frame = v.stepN & 1 ? 'p1' : 'p2';
        P.vy = -20;
        P.lifeMin = 300;
        P.lifeMax = 500;
        fx.emit(fx.spark, n, x, y, mine, false, 0.65);
        return;
      }
      case 'mare':
        P.frame = 'drop';
        P.c0 = ELEM_RAMP.mare[0];
        P.ay = 100;
        P.lifeMin = P.lifeMax = 350;
        fx.emit(fx.pixels, n, x, y, mine, false, 0.65);
        if (v.stepN & 1) this.bubble(x, y - 2, ELEM_RAMP.mare[0], mine);
        return;
      case 'broto':
        P.frame = 'leaf';
        P.pal = ELEM_RAMP.broto;
        P.vx = v.dir > 0 ? -14 : 14;
        P.vy = 16;
        P.spin = 120;
        P.lifeMin = P.lifeMax = 600;
        fx.emit(fx.pixels, n, x, y - 4, mine, false, 0.65);
        P.frame = 'p1';
        P.pal = null;
        P.spin = 0;
        P.c0 = FXC.sun;
        P.vx = 0;
        P.vy = -6;
        fx.emit(fx.spark, 1, x, y - 4, mine, false, 0.65);
        return;
      case 'vapor':
        P.frame = 'p1';
        P.c0 = FXC.white;
        P.c1 = FXC.vapor;
        P.s0 = 1;
        P.s1 = 3;
        P.a0 = 0.8;
        P.vy = -8;
        P.lifeMin = P.lifeMax = 450;
        fx.emit(fx.pixels, 2 * n, x, y, mine, false, 0.65);
        return;
      case 'cinza':
        P.frame = 'ash';
        P.c0 = FXC.ash;
        P.ay = 20;
        P.lifeMin = P.lifeMax = 600;
        fx.emit(fx.pixels, n, x, y - 4, mine, false, 0.65);
        P.frame = 'p1';
        P.c0 = FXC.ember;
        P.c1 = ELEM_RAMP.brasa[1];
        P.ay = 0;
        P.vy = -18;
        P.lifeMin = P.lifeMax = 400;
        fx.emit(fx.spark, 1, x, y - 4, mine, false, 0.65);
        return;
      case 'mangue':
        this.bubble(x, y - 2, FXC.mud, mine);
        P.frame = 'leaf';
        P.c0 = 0x17803a;
        P.vx = v.dir > 0 ? -12 : 12;
        P.vy = 14;
        P.spin = 120;
        P.lifeMin = P.lifeMax = 550;
        fx.emit(fx.pixels, n, x, y - 4, mine, false, 0.65);
        return;
      case 'quimera':
        P.pal = PRISM;
        P.vy = -10;
        P.lifeMin = P.lifeMax = 450;
        fx.emit(fx.spark, 2 * n, x, y - 2, mine, false, 0.65);
        return;
      default:
        return;
    }
  }

  /** Bolha que sobe 8 px e estoura em 3 p1. */
  private bubble(x: number, y: number, color: number, mine: boolean): void {
    const fx = this.host.fx;
    let P = fx.reset();
    P.frame = 'bubble';
    P.c0 = color;
    P.vy = -20;
    P.a0 = 0.9;
    P.a1 = 0.7;
    P.lifeMin = P.lifeMax = 400;
    if (!fx.emit(fx.pixels, 1, x, y, mine, true, 0.65)) return;
    P = fx.reset();
    P.c0 = color;
    P.spMin = 15;
    P.spMax = 25;
    P.delayMin = P.delay = 400;
    P.lifeMin = P.lifeMax = 200;
    fx.emit(fx.pixels, 3, x, y - 8, mine, true, 0.65);
  }

  // ---------------------------------------------------------------- comer

  /** 'c': o selvagem pisca branco, é sugado até a boca e o jogador faz nhac. */
  eat(ev: Eat, now: number): void {
    const h = this.host;
    const fx = h.fx;
    const w = h.view(ev.w);
    const p = h.view(ev.p);
    let s: EatSlot | null = null;
    for (const k of this.eats) if (!k.on) s ??= k;
    const mine = ev.p === h.focusId();
    const wx = w ? w.x : (ev.x + 0.5) * TILE;
    const wy = w ? w.y : (ev.y + 0.5) * TILE;
    if (w) {
      w.koUntil = 0;
      w.dieAt = now + 340;
      w.fadeMs = 0;
      flash(w, 0xffffff, WHITE_120, now, false);
    }
    // 14 motes do elemento espiralam até o jogador em 450 ms.
    const r = ELEM_RAMP[ev.e];
    let P = fx.reset();
    P.frame = ELEM_FRAME[ev.e];
    P.c0 = r[0];
    P.c1 = r[1];
    P.c2 = r[2];
    P.rad = 5;
    P.mt = true;
    P.tx = p ? p.x : wx;
    P.ty = p ? p.y - 2 : wy - 16;
    P.sw = 1;
    P.lifeMin = P.lifeMax = 450;
    P.a1 = 0.8;
    fx.emit(fx.magic, 14, wx, wy - 2, mine);
    // 6 migalhas caem.
    P = fx.reset();
    P.c0 = r[1];
    P.pal = r;
    P.spMin = 15;
    P.spMax = 35;
    P.angMin = 200;
    P.angMax = 340;
    P.ay = 150;
    P.lifeMin = P.lifeMax = 400;
    fx.emit(fx.ground, 6, wx, wy, mine);
    if (!s) return;
    s.on = true;
    s.t0 = now;
    s.w = w ?? null;
    s.p = ev.p;
    s.e = ev.e;
    s.x2 = !!ev.x2;
    s.hp0 = p ? p.data.hp : 0;
    s.wx = wx;
    s.wy = wy;
    s.nhac = false;
  }

  private updateEat(s: EatSlot, now: number): void {
    const h = this.host;
    const fx = h.fx;
    const t = now - s.t0;
    const p = h.view(s.p);
    const w = s.w;
    if (w && t < 340) {
      if (t < 120) w.fxX = fx.rm ? 0 : (Math.floor(now / 40) & 1) * 2 - 1;
      else {
        const k = CI((t - 120) / 220);
        const tx = p ? p.x : s.wx;
        const ty = p ? p.y - 2 : s.wy;
        w.fxX = (tx - w.x) * k;
        w.fxY = (ty - w.y) * k;
        w.fxSx = w.fxSy = 1 - k;
      }
    }
    if (!s.nhac && t >= 570) {
      s.nhac = true;
      s.w = null;
      if (p) {
        const mine = s.p === h.focusId();
        squash(p, 1.25, 0.8, 90, 0, 150, now);
        const r = ELEM_RAMP[s.e];
        for (let i = 0; i < (s.x2 ? 2 : 1); i++) {
          s.icons[i] = fx.takeImage(ELEM_FRAME[s.e])?.setTint(r[1]).setScale(2) ?? null;
        }
        // XP e cura no mesmo alvo: o segundo número empilha 7 px acima.
        const heal = Math.round(p.data.hp - s.hp0);
        if (heal > 0) fx.number('g', `+${heal}`, p.x - 10, p.y - 2, 1, -1, s.p, now);
        fx.number(s.x2 ? 'y' : 'g', s.x2 ? '+2' : '+1', p.x + 9, p.y - 2, 1, 1, s.p, now);
        const P = fx.reset();
        P.seq = this.RIPPLE;
        P.c0 = r[1];
        P.lifeMin = P.lifeMax = 220;
        P.a1 = 0.3;
        fx.emit(fx.ringAir, 1, p.x, p.y - 2, mine, true);
      }
    }
    // Ícone do tipo sobe 10 px em 500 ms.
    if (s.nhac) {
      const k = (t - 570) / 500;
      const px = p ? p.x : s.wx;
      const py = p ? p.y : s.wy;
      for (let i = 0; i < 2; i++) {
        const ic = s.icons[i];
        if (!ic) continue;
        if (k >= 1) s.icons[i] = fx.freeImage(ic);
        else ic.setPosition(Math.round(px + (s.x2 ? (i ? 4 : -4) : 0)), Math.round(py - 18 - 10 * k)).setAlpha(k > 0.7 ? (1 - k) / 0.3 : 1);
      }
      if (k >= 1) s.on = false;
    }
  }

  /** Selvagem que some em batalha sem 'c' nem 'x' (fugiu): poeira e desliza para longe. */
  fled(v: EntView, from: EntView | undefined, now: number): void {
    const fx = this.host.fx;
    const P = fx.reset();
    P.c0 = FXC.dust;
    P.spMin = 10;
    P.spMax = 30;
    P.angMin = 180;
    P.angMax = 360;
    P.lifeMin = P.lifeMax = 350;
    fx.emit(fx.ground, 6, v.x, v.y + 6, false, true);
    const dx = from ? v.x - from.x : 1;
    const dy = from ? v.y - from.y : 0;
    const len = Math.hypot(dx, dy) || 1;
    nudge(v, Math.round((dx / len) * 6), Math.round((dy / len) * 6), 150, 1000, now);
    v.dieAt = now + 150;
    v.fadeMs = 150;
  }

  // ---------------------------------------------------------------- portal

  /** 'w': guarda o surgimento para a EntView que nasce neste snapshot. */
  spawn(ev: Spawn, now: number): void {
    this.pending.set(ev.id, ELEMS.indexOf(ev.e));
    let p: Portal | null = null;
    for (const k of this.portals) if (!k.on) p ??= k;
    if (!p) return;
    p.on = true;
    p.t0 = now;
    p.x = (ev.x + 0.5) * TILE;
    p.y = (ev.y + 0.5) * TILE + 6;
    p.e = ev.e;
    const fx = this.host.fx;
    const r = ELEM_RAMP[ev.e];
    let P = fx.reset();
    P.c0 = r[0];
    P.jit = 4;
    P.vy = -22;
    P.lifeMin = P.lifeMax = 500;
    P.delay = 150;
    fx.emit(fx.spark, 6, p.x, p.y - 2, false);
    P = fx.reset();
    if (ev.e === 'brasa') {
      P.c0 = FXC.ember;
      P.c1 = r[1];
      P.spMin = 15;
      P.spMax = 30;
      P.angMin = 240;
      P.angMax = 300;
      P.lifeMin = P.lifeMax = 450;
      fx.emit(fx.spark, 4, p.x, p.y, false);
    } else if (ev.e === 'broto') {
      P.frame = 'leaf';
      P.pal = r;
      P.spMin = 20;
      P.spMax = 35;
      P.angMin = 230;
      P.angMax = 310;
      P.ay = 90;
      P.spin = 120;
      P.lifeMin = P.lifeMax = 600;
      fx.emit(fx.pixels, 3, p.x, p.y, false);
    }
  }

  /** Nova EntView: se veio de um portal, sobe dele em vez do fade. */
  intro(v: EntView, now: number): boolean {
    if (!this.pending.delete(v.data.id)) return false;
    v.portalT0 = now;
    v.alpha = 0;
    v.fxSy = 0;
    return true;
  }

  private updatePortal(p: Portal, now: number): void {
    const h = this.host;
    const t = now - p.t0;
    if (t >= 600) {
      p.on = false;
      return;
    }
    const rx = t < 150 ? (7 * t) / 150 : t < 400 ? 7 : 7 * (1 - (t - 400) / 200);
    const body = ELEM_RAMP[p.e][1];
    dotEllipse(h, p.x, p.y, rx, (rx * 3) / 7, 18, 0, body, 1);
    if (p.e === 'brasa' && t < 400 && h.groundBudget + 2 <= 220) {
      // Rachadura em cruz.
      h.groundBudget += 2;
      h.groundG.fillStyle(ELEM_RAMP.brasa[2], 1);
      h.groundG.fillRect(Math.round(p.x) - 3, Math.round(p.y), 7, 1);
      h.groundG.fillRect(Math.round(p.x), Math.round(p.y) - 1, 1, 3);
    } else if (p.e === 'mare' && t < 500) {
      for (let i = 0; i < 2; i++) {
        const k = (t - i * 100) / 400;
        if (k < 0 || k >= 1) continue;
        const r = 3 + 7 * k;
        dotEllipse(h, p.x, p.y, r, r * 0.4, 20, 0, FXC.blue, 1 - k);
      }
    }
  }

  update(now: number): void {
    for (const s of this.eats) if (s.on) this.updateEat(s, now);
    for (const p of this.portals) if (p.on) this.updatePortal(p, now);
    if (this.pending.size > 8) this.pending.clear();
  }
}

const BLADES: readonly number[] = [FXC.grass, 0x17803a];
