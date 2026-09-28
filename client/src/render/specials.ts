import Phaser from 'phaser';
import { FX_IMPACT_MS, type FxEvent, type SpecialKind } from '@vb/shared';
import { dotEllipse, flash, nudge, squash, type EntView, type FxHost } from './fx';
import { FXC } from './fxpalette';
import { TILE } from './map';

/**
 * Especiais no mundo (FxEvent 'h' com sp), no relógio único do golpe (FX_IMPACT_MS):
 * Golpe Brutal (investida e corte em X vermelho, chão rachado e tremor forte),
 * Explosão Arcana (orbe com runas em órbita, raio roxo e explosão com círculo de runas)
 * e Armadilha (semente lançada, espinhos que brotam e rede que prende o alvo).
 * O dano, o número e o lampejo do alvo continuam com as Spells.
 */

type Hit = Extract<FxEvent, { k: 'h' }>;

const RUNE_FRAMES = ['rune0', 'rune1', 'rune2', 'rune3'] as const;
const TAU = Math.PI * 2;
const QO = Phaser.Math.Easing.Quadratic.Out;
const SI = Phaser.Math.Easing.Sine.In;
const bez = Phaser.Math.Interpolation.QuadraticBezier;

const RED_PAL: readonly number[] = [FXC.red, 0xff6b5e, FXC.white];
const ARC_PAL: readonly number[] = [FXC.lilac, FXC.magenta, FXC.white, FXC.pink];
const LEAF_PAL: readonly number[] = [0x58e07a, 0x17803a, 0xd2f7b8];
const STONE_PAL: readonly number[] = [FXC.stone, FXC.slate, FXC.red];
const DASH_MS = 420;
const ORB_GO = 380;
const SEED_LAND = 380;
const HOLD_MS = 800;
const SPIKES = 8;
const RED_60 = [60] as const;

interface Cast {
  on: boolean;
  t0: number;
  sp: SpecialKind;
  a: number;
  d: number;
  ex: number;
  ey: number;
  mine: boolean;
  /** direção atacante → alvo */
  nx: number;
  ny: number;
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  acc: number;
  dashed: boolean;
  landed: boolean;
  impacted: boolean;
  /** orbe/semente, 4 runas e a rede */
  head: Phaser.GameObjects.Image | null;
  runes: (Phaser.GameObjects.Image | null)[];
  net: Phaser.GameObjects.Image | null;
}

const newCast = (): Cast => ({
  on: false,
  t0: 0,
  sp: 'brutal',
  a: 0,
  d: 0,
  ex: 0,
  ey: 0,
  mine: false,
  nx: 1,
  ny: 0,
  ax: 0,
  ay: 0,
  dx: 0,
  dy: 0,
  acc: 0,
  dashed: false,
  landed: false,
  impacted: false,
  head: null,
  runes: [null, null, null, null],
  net: null,
});

/** Rede 21×15 em losangos com nós claros (máscara elíptica). */
function netCanvas(): HTMLCanvasElement {
  const w = 21;
  const hh = 15;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hh;
  const ctx = c.getContext('2d')!;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const ex = (x + 0.5 - w / 2) / (w / 2);
      const ey = (y + 0.5 - hh / 2) / (hh / 2);
      if (ex * ex + ey * ey > 1) continue;
      const a = (x + y) % 4 === 0;
      const b = (((x - y) % 4) + 4) % 4 === 0;
      if (!a && !b) continue;
      ctx.fillStyle = a && b ? '#ffffff' : ex * ex + ey * ey > 0.7 ? '#58e07a' : '#b6f28a';
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

export class Specials {
  private casts: Cast[] = [];

  constructor(
    scene: Phaser.Scene,
    private host: FxHost,
  ) {
    if (!scene.textures.exists('spnet')) scene.textures.addCanvas('spnet', netCanvas());
    for (let i = 0; i < 4; i++) this.casts.push(newCast());
  }

  clear(): void {
    for (const c of this.casts) if (c.on) this.release(c);
  }

  /** EntView de quem luta; o ovo de quem já renasceu com o mesmo id não conta. */
  private live(id: number): EntView | undefined {
    const v = this.host.view(id);
    return v && !v.egg ? v : undefined;
  }

  private release(c: Cast): void {
    const fx = this.host.fx;
    c.head = fx.freeImage(c.head);
    for (let i = 0; i < 4; i++) c.runes[i] = fx.freeImage(c.runes[i]);
    c.net = fx.freeImage(c.net);
    const dv = this.live(c.d);
    if (dv && c.sp === 'armadilha') dv.fxX = 0;
    c.on = false;
  }

  /** Posições do atacante e do alvo (ou do evento). */
  private track(c: Cast): { av: EntView | undefined; dv: EntView | undefined } {
    const av = this.live(c.a);
    const dv = this.live(c.d);
    c.ax = av ? av.x : c.ex - 8;
    c.ay = av ? av.y - 2 : c.ey;
    c.dx = dv ? dv.x : c.ex + 8;
    c.dy = dv ? dv.y - 2 : c.ey;
    return { av, dv };
  }

  cast(e: Hit, now: number): void {
    const sp = e.sp;
    if (!sp) return;
    const h = this.host;
    const fx = h.fx;
    let c: Cast | null = null;
    let oldest: Cast | null = null;
    for (const k of this.casts) {
      if (!k.on) c ??= k;
      else if (!oldest || k.t0 < oldest.t0) oldest = k;
    }
    if (!c && oldest) {
      this.release(oldest);
      c = oldest;
    }
    if (!c) return;
    const focus = h.focusId();
    c.on = true;
    c.t0 = now;
    c.sp = sp;
    c.a = e.a;
    c.d = e.d;
    c.ex = (e.x + 0.5) * TILE;
    c.ey = (e.y + 0.5) * TILE;
    c.mine = e.a === focus || e.d === focus;
    c.acc = 0;
    c.dashed = c.landed = c.impacted = false;
    const { av } = this.track(c);
    const len = Math.hypot(c.dx - c.ax, c.dy - c.ay) || 1;
    c.nx = (c.dx - c.ax) / len;
    c.ny = (c.dy - c.ay) / len;
    if (sp === 'brutal') {
      // Preparo: estica, recua 4 px e a fúria vermelha converge no atacante.
      if (av && !fx.rm) {
        squash(av, 0.8, 1.22, 150, 200, 80, now);
        nudge(av, Math.round(-c.nx * 4), Math.round(-c.ny * 4), 120, 260, now);
      }
      const P = fx.reset();
      P.rad = 13;
      P.mt = true;
      P.tx = c.ax;
      P.ty = c.ay;
      P.pal = RED_PAL;
      P.frame = 'p2';
      P.lifeMin = P.lifeMax = 300;
      P.a1 = 0.6;
      fx.emit(fx.magic, 10, c.ax, c.ay, c.mine);
    } else if (sp === 'arcana') {
      c.head = fx.takeImage('orb')?.setTint(FXC.lilac).setBlendMode(Phaser.BlendModes.ADD).setVisible(false) ?? null;
      for (let i = 0; i < 4; i++) c.runes[i] = fx.takeImage(RUNE_FRAMES[i])?.setTint(i & 1 ? FXC.pink : FXC.lilac).setBlendMode(Phaser.BlendModes.ADD).setVisible(false) ?? null;
      if (av && !fx.rm) squash(av, 0.9, 1.12, 120, 280, 120, now);
    } else {
      c.head = fx.takeImage('orb')?.setTint(0x9be36b).setVisible(false) ?? null;
      if (av && !fx.rm) nudge(av, Math.round(-c.nx * 2), Math.round(-c.ny * 2), 80, 120, now);
    }
  }

  update(now: number, delta: number): void {
    for (const c of this.casts) {
      if (!c.on) continue;
      const el = now - c.t0;
      const views = this.track(c);
      if (c.sp === 'brutal') this.brutal(c, el, now, delta, views.av, views.dv);
      else if (c.sp === 'arcana') this.arcana(c, el, now, delta, views.dv);
      else this.trap(c, el, now, delta, views.dv);
    }
  }

  // ---------------------------------------------------------------- Golpe Brutal

  private brutal(c: Cast, el: number, now: number, delta: number, av: EntView | undefined, dv: EntView | undefined): void {
    const h = this.host;
    const fx = h.fx;
    const g = h.airG;
    // Fúria subindo do atacante até a investida.
    if (el < FX_IMPACT_MS && !fx.rm) {
      c.acc += delta;
      while (c.acc >= 60) {
        c.acc -= 60;
        const P = fx.reset();
        P.frame = 'p1';
        P.pal = RED_PAL;
        P.jit = 5;
        P.vy = -34;
        P.lifeMin = P.lifeMax = 320;
        fx.emit(fx.spark, 1, c.ax, c.ay + 2, c.mine, true, 0.8);
      }
    }
    if (!c.dashed && el >= DASH_MS) {
      c.dashed = true;
      if (av && !fx.rm) nudge(av, Math.round(c.nx * 9), Math.round(c.ny * 9), 150, 240, now);
    }
    // Linhas de velocidade atrás do atacante na investida.
    if (el >= DASH_MS + 40 && el < FX_IMPACT_MS && !fx.rm) {
      g.fillStyle(FXC.white, 0.7);
      for (let i = -1; i <= 1; i++) {
        const px = c.ax - c.nx * (8 + Math.abs(i) * 3) - c.ny * i * 4;
        const py = c.ay - c.ny * (8 + Math.abs(i) * 3) + c.nx * i * 4;
        for (let k = 0; k < 5; k++) g.fillRect(Math.round(px - c.nx * k), Math.round(py - c.ny * k), 1, 1);
      }
    }
    if (!c.impacted && el >= FX_IMPACT_MS) {
      c.impacted = true;
      this.brutalImpact(c, now, dv);
    }
    const ie = el - FX_IMPACT_MS;
    if (ie >= 0) {
      // Corte em X: cada risco varre em 60 ms, segura 110 ms e afina até sumir.
      this.slash(g, c.dx, c.dy, -1, ie);
      this.slash(g, c.dx, c.dy, 1, ie - 50);
      // Depois do branco das Spells, o alvo pisca vermelho.
      if (!c.landed && ie >= 130) {
        c.landed = true;
        if (dv) flash(dv, FXC.red, RED_60, now, fx.rm);
      }
      // Chão rachado e onda de choque
      const fy = c.dy + 9;
      if (ie < 520) this.cracks(c.dx, fy, 1 - ie / 520);
      if (ie < 360) {
        const k = ie / 360;
        dotEllipse(h, c.dx, fy, 4 + 26 * QO(k), (4 + 26 * QO(k)) * 0.4, 40, 0, FXC.red, 1 - k);
      }
    }
    if (el >= FX_IMPACT_MS + 600) this.release(c);
  }

  /** Um risco do X: da esquerda-alto para a direita-baixo (dir -1) ou o contrário (dir 1). */
  private slash(g: Phaser.GameObjects.Graphics, cx: number, cy: number, dir: number, e: number): void {
    if (e < 0 || e >= 310) return;
    const R = 17;
    const x0 = cx + dir * R;
    const y0 = cy - R;
    const x1 = cx - dir * R;
    const y1 = cy + R;
    // Normal da corda (curva o risco para fora)
    const nx = dir * 0.707;
    const ny = 0.707;
    const reveal = Math.min(1, e / 60);
    const thin = e < 170 ? 0 : (e - 170) / 140;
    const N = 22;
    const last = Math.round(N * reveal);
    for (let i = 0; i <= last; i++) {
      const t = i / N;
      const bulge = 5 * Math.sin(Math.PI * t);
      const x = Math.round(x0 + (x1 - x0) * t + nx * bulge);
      const y = Math.round(y0 + (y1 - y0) * t + ny * bulge);
      const w = Math.max(0, Math.round((1 + 3 * Math.sin(Math.PI * t)) * (1 - thin)));
      if (w <= 0) continue;
      g.fillStyle(FXC.red, 1);
      g.fillRect(x - (w >> 1) - 1, y - (w >> 1), w + 2, w);
      if (w >= 2) {
        g.fillStyle(FXC.white, 1);
        g.fillRect(x - (w >> 1), y - (w >> 1), w, Math.max(1, w - 1));
      }
    }
  }

  /** Rachaduras no chão: 6 raios em zigue-zague de 3 segmentos. */
  private cracks(x: number, y: number, alpha: number): void {
    const h = this.host;
    if (h.groundBudget + 36 > 220) return;
    h.groundBudget += 36;
    const g = h.groundG;
    g.fillStyle(0x5a1020, alpha);
    for (let r = 0; r < 6; r++) {
      const a = (r / 6) * TAU + 0.4;
      for (let k = 2; k < 14; k += 2) {
        const off = ((r * 7 + k) % 3) - 1;
        g.fillRect(Math.round(x + Math.cos(a) * k + off), Math.round(y + Math.sin(a) * k * 0.4), 2, 1);
      }
    }
  }

  private brutalImpact(c: Cast, now: number, dv: EntView | undefined): void {
    const h = this.host;
    const fx = h.fx;
    let P = fx.reset();
    P.frame = 'star';
    P.pal = RED_PAL;
    P.spMin = 70;
    P.spMax = 150;
    P.lifeMin = 220;
    P.lifeMax = 320;
    P.a1 = 0.4;
    fx.emit(fx.spark, 12, c.dx, c.dy, c.mine);
    // Pedras do chão voando
    P = fx.reset();
    P.frame = 'shard';
    P.pal = STONE_PAL;
    P.spMin = 50;
    P.spMax = 110;
    P.angMin = 200;
    P.angMax = 340;
    P.ay = 320;
    P.lifeMin = 450;
    P.lifeMax = 600;
    fx.emit(fx.pixels, 12, c.dx, c.dy + 8, c.mine);
    P = fx.reset();
    P.seq = fx.GROW_BIG;
    P.c0 = FXC.red;
    P.lifeMin = P.lifeMax = 260;
    P.a1 = 0.3;
    fx.emit(fx.ringAir, 1, c.dx, c.dy, c.mine, true);
    if (dv) {
      dv.freezeUntil = Math.max(dv.freezeUntil, now + 200);
      if (!fx.rm) {
        squash(dv, 1.25, 0.75, 60, 140, 160, now);
        nudge(dv, Math.round(c.nx * 6), Math.round(c.ny * 6), 60, 240, now + 200, true);
      }
    }
    this.shake(c, 0.9, 0.09, 0.45);
    if (c.mine) fx.screenFlash(FXC.red, 0.22, 140, now);
  }

  // ---------------------------------------------------------------- Explosão Arcana

  private arcana(c: Cast, el: number, now: number, delta: number, dv: EntView | undefined): void {
    const h = this.host;
    const fx = h.fx;
    const g = h.airG;
    const ox = c.ax;
    const oy = c.ay - 14;
    const orb = c.head;
    const spin = fx.rm ? 0.6 : (el / 450) * TAU;
    if (el < ORB_GO) {
      // O orbe cresce acima da cabeça, as runas acendem em órbita e a energia converge nele.
      orb?.setVisible(true).setScale(el < 180 ? 1 : 2).setPosition(Math.round(ox), Math.round(oy));
      for (let i = 0; i < 4; i++) {
        const r = c.runes[i];
        if (!r) continue;
        const a = spin + (i / 4) * TAU;
        r.setVisible(el >= i * 70).setPosition(Math.round(ox + Math.cos(a) * 10), Math.round(oy + Math.sin(a) * 5));
      }
      c.acc += delta;
      while (c.acc >= 50) {
        c.acc -= 50;
        const P = fx.reset();
        P.rad = 14;
        P.mt = true;
        P.tx = ox;
        P.ty = oy;
        P.pal = ARC_PAL;
        P.lifeMin = P.lifeMax = 260;
        P.a1 = 0.7;
        fx.emit(fx.magic, 1, ox, oy, c.mine, true, 0.8);
      }
    } else if (el < FX_IMPACT_MS) {
      // Dispara: o orbe corre até o alvo puxando o raio roxo.
      const k = SI((el - ORB_GO) / (FX_IMPACT_MS - ORB_GO));
      const hx = ox + (c.dx - ox) * k;
      const hy = oy + (c.dy - oy) * k;
      orb?.setVisible(true).setScale(2).setPosition(Math.round(hx), Math.round(hy));
      g.lineStyle(3, FXC.lilac, 0.85);
      g.lineBetween(Math.round(ox), Math.round(oy), Math.round(hx), Math.round(hy));
      g.lineStyle(1, FXC.white, 1);
      g.lineBetween(Math.round(ox), Math.round(oy), Math.round(hx), Math.round(hy));
      for (let i = 0; i < 4; i++) {
        const r = c.runes[i];
        if (!r) continue;
        const a = spin + (i / 4) * TAU;
        r.setPosition(Math.round(hx + Math.cos(a) * 7), Math.round(hy + Math.sin(a) * 4));
      }
    }
    if (!c.impacted && el >= FX_IMPACT_MS) {
      c.impacted = true;
      orb?.setVisible(false);
      this.arcanaImpact(c, now, dv);
    }
    const ie = el - FX_IMPACT_MS;
    if (ie >= 0 && ie < 140) {
      // O raio fica aceso um instante e afina; 8 raios curtos saem do alvo.
      const w = ie < 70 ? 3 : 1;
      g.lineStyle(w, FXC.lilac, 1 - ie / 140);
      g.lineBetween(Math.round(ox), Math.round(oy), Math.round(c.dx), Math.round(c.dy));
      if (ie < 70) {
        g.lineStyle(1, FXC.white, 1);
        g.lineBetween(Math.round(ox), Math.round(oy), Math.round(c.dx), Math.round(c.dy));
      }
      g.lineStyle(1, ie < 70 ? FXC.white : FXC.lilac, 1);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + 0.2;
        const r0 = 7;
        const r1 = 13 + (i & 1) * 5;
        g.lineBetween(Math.round(c.dx + Math.cos(a) * r0), Math.round(c.dy + Math.sin(a) * r0), Math.round(c.dx + Math.cos(a) * r1), Math.round(c.dy + Math.sin(a) * r1));
      }
    }
    if (ie >= 0) {
      // Dois anéis de pixels se abrindo e o círculo de runas no chão.
      if (ie < 320) {
        const k = QO(ie / 320);
        this.circle(g, c.dx, c.dy, 4 + 24 * k, FXC.lilac, 1 - ie / 320);
        this.circle(g, c.dx, c.dy, 2 + 14 * k, FXC.pink, 1 - ie / 320);
      }
      const fy = c.dy + 9;
      const alpha = ie < 300 ? 1 : Math.max(0, 1 - (ie - 300) / 250);
      if (ie < 550) {
        dotEllipse(h, c.dx, fy, 14, 5.6, 40, spin * 0.3, FXC.lilac, alpha);
        dotEllipse(h, c.dx, fy, 9, 3.6, 26, -spin * 0.3, FXC.magenta, alpha * 0.8);
      }
      for (let i = 0; i < 4; i++) {
        const r = c.runes[i];
        if (!r) continue;
        const a = spin * 0.3 + (i / 4) * TAU;
        r.setVisible(ie < 550).setPosition(Math.round(c.dx + Math.cos(a) * 14), Math.round(fy + Math.sin(a) * 5.6 - 3)).setAlpha(alpha);
      }
    }
    if (el >= FX_IMPACT_MS + 600) this.release(c);
  }

  private circle(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number, color: number, alpha: number): void {
    const n = Math.max(16, Math.min(48, Math.round(r * 2.4)));
    g.fillStyle(color, alpha);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      g.fillRect(Math.round(x + Math.cos(a) * r), Math.round(y + Math.sin(a) * r), 1, 1);
    }
  }

  private arcanaImpact(c: Cast, now: number, dv: EntView | undefined): void {
    const h = this.host;
    const fx = h.fx;
    let P = fx.reset();
    P.frame = 'diamond';
    P.pal = ARC_PAL;
    P.spMin = 60;
    P.spMax = 130;
    P.lifeMin = 300;
    P.lifeMax = 420;
    P.a1 = 0.3;
    fx.emit(fx.spark, 14, c.dx, c.dy, c.mine);
    P = fx.reset();
    P.frame = 'plus';
    P.pal = ARC_PAL;
    P.spMin = 20;
    P.spMax = 50;
    P.vy = -20;
    P.lifeMin = P.lifeMax = 500;
    fx.emit(fx.magic, 8, c.dx, c.dy, c.mine);
    P = fx.reset();
    P.seq = fx.GROW_BIG;
    P.c0 = FXC.lilac;
    P.lifeMin = P.lifeMax = 280;
    P.a1 = 0.3;
    fx.emit(fx.ringAir, 1, c.dx, c.dy, c.mine, true);
    if (dv && !fx.rm) squash(dv, 0.8, 1.2, 60, 100, 160, now);
    this.shake(c, 0.55, 0.06, 0.3);
    if (c.mine) fx.screenFlash(FXC.lilac, 0.18, 140, now);
  }

  // ---------------------------------------------------------------- Armadilha

  private trap(c: Cast, el: number, now: number, delta: number, dv: EntView | undefined): void {
    const h = this.host;
    const fx = h.fx;
    const fy = c.dy + 8;
    const seed = c.head;
    if (el < SEED_LAND) {
      // Semente em arco até os pés do alvo, soltando pontinhos verdes.
      const k = el / SEED_LAND;
      const x = bez(k, c.ax, (c.ax + c.dx) / 2, c.dx);
      const y = bez(k, c.ay - 4, Math.min(c.ay, fy) - 22, fy);
      seed?.setVisible(true).setPosition(Math.round(x), Math.round(y)).setAngle(fx.rm ? 0 : Math.floor(el / 80) * 90);
      c.acc += delta;
      while (c.acc >= 40) {
        c.acc -= 40;
        const P = fx.reset();
        P.pal = LEAF_PAL;
        P.ay = 40;
        P.lifeMin = P.lifeMax = 260;
        fx.emit(fx.pixels, 1, x, y, c.mine, true, 0.8);
      }
    } else if (!c.landed) {
      c.landed = true;
      seed?.setVisible(false);
      const P = fx.reset();
      P.pal = LEAF_PAL;
      P.spMin = 15;
      P.spMax = 35;
      P.angMin = 200;
      P.angMax = 340;
      P.ay = 160;
      P.lifeMin = P.lifeMax = 320;
      fx.emit(fx.ground, 5, c.dx, fy, c.mine);
    }
    // Espinhos brotando em volta do alvo (os de trás no chão, os da frente por cima do bicho).
    const se = el - SEED_LAND;
    const end = FX_IMPACT_MS + HOLD_MS;
    if (se >= 0 && el < end + 200) {
      const fade = el < end ? 1 : 1 - (el - end) / 200;
      for (let i = 0; i < SPIKES; i++) {
        const a = (i / SPIKES) * TAU + 0.3;
        const grow = fx.rm ? 1 : Math.min(1, Math.max(0, (se - i * 20) / 140));
        const ht = Math.round(8 * grow);
        if (ht <= 0) continue;
        const sx = Math.round(c.dx + Math.cos(a) * 12);
        const sy = Math.round(fy + Math.sin(a) * 4.5);
        this.spike(Math.sin(a) < 0 ? h.groundG : h.airG, sx, sy, ht, fade, Math.sin(a) < 0);
      }
    }
    if (!c.impacted && el >= FX_IMPACT_MS) {
      c.impacted = true;
      this.trapImpact(c, now, dv);
    }
    const ie = el - FX_IMPACT_MS;
    if (ie >= 0) {
      const net = c.net;
      if (net) {
        const drop = fx.rm ? 0 : Math.round(-10 * (1 - Math.min(1, ie / 80)));
        net.setVisible(el < end + 200).setPosition(Math.round(c.dx), Math.round(c.dy + 1 + drop)).setAlpha(el < end ? 1 : 1 - (el - end) / 200);
      }
      // Preso: se debate 1 px de um lado para o outro.
      if (dv) dv.fxX = !fx.rm && el < end ? (Math.floor(ie / 110) & 1) * 2 - 1 : 0;
    }
    if (el >= end + 200) this.release(c);
  }

  /** Estaca pontuda com contorno escuro: ponta branca, corpo verde-claro e base escura (3 px na metade de baixo). */
  private spike(g: Phaser.GameObjects.Graphics, x: number, y: number, ht: number, alpha: number, back: boolean): void {
    const h = this.host;
    if (back) {
      if (h.groundBudget + 7 > 220) return;
      h.groundBudget += 7;
    }
    const half = ht >> 1;
    g.fillStyle(0x0f3a1c, alpha);
    g.fillRect(x - 1, y - ht - 1, 3, ht - half + 1);
    if (ht >= 4) g.fillRect(x - 2, y - half, 5, half + 1);
    g.fillStyle(0xffffff, alpha);
    g.fillRect(x, y - ht, 1, 1);
    g.fillStyle(0x9be36b, alpha);
    g.fillRect(x, y - ht + 1, 1, Math.max(0, ht - 1));
    if (ht >= 4) {
      g.fillRect(x - 1, y - half, 3, half);
      g.fillStyle(0x17803a, alpha);
      g.fillRect(x - 1, y - 1, 3, 1);
    }
  }

  private trapImpact(c: Cast, now: number, dv: EntView | undefined): void {
    const h = this.host;
    const fx = h.fx;
    c.net = fx.takeImage('p1');
    c.net?.setTexture('spnet').setVisible(false);
    let P = fx.reset();
    P.frame = 'leaf';
    P.pal = LEAF_PAL;
    P.spMin = 40;
    P.spMax = 90;
    P.ay = 60;
    P.spin = 90;
    P.lifeMin = 450;
    P.lifeMax = 600;
    fx.emit(fx.pixels, 10, c.dx, c.dy, c.mine);
    P = fx.reset();
    P.frame = 'plus';
    P.pal = LEAF_PAL;
    P.spMin = 30;
    P.spMax = 60;
    P.lifeMin = P.lifeMax = 300;
    fx.emit(fx.spark, 6, c.dx, c.dy, c.mine);
    if (dv) {
      // A rede prende o alvo no lugar.
      dv.freezeUntil = Math.max(dv.freezeUntil, now + HOLD_MS);
      if (!fx.rm) squash(dv, 1.15, 0.85, 50, HOLD_MS - 150, 120, now);
    }
    this.shake(c, 0.45, 0.04, 0.25);
  }

  /** Tremor: forte em quem está na luta, pela distância para quem só assiste. */
  private shake(c: Cast, own: number, punch: number, near: number): void {
    const h = this.host;
    if (c.mine) {
      h.addTrauma(own);
      h.punch(punch, 70, 260);
      return;
    }
    const f = h.view(h.focusId());
    if (!f) return;
    const dist = Math.hypot(f.x - c.dx, f.y - c.dy) / TILE;
    if (dist < 10) h.addTrauma(near * (1 - dist / 10));
  }
}
