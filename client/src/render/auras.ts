import Phaser from 'phaser';
import type { EntSnap, Snap } from '@vb/shared';
import { dotEllipse, flash, type EntView, type FxHost } from './fx';
import { crownOwnerOf } from './fxrules';
import { ELEM_RAMP, FORM_TINT, FXC, PRISM, bodyTint, darkTint, prismAt } from './fxpalette';
import { TILE } from './map';

/**
 * Auras de estado (forma final, troféus, escudo, Fome, Coroa), a energia da Carga
 * e o farol da Coroa. As órbitas são fillRect sem alocação: a metade de trás vai
 * no auraBackG (atrás do corpo) e a da frente no overG.
 */

const TAU = Math.PI * 2;
const BO = Phaser.Math.Easing.Back.Out;
const SIO = Phaser.Math.Easing.Sine.InOut;
const bez = Phaser.Math.Interpolation.QuadraticBezier;
const BLINK2 = [60, 50, 60] as const;
const RM_ANG = Math.PI / 4;

export class Auras {
  private slotBusy = [false, false, false, false];
  private pillar: Phaser.GameObjects.Rectangle[] = [];
  private crownOwner = -1;
  private crownStolen = false;
  private fly = { on: false, t0: 0, fx: 0, fy: 0, to: -1, sky: false, img: null as Phaser.GameObjects.Image | null };
  private hungerX2 = 0;
  private hungerAcc = 0;

  constructor(
    scene: Phaser.Scene,
    private host: FxHost,
  ) {
    // Pilar da Coroa em depth 9,5: acende o chão atrás do bicho sem lavar o sprite.
    const W = [6, 4, 2];
    for (let i = 0; i < 3; i++) {
      this.pillar.push(scene.add.rectangle(0, 0, W[i], 200, FXC.gold, 1).setOrigin(0.5, 1).setBlendMode(Phaser.BlendModes.ADD).setDepth(9.5).setVisible(false));
    }
  }

  clear(): void {
    for (let i = 0; i < 4; i++) this.slotBusy[i] = false;
    for (const r of this.pillar) r.setVisible(false);
    this.crownOwner = -1;
    this.fly.on = false;
    this.fly.img = this.host.fx.freeImage(this.fly.img);
  }

  // ---------------------------------------------------------------- diffs

  /** Transições de ch e sh (chamado em applySnap antes de v.data receber e). */
  diff(v: EntView, e: EntSnap, now: number, skip: boolean): void {
    const fx = this.host.fx;
    const ch = !!e.ch;
    if (ch && !v.chOn) {
      v.chOn = true;
      v.chUsed = false;
      v.chAcc = 0;
      v.chT0 = skip ? now - 1000 : now;
      v.chSlot = this.takeSlot();
      if (!skip) this.chargeStart(v, e, now);
    } else if (!ch && v.chOn) {
      v.chOn = false;
      this.releaseSlot(v);
      // Some sem golpe: 6 faíscas se apagando.
      if (!v.chUsed && !skip) {
        const P = fx.reset();
        P.c0 = FXC.gold2;
        P.spMin = 10;
        P.spMax = 25;
        P.lifeMin = P.lifeMax = 320;
        fx.emit(fx.spark, 6, v.x, v.y - 4, v.data.id === this.host.focusId(), true, 0.8);
      }
    }
    const sh = !!e.sh;
    if (sh !== v.shOn) {
      v.shOn = sh;
      v.shT0 = skip ? now - 1000 : now;
      if (!skip) this.shieldBurst(v, sh);
    }
  }

  /** 'h' carregado desse atacante: o raio consome a Carga. */
  chargedHit(v: EntView): void {
    v.chUsed = true;
    this.releaseSlot(v);
  }

  /** A EntView saiu do mundo: devolve o emissor de Carga. */
  drop(v: EntView): void {
    this.releaseSlot(v);
  }

  private takeSlot(): number {
    for (let i = 0; i < 4; i++) {
      if (this.slotBusy[i]) continue;
      this.slotBusy[i] = true;
      return i;
    }
    return -1;
  }

  private releaseSlot(v: EntView): void {
    if (v.chSlot >= 0) this.slotBusy[v.chSlot] = false;
    v.chSlot = -1;
  }

  private chargeStart(v: EntView, e: EntSnap, now: number): void {
    const fx = this.host.fx;
    flash(v, FXC.gold2, BLINK2, now, fx.rm);
    const P = fx.reset();
    P.rad = 16;
    P.mt = true;
    P.tx = v.x;
    P.ty = v.y - 3;
    P.lifeMin = P.lifeMax = 300;
    P.pal = null;
    P.c0 = FXC.gold2;
    P.c1 = bodyTint(e.f, e.o);
    P.a1 = 0.7;
    const em = v.chSlot >= 0 ? fx.charge[v.chSlot] : fx.magic;
    fx.emit(em, 16, v.x, v.y - 3, e.id === this.host.focusId());
  }

  private shieldBurst(v: EntView, on: boolean): void {
    const fx = this.host.fx;
    const mine = v.data.id === this.host.focusId();
    const P = fx.reset();
    if (on) {
      P.frame = 'plus';
      P.c0 = FXC.blue;
      P.spMin = 30;
      P.spMax = 60;
      P.rad = 10;
      P.lifeMin = P.lifeMax = 300;
      fx.emit(fx.spark, 8, v.x, v.y - 2, mine, true, 0.8);
    } else {
      P.frame = 'shard';
      P.c0 = FXC.blueL;
      P.spMin = 30;
      P.spMax = 70;
      P.rad = 10;
      P.ay = 150;
      P.lifeMin = P.lifeMax = 400;
      fx.emit(fx.pixels, 10, v.x, v.y - 2, mine, true, 0.8);
    }
  }

  // ---------------------------------------------------------------- Coroa

  /** Chamado depois das entidades: detecta a troca de dono da Coroa (pelo placar, não por quem está à vista). */
  onSnap(s: Snap, now: number, skip: boolean): void {
    const owner = crownOwnerOf(s.lb);
    if (owner !== this.crownOwner) {
      if (!skip && owner >= 0 && !this.crownStolen) this.crownFlight(this.crownOwner, owner, now);
      this.crownOwner = owner;
    }
    this.crownStolen = false;
  }

  /** Um 's' com cr neste snapshot: a Coroa já voa com o orbe do roubo. */
  stolen(): void {
    this.crownStolen = true;
  }

  private crownFlight(from: number, to: number, now: number): void {
    const h = this.host;
    const fv = from >= 0 ? h.view(from) : undefined;
    const f = this.fly;
    f.on = true;
    f.t0 = now;
    f.to = to;
    f.sky = !fv;
    f.fx = fv ? fv.x : 0;
    f.fy = fv ? fv.y - 14 : 0;
    f.img ??= h.fx.takeImage('crown');
    f.img?.setTint(FXC.gold).setVisible(false);
  }

  private updateCrown(s: Snap, now: number): void {
    const h = this.host;
    const fx = h.fx;
    // Ping: pilar de luz em 3 faixas e anel no chão que se repete a cada 700 ms.
    const c = s.crown;
    if (c) {
      const x = (c.x + 0.5) * TILE;
      const y = (c.y + 0.5) * TILE + 6;
      const pulse = fx.rm ? 1 : 0.8 + 0.2 * Math.sin((now / 1000) * TAU * 1.5);
      const A = [0.12, 0.2, 0.35];
      for (let i = 0; i < 3; i++) this.pillar[i].setPosition(Math.round(x), Math.round(y)).setAlpha(A[i] * pulse).setVisible(true);
      const k = (now % 700) / 700;
      const rx = 6 + 10 * k;
      dotEllipse(h, x, y, rx, rx * 0.4, 24, 0, FXC.gold, 1 - k);
    } else if (this.pillar[0].visible) for (const r of this.pillar) r.setVisible(false);
    // Troca de dono: a Coroa voa em arco (600 ms) ou desce do céu (400 ms).
    const f = this.fly;
    if (!f.on) return;
    const tv = h.view(f.to);
    const el = now - f.t0;
    const dur = f.sky ? 400 : 600;
    if (!tv || el >= dur) {
      if (tv) {
        const P = fx.reset();
        P.frame = 'plus';
        P.c0 = FXC.gold;
        P.spMin = 30;
        P.spMax = 70;
        P.lifeMin = P.lifeMax = 350;
        fx.emit(fx.spark, 10, tv.x, tv.y - 14, f.to === h.focusId());
      }
      f.on = false;
      f.img = fx.freeImage(f.img);
      return;
    }
    const tx = tv.x;
    const ty = tv.y - 14;
    const k = el / dur;
    let x: number;
    let y: number;
    if (f.sky) {
      x = tx;
      y = ty - 60 * (1 - SIO(k));
    } else {
      x = bez(k, f.fx, (f.fx + tx) / 2, tx);
      y = bez(k, f.fy, Math.min(f.fy, ty) - 30, ty);
    }
    f.img?.setVisible(true).setPosition(Math.round(x), Math.round(y));
  }

  // ---------------------------------------------------------------- por frame

  update(s: Snap, now: number, delta: number): void {
    this.updateCrown(s, now);
    // Fome (só você): o 'x2' pisca a cada 2 s.
    const me = s.me;
    if (me?.alive && me.hungerMs > 0) {
      this.hungerX2 += delta;
      if (this.hungerX2 >= 2000) {
        this.hungerX2 = 0;
        const v = this.host.view(me.id);
        if (v) this.host.fx.number('y', 'x2', v.x + 8, v.y - 4, 1, 1, me.id, now);
      }
    } else this.hungerX2 = 1600;
  }

  /** Auras de uma EntView visível (chamado no laço de entidades do GameScene). */
  view(v: EntView, now: number, delta: number, hunger: boolean): void {
    const h = this.host;
    const fx = h.fx;
    const e = v.data;
    const x = v.img.x;
    const y = v.img.y;
    if (!fx.view.contains(x, y)) return;
    const rm = fx.rm;
    const mine = e.id === h.focusId();
    if (v.chOn && !v.chUsed) this.charge(v, x, y, now, delta, mine);
    if (e.s === 3) this.finalForm(v, x, y, now, delta, mine);
    if (e.tr) {
      const n = Math.min(3, e.tr);
      const a0 = rm ? RM_ANG : (now / 3000) * TAU;
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * TAU;
        const s = Math.sin(a);
        this.star(s < 0, Math.round(x + Math.cos(a) * 14), Math.round(y - 3 + s * 5), FXC.gold, 1);
      }
    }
    if (e.cr) {
      const a0 = rm ? RM_ANG : (now / 1400) * TAU;
      for (let i = 0; i < 3; i++) {
        const a = a0 + (i / 3) * TAU;
        const s = Math.sin(a);
        this.dot(s < 0, Math.round(x + Math.cos(a) * 9), Math.round(y - 13 + s * 3), 2, FXC.gold, 1);
      }
      if (rm || now % 500 < 250) this.star(false, Math.round(x), Math.round(y - 21), FXC.ghost, 1);
    }
    if (v.shOn || now - v.shT0 < 120) this.shield(v, x, y, now);
    if (hunger && mine && !rm) {
      this.hungerAcc += delta;
      if (this.hungerAcc >= 300) {
        this.hungerAcc = 0;
        const P = fx.reset();
        P.frame = 'flame';
        P.c0 = FXC.red;
        P.c1 = FXC.gold;
        P.jit = 6;
        P.vy = -18;
        P.lifeMin = P.lifeMax = 500;
        fx.emit(fx.spark, 1, x, y, true, true);
      }
    }
  }

  private budget(back: boolean, n: number): Phaser.GameObjects.Graphics | null {
    const h = this.host;
    if (back) {
      if (h.backBudget + n > 120) return null;
      h.backBudget += n;
      return h.auraBackG;
    }
    if (h.overBudget + n > 160) return null;
    h.overBudget += n;
    return h.overG;
  }

  private dot(back: boolean, x: number, y: number, size: number, color: number, alpha: number): void {
    const g = this.budget(back, 1);
    if (!g) return;
    g.fillStyle(color, alpha);
    g.fillRect(x - (size >> 1), y - (size >> 1), size, size);
  }

  /** Estrela 5×5 (cruz com braços de 2). */
  private star(back: boolean, x: number, y: number, color: number, alpha: number): void {
    const g = this.budget(back, 2);
    if (!g) return;
    g.fillStyle(color, alpha);
    g.fillRect(x - 2, y, 5, 1);
    g.fillRect(x, y - 2, 1, 5);
  }

  /** Chama 3×5 com ponta clara, ou o 'plus' 3×3 no quadro alternado. */
  private flame(x: number, y: number, plus: boolean, light: number, body: number): void {
    const g = this.budget(false, 4);
    if (!g) return;
    if (plus) {
      g.fillStyle(light, 1);
      g.fillRect(x, y + 1, 1, 3);
      g.fillRect(x - 1, y + 2, 3, 1);
      return;
    }
    g.fillStyle(light, 1);
    g.fillRect(x, y, 1, 2);
    g.fillRect(x + 1, y + 1, 1, 1);
    g.fillStyle(body, 1);
    g.fillRect(x - 1, y + 2, 3, 2);
    g.fillRect(x, y + 4, 1, 1);
  }

  // ---------------------------------------------------------------- Carga

  private charge(v: EntView, x: number, y: number, now: number, delta: number, mine: boolean): void {
    const h = this.host;
    const fx = h.fx;
    const e = v.data;
    const rm = fx.rm;
    const el = now - v.chT0;
    const body = bodyTint(e.f, e.o);
    // Motes nascendo na borda (r 12-14) e espiralando para dentro em 350 ms.
    if (v.chSlot >= 0 && el >= 300 && !rm) {
      v.chAcc += delta;
      while (v.chAcc >= 110) {
        v.chAcc -= 110;
        const P = fx.reset();
        P.rad = 12 + Math.random() * 2;
        P.mt = true;
        P.tx = x;
        P.ty = y - 3;
        P.sw = 1.2;
        P.lifeMin = P.lifeMax = 350;
        P.c0 = FXC.gold2;
        P.c1 = body;
        P.frame = 'p1';
        fx.emit(fx.charge[v.chSlot], 1, x, y - 3, mine, true, 0.8);
        this.flavor(v, x, y, mine);
      }
    }
    // Órbita: 3 pixels 2×2 com núcleo branco (700 ms por volta); os de trás com alpha 0,5.
    const a0 = rm ? RM_ANG : (now / 700) * TAU;
    for (let i = 0; i < 3; i++) {
      const a = a0 + (i / 3) * TAU;
      const s = Math.sin(a);
      const px = Math.round(x + Math.cos(a) * 10);
      const py = Math.round(y - 3 + s * 4);
      this.dot(s < 0, px, py, 2, FXC.gold2, s < 0 ? 0.5 : 1);
      if (s >= 0) this.dot(false, px, py, 1, FXC.white, 1);
    }
    // Anel no chão (20×8) oscilando entre 0,35 e 0,85 a 5 Hz.
    const ra = rm ? 0.6 : 0.6 + 0.25 * Math.sin((now / 1000) * TAU * 5);
    dotEllipse(h, x, v.y + 7, 10, 4, 26, 0, FXC.gold2, ra);
    // Mini-raio ao lado da cabeça: pisca 60 ms a cada 280 ms.
    if (!rm && el % 280 < 60) {
      const side = Math.floor(el / 280) & 1 ? 1 : -1;
      const bx = Math.round(x + side * 8);
      const by = Math.round(y - 14);
      const g = this.budget(false, 4);
      if (g) {
        g.fillStyle(FXC.gold2, 1);
        g.fillRect(bx, by, 2, 1);
        g.fillRect(bx + 1, by + 1, 1, 2);
        g.fillRect(bx, by + 3, 2, 1);
        g.fillStyle(FXC.white, 1);
        g.fillRect(bx + 1, by + 1, 1, 1);
      }
    }
    // Sabor: bolha crescendo sobre a cabeça (Maré) e chamas alternando (Brasa).
    const el0 = e.o[0];
    if (e.f === 'neutro' || !el0) return;
    if (el0 === 'mare' && e.f !== 'quimera') {
      const st = rm ? 3 : 1 + (Math.floor(el / 200) % 3);
      const bx = Math.round(x);
      const by = Math.round(y - 20);
      const g = this.budget(false, 4);
      if (g) {
        g.fillStyle(FXC.blueL, 0.9);
        if (st === 1) g.fillRect(bx, by, 1, 1);
        else if (st === 2) g.fillRect(bx - 1, by - 1, 2, 2);
        else {
          g.fillRect(bx - 1, by - 2, 3, 1);
          g.fillRect(bx - 1, by + 2, 3, 1);
          g.fillRect(bx - 2, by - 1, 1, 3);
          g.fillRect(bx + 2, by - 1, 1, 3);
        }
      }
    } else if (el0 === 'brasa' && e.f !== 'quimera') {
      const alt = rm ? false : Math.floor(now / 110) & 1;
      const r = ELEM_RAMP.brasa;
      this.flame(Math.round(x - 3), Math.round(y - 18), !!alt, r[0], r[1]);
      this.flame(Math.round(x + 3), Math.round(y - 18), !alt, r[0], r[1]);
    }
  }

  /** Partícula de sabor que acompanha cada mote da Carga (Broto: raios de sol; Quimera: prisma). */
  private flavor(v: EntView, x: number, y: number, mine: boolean): void {
    const fx = this.host.fx;
    const e = v.data;
    if (e.f === 'quimera') {
      const P = fx.reset();
      P.pal = PRISM;
      P.seq = fx.SHRINK;
      P.spMin = 20;
      P.spMax = 40;
      P.lifeMin = P.lifeMax = 250;
      fx.emit(fx.spark, 1, x, y - 6, mine, true, 0.8);
    } else if (e.o[0] === 'broto' && e.f !== 'neutro') {
      const P = fx.reset();
      P.frame = 'p12';
      P.c0 = FXC.sun;
      P.jit = 5;
      P.vy = 50;
      P.lifeMin = P.lifeMax = 360;
      P.a0 = 0.9;
      P.a1 = 0.3;
      fx.emit(fx.spark, 1, x, y - 20, mine, true, 0.8);
    }
  }

  // ---------------------------------------------------------------- forma final

  private finalForm(v: EntView, x: number, y: number, now: number, delta: number, mine: boolean): void {
    const h = this.host;
    const fx = h.fx;
    const e = v.data;
    const rm = fx.rm;
    const f = e.f;
    // Anel no chão (18×6) na cor escura do elemento, alpha 0,25-0,45 a 1 Hz.
    dotEllipse(h, x, v.y + 7, 9, 3, 22, 0, darkTint(f, e.o), rm ? 0.35 : 0.35 + 0.1 * Math.sin((now / 1000) * TAU));
    let every = 0;
    if (f === 'brasa') {
      const r = ELEM_RAMP.brasa;
      for (let i = 0; i < 3; i++) {
        const plus = !rm && (Math.floor(now / 110) + i) & 1;
        this.flame(Math.round(x + (i - 1) * 4), Math.round(y - 15), !!plus, r[0], r[1]);
      }
      every = 250;
    } else if (f === 'mare') {
      this.orbit(x, y + 1, 11, 4, 3, rm ? RM_ANG : (now / 1800) * TAU, ELEM_RAMP.mare[0], ELEM_RAMP.mare[0], 1);
      every = 400;
    } else if (f === 'broto') {
      this.orbit(x, y + 1, 10, 4, 4, rm ? RM_ANG : (now / 2400) * TAU, FXC.petal, ELEM_RAMP.broto[0], 1);
      every = 300;
    } else if (f === 'quimera') {
      // Inverte o sentido a cada 2000 ms (onda triangular) com glitch de 1 px a cada 700 ms.
      const p = (now % 4000) / 2000;
      const a0 = rm ? RM_ANG : (p < 1 ? p : 2 - p) * TAU;
      const gl = !rm && now % 700 < 50 ? 1 : 0;
      for (let i = 0; i < 5; i++) {
        const a = a0 + (i / 5) * TAU;
        const s = Math.sin(a);
        this.dot(s < 0, Math.round(x + Math.cos(a) * 10) + gl, Math.round(y + 1 + s * 4), 2, PRISM[i], 1);
      }
    } else if (f !== 'neutro') {
      const second = e.o[1] ?? e.o[0];
      this.orbit(x, y + 1, 10, 4, 4, rm ? RM_ANG : (now / 2000) * TAU, FORM_TINT[f], second ? ELEM_RAMP[second][0] : FXC.white, 1);
    }
    if (!every || rm) return;
    v.auraAcc += delta;
    if (v.auraAcc < every) return;
    v.auraAcc = 0;
    const P = fx.reset();
    P.jit = 5;
    if (f === 'brasa') {
      const r = ELEM_RAMP.brasa;
      P.c0 = r[0];
      P.c1 = r[1];
      P.c2 = r[2];
      P.vy = -16;
      P.lifeMin = P.lifeMax = 700;
      fx.emit(fx.spark, 1, x, y - 12, mine, true, 0.8);
    } else if (f === 'mare') {
      P.frame = 'drop';
      P.c0 = ELEM_RAMP.mare[0];
      P.ay = 60;
      P.lifeMin = P.lifeMax = 450;
      fx.emit(fx.pixels, 1, x, y, mine, true, 0.8);
    } else {
      P.c0 = FXC.sun;
      P.vy = -6;
      P.vx = 4;
      P.lifeMin = P.lifeMax = 800;
      P.a0 = 0.9;
      fx.emit(fx.spark, 1, x, y - 6, mine, true, 0.8);
    }
  }

  /** n pontos 2×2 numa elipse, alternando duas cores. */
  private orbit(x: number, y: number, rx: number, ry: number, n: number, a0: number, c0: number, c1: number, alpha: number): void {
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * TAU;
      const s = Math.sin(a);
      this.dot(s < 0, Math.round(x + Math.cos(a) * rx), Math.round(y + s * ry), 2, i & 1 ? c1 : c0, alpha);
    }
  }

  // ---------------------------------------------------------------- escudo

  /** Bolha hexagonal de r 12: infla com Back.easeOut, brilho correndo em 900 ms; ao desligar, anel branco 12→16. */
  private shield(v: EntView, x: number, y: number, now: number): void {
    const el = now - v.shT0;
    const cy = y - 2;
    if (!v.shOn) {
      const k = el / 100;
      if (k < 1) {
        const r = 12 + 4 * k;
        const g = this.budget(false, 24);
        if (!g) return;
        g.fillStyle(FXC.white, 1 - k);
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * TAU;
          g.fillRect(Math.round(x + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), 1, 1);
        }
      }
      return;
    }
    const r = el < 200 ? 12 * BO(el / 200) : 12;
    if (r < 2) return;
    const g = this.budget(false, 34);
    if (!g) return;
    const hx = r / 2;
    const hy = r * 0.866;
    g.fillStyle(FXC.blue, 0.7);
    // Arestas de cima e de baixo (horizontais) e as 4 diagonais por colunas.
    g.fillRect(Math.round(x - hx), Math.round(cy - hy), Math.round(r), 1);
    g.fillRect(Math.round(x - hx), Math.round(cy + hy), Math.round(r), 1);
    this.edge(g, x + hx, cy - hy, x + r, cy);
    this.edge(g, x + r, cy, x + hx, cy + hy);
    this.edge(g, x - hx, cy - hy, x - r, cy);
    this.edge(g, x - r, cy, x - hx, cy + hy);
    g.fillStyle(FXC.blueL, 1);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      g.fillRect(Math.round(x + Math.cos(a) * r) - 1, Math.round(cy + Math.sin(a) * r) - 1, 2, 2);
    }
    // Brilho de 3 px percorrendo o contorno.
    if (!this.host.fx.rm) {
      const t = (now % 900) / 900;
      g.fillStyle(FXC.white, 1);
      for (let j = 0; j < 3; j++) {
        const u = ((t + j * 0.012) % 1) * 6;
        const i = Math.floor(u);
        const f = u - i;
        const a0 = (i / 6) * TAU;
        const a1 = ((i + 1) / 6) * TAU;
        g.fillRect(Math.round(x + Math.cos(a0) * r * (1 - f) + Math.cos(a1) * r * f), Math.round(cy + Math.sin(a0) * r * (1 - f) + Math.sin(a1) * r * f), 1, 1);
      }
    }
  }

  /** Aresta diagonal em colunas de 1 px (sem linhas rotacionadas). */
  private edge(g: Phaser.GameObjects.Graphics, x0: number, y0: number, x1: number, y1: number): void {
    const n = Math.max(1, Math.round(Math.abs(x1 - x0)));
    for (let i = 0; i < n; i++) {
      const xa = x0 + ((x1 - x0) * i) / n;
      const ya = y0 + ((y1 - y0) * i) / n;
      const yb = y0 + ((y1 - y0) * (i + 1)) / n;
      g.fillRect(Math.round(Math.min(xa, xa + (x1 - x0) / n)), Math.round(Math.min(ya, yb)), 1, Math.max(1, Math.round(Math.abs(yb - ya))));
    }
  }
}
