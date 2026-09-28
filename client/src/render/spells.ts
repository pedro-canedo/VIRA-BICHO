import Phaser from 'phaser';
import { FX_CHARGED, FX_CLASH, FX_IMPACT_MS, FX_KO, type Action, type Form, type FxEvent, type SpecialKind } from '@vb/shared';
import { PAT_HIT, flash, nudge, squash, type EntView, type FxHost } from './fx';
import { ELEM_RAMP, FXC, PRISM, RAMP, bodyTint, prismAt, schoolOf, type School } from './fxpalette';
import { TILE } from './map';

/**
 * Feitiços elementais do golpe e o impacto no alvo. Tudo sincronizado pelo
 * relógio único: o golpe acerta FX_IMPACT_MS depois do snapshot com o 'h'.
 */

type Hit = Extract<FxEvent, { k: 'h' }>;
type Fury = Extract<FxEvent, { k: 'fu' }>;

const LAUNCH = 300;
const CLASH_AT = 450;
const MAX_FLYING = 4;
const MAX_HEADS = 5;

interface Slot {
  on: boolean;
  fury: boolean;
  t0: number;
  bt: number;
  a: number;
  d: number;
  /** posição do evento em px (fallback sem EntView) */
  ex: number;
  ey: number;
  school: School;
  form: Form;
  act: Action;
  /** Especial (o visual fica com Specials; aqui só o impacto, o HP e o número) */
  sp: SpecialKind | null;
  m: -1 | 0 | 1;
  fl: number;
  v: number;
  hp: number;
  /** fúria: dano em b e HP a aplicar */
  vb: number;
  fly: boolean;
  mine: boolean;
  heads: (Phaser.GameObjects.Image | null)[];
  outline: Phaser.GameObjects.Image | null;
  shield: Phaser.GameObjects.Image | null;
  mini: Phaser.GameObjects.Image | null;
  miniTint: number;
  acc: number;
  impacted: boolean;
  clashed: boolean;
  headX: number;
  headY: number;
  /** semente dos desvios do raio carregado */
  seed: number;
}

const newSlot = (): Slot => ({
  on: false,
  fury: false,
  t0: 0,
  bt: 0,
  a: 0,
  d: 0,
  ex: 0,
  ey: 0,
  school: 'neutro',
  form: 'neutro',
  act: 'ataque',
  sp: null,
  m: 0,
  fl: 0,
  v: 0,
  hp: 0,
  vb: 0,
  fly: false,
  mine: false,
  heads: [null, null, null, null, null],
  outline: null,
  shield: null,
  mini: null,
  miniTint: 0,
  acc: 0,
  impacted: false,
  clashed: false,
  headX: 0,
  headY: 0,
  seed: 0,
});

const QI = Phaser.Math.Easing.Quadratic.In;
const SI = Phaser.Math.Easing.Sine.In;
const bez = Phaser.Math.Interpolation.QuadraticBezier;

// Pontos reaproveitados
const A = { x: 0, y: 0 };
const D = { x: 0, y: 0 };

export class Spells {
  private slots: Slot[] = [];

  constructor(private host: FxHost) {
    for (let i = 0; i < 12; i++) this.slots.push(newSlot());
  }

  private free(): Slot | null {
    let oldest: Slot | null = null;
    for (const s of this.slots) {
      if (!s.on) return s;
      if (!oldest || s.t0 < oldest.t0) oldest = s;
    }
    if (oldest) this.release(oldest);
    return oldest;
  }

  private flying(): number {
    let n = 0;
    for (const s of this.slots) if (s.on && s.fly && !s.impacted) n++;
    return n;
  }

  private release(s: Slot): void {
    const fx = this.host.fx;
    for (let i = 0; i < MAX_HEADS; i++) s.heads[i] = fx.freeImage(s.heads[i]);
    s.outline = fx.freeImage(s.outline);
    s.shield = fx.freeImage(s.shield);
    s.mini = fx.freeImage(s.mini);
    s.on = false;
  }

  clear(): void {
    for (const s of this.slots) if (s.on) this.release(s);
  }

  /** EntView de quem luta; o ovo de quem já renasceu com o mesmo id não conta. */
  private live(id: number): EntView | undefined {
    const v = this.host.view(id);
    return v && !v.egg ? v : undefined;
  }

  /** Centro do corpo de uma EntView (ou do evento). */
  private pos(out: { x: number; y: number }, v: EntView | undefined, x: number, y: number): void {
    if (v) {
      out.x = v.x;
      out.y = v.y - 2;
    } else {
      out.x = x;
      out.y = y;
    }
  }

  hit(e: Hit, now: number): void {
    const h = this.host;
    const av = h.view(e.a);
    const dv = h.view(e.d);
    const focus = h.focusId();
    const mine = e.a === focus || e.d === focus;
    const s = this.free();
    if (!s) return;
    s.on = true;
    s.fury = false;
    s.t0 = now;
    s.bt = e.bt;
    s.a = e.a;
    s.d = e.d;
    s.ex = (e.x + 0.5) * TILE;
    s.ey = (e.y + 0.5) * TILE;
    const ad = av?.data;
    s.school = ad ? schoolOf(ad.f, ad.s, ad.o) : 'neutro';
    s.form = ad?.f ?? 'neutro';
    s.act = e.act;
    s.sp = e.sp ?? null;
    s.m = e.m;
    s.fl = e.fl;
    s.v = e.v;
    s.hp = e.hp;
    s.mine = mine;
    s.acc = 0;
    s.impacted = s.clashed = false;
    s.seed = Math.random() * 1000;
    s.fly = !s.sp && !!av && !!dv && (mine || this.flying() < MAX_FLYING);
    // A barra mostra o HP antigo até o impacto.
    if (dv) dv.hpHoldUntil = now + FX_IMPACT_MS;
    if (!av || !dv) return;
    const fx = h.fx;
    // Antecipação: recua 2 px para longe do alvo.
    const dx = av.x - dv.x;
    const dy = av.y - dv.y;
    const len = Math.hypot(dx, dy) || 1;
    if (!fx.rm) nudge(av, Math.round((dx / len) * 2), Math.round((dy / len) * 2), 70, 80, now);
    if (e.act === 'carga' && s.fly) {
      // Preparo: 8 motes dourados convergem no atacante.
      const P = fx.reset();
      P.rad = 12;
      P.mt = true;
      P.tx = av.x;
      P.ty = av.y - 2;
      P.lifeMin = P.lifeMax = 250;
      P.c0 = FXC.gold2;
      P.a0 = 1;
      P.a1 = 0.6;
      fx.emit(fx.magic, 8, av.x, av.y - 2, mine);
    }
    if (!s.fly) return;
    const heads = s.school === 'brasa' ? 1 : s.school === 'mare' ? 2 : s.school === 'broto' ? (e.act === 'defesa' ? 3 : MAX_HEADS) : 0;
    const charged = (e.fl & FX_CHARGED) !== 0;
    for (let i = 0; i < heads; i++) {
      const frame = s.school === 'brasa' ? (e.act === 'defesa' ? 'plus' : 'orb') : s.school === 'mare' ? 'drop' : 'leaf';
      const img = fx.takeImage(frame);
      if (!img) break;
      const tint = s.school === 'brasa' ? 0xffd27a : s.school === 'mare' ? (i ? ELEM_RAMP.mare[1] : ELEM_RAMP.mare[0]) : i & 1 ? ELEM_RAMP.broto[0] : ELEM_RAMP.broto[1];
      img.setTint(tint).setScale(charged ? 2 : 1).setVisible(false);
      if (s.school === 'brasa') img.setBlendMode(Phaser.BlendModes.ADD);
      s.heads[i] = img;
    }
    if (charged && s.school === 'brasa') s.outline = fx.takeImage('ring8')?.setTint(FXC.gold2).setVisible(false) ?? null;
    if (e.act === 'defesa') {
      s.shield = fx.takeImage('hex')?.setTint(FXC.blue).setVisible(false) ?? null;
      s.miniTint = RAMP[dv.data.f][1];
      s.mini = fx.takeImage('p2')?.setTint(s.miniTint).setVisible(false) ?? null;
    } else if (e.act === 'carga') {
      s.shield = fx.takeImage('hex')?.setTint(FXC.blue).setVisible(false) ?? null;
    }
  }

  fury(e: Fury, now: number): void {
    const s = this.free();
    if (!s) return;
    const h = this.host;
    s.on = true;
    s.fury = true;
    s.t0 = now;
    s.bt = e.bt;
    s.a = e.a;
    s.d = e.b;
    s.v = e.va;
    s.vb = e.vb;
    s.ex = (e.x + 0.5) * TILE;
    s.ey = (e.y + 0.5) * TILE;
    s.fly = false;
    s.impacted = false;
    s.mine = e.a === h.focusId() || e.b === h.focusId();
    const va = h.view(e.a);
    const vb = h.view(e.b);
    if (va) va.hpHoldUntil = now + FX_IMPACT_MS;
    if (vb) vb.hpHoldUntil = now + FX_IMPACT_MS;
  }

  update(now: number, delta: number): void {
    for (const s of this.slots) {
      if (!s.on) continue;
      const el = now - s.t0;
      if (s.fury) {
        if (el >= FX_IMPACT_MS) {
          this.furyImpact(s, now);
          s.on = false;
        }
        continue;
      }
      const av = this.live(s.a);
      const dv = this.live(s.d);
      this.pos(A, av, s.ex, s.ey);
      this.pos(D, dv, s.ex, s.ey);
      if (s.fly) this.animate(s, el, now, delta);
      if (!s.impacted && el >= FX_IMPACT_MS) {
        s.impacted = true;
        this.impact(s, now);
      }
      if ((s.fl & FX_CHARGED) !== 0 && el >= FX_IMPACT_MS && el < FX_IMPACT_MS + 120) this.drawBolt(s, el);
      if (el >= FX_IMPACT_MS + 220) this.release(s);
    }
  }

  // ---------------------------------------------------------------- voo

  private animate(s: Slot, el: number, now: number, delta: number): void {
    const fx = this.host.fx;
    const g = this.host.airG;
    // Defesa (contra-ataque): um projétil pequeno do alvo bate no escudo do atacante.
    const ux = D.x - A.x;
    const uy = D.y - A.y;
    const len = Math.hypot(ux, uy) || 1;
    const nx = ux / len;
    const ny = uy / len;
    if (s.shield) {
      const onA = s.act === 'defesa';
      const show = onA ? el >= 100 && el < 280 : el < FX_IMPACT_MS;
      s.shield.setVisible(show);
      if (onA) s.shield.setPosition(Math.round(A.x + nx * 6), Math.round(A.y + ny * 6));
      else s.shield.setPosition(Math.round(D.x), Math.round(D.y));
    }
    if (s.mini) {
      if (el >= 60 && el < 180) {
        const k = (el - 60) / 120;
        const tx = A.x + nx * 6;
        const ty = A.y + ny * 6;
        s.mini.setVisible(true).setPosition(Math.round(D.x + (tx - D.x) * k), Math.round(D.y + (ty - D.y) * k));
      } else if (el >= 180) {
        const P = fx.reset();
        P.spMin = 20;
        P.spMax = 40;
        P.lifeMin = P.lifeMax = 200;
        P.c0 = s.miniTint;
        fx.emit(fx.pixels, 4, s.mini.x, s.mini.y, s.mine, true);
        s.mini = fx.freeImage(s.mini);
      }
    }
    const clash = (s.fl & FX_CLASH) !== 0;
    const end = clash ? CLASH_AT : FX_IMPACT_MS;
    // Fim do caminho: o alvo, ou o ponto médio no choque.
    // Sai da frente do atacante, na altura da cabeça, e chega na frente do alvo.
    const sx = A.x + nx * 4;
    const sy = A.y - 3;
    const ex = clash ? (A.x + D.x) / 2 : D.x - nx * 3;
    const ey = clash ? (A.y + D.y) / 2 - 3 : D.y - 1;
    if (clash && !s.clashed && el >= CLASH_AT) {
      s.clashed = true;
      if (s.a < s.d) {
        const P = fx.reset();
        P.frame = 'star';
        P.spMin = 40;
        P.spMax = 90;
        P.lifeMin = 200;
        P.lifeMax = 300;
        fx.emit(fx.spark, 10, ex, ey, s.mine);
        const R = fx.reset();
        R.seq = fx.GROW_BIG;
        R.c0 = FXC.gold;
        R.lifeMin = R.lifeMax = 220;
        R.a1 = 0.3;
        fx.emit(fx.ringAir, 1, ex, ey, s.mine);
      }
    }
    const flying = el >= LAUNCH && el < end;
    for (let i = 0; i < MAX_HEADS; i++) s.heads[i]?.setVisible(false);
    s.outline?.setVisible(false);
    if (s.school === 'quimera') {
      if (el >= 420 && el < FX_IMPACT_MS) this.prism(g, now, el);
      return;
    }
    if (s.school === 'neutro') {
      // Cabeçada: avança 6 px e volta.
      if (!s.clashed && el >= FX_IMPACT_MS - 90 && el - delta < FX_IMPACT_MS - 90) {
        const av = this.live(s.a);
        if (av) nudge(av, Math.round(nx * 6), Math.round(ny * 6), 90, 90, now);
      }
      return;
    }
    if (!flying && !(s.school === 'broto' && el >= LAUNCH && el < end + 160)) return;
    const p = Math.min(1, (el - LAUNCH) / (end - LAUNCH));
    const weak = s.m === -1 && p > 0.85;
    const cx = (sx + ex) / 2;
    const cy = (sy + ey) / 2;
    if (s.school === 'brasa') {
      const k = QI(p);
      // Arco com pico de −8 px (ponto de controle a −16).
      const x = bez(k, sx, cx, ex);
      const y = bez(k, sy, cy - 16, ey);
      s.headX = x;
      s.headY = y;
      const hd = s.heads[0];
      if (hd && flying) {
        hd.setVisible(true).setPosition(Math.round(x), Math.round(y));
        if (weak) hd.setScale(Math.max(1, hd.scaleX - 1)).setAlpha(1 - ((p - 0.85) / 0.15) * 0.6);
        s.outline?.setVisible(true).setPosition(Math.round(x), Math.round(y));
      }
    } else if (s.school === 'mare') {
      const k = SI(p);
      const x = sx + (ex - sx) * k;
      const y = sy + (ey - sy) * k;
      s.headX = x;
      s.headY = y;
      // Hélice: 3 voltas de raio 3 em torno da reta.
      for (let i = 0; i < 2; i++) {
        const hd = s.heads[i];
        if (!hd || !flying) continue;
        const w = Math.sin(p * Math.PI * 6 + i * Math.PI) * 3;
        hd.setVisible(true).setPosition(Math.round(x - ny * w), Math.round(y + nx * w));
        if (weak) hd.setAlpha(1 - ((p - 0.85) / 0.15) * 0.6);
      }
    } else {
      for (let i = 0; i < MAX_HEADS; i++) {
        const hd = s.heads[i];
        if (!hd) continue;
        const pi = (el - LAUNCH - i * 40) / (end - LAUNCH);
        if (pi < 0 || pi >= 1) continue;
        const x = sx + (ex - sx) * pi;
        const y = sy + (ey - sy) * pi;
        const w = Math.sin(pi * Math.PI * 2) * 4;
        hd.setVisible(true)
          .setPosition(Math.round(x - ny * w), Math.round(y + nx * w))
          .setAngle(Math.floor(el / 60) * 90);
        if (i === 0) {
          s.headX = x;
          s.headY = y;
        }
      }
    }
    if (flying) this.trail(s, delta);
  }

  /** Rastro por acumulador, com o sabor da forma (híbridos soltam o rastro próprio). */
  private trail(s: Slot, delta: number): void {
    const fx = this.host.fx;
    const every = s.form === 'vapor' ? 40 : s.form === 'cinza' ? 30 : s.form === 'mangue' ? 35 : s.school === 'brasa' ? 16 : s.school === 'mare' ? 30 : 0;
    if (!every) return;
    s.acc += delta;
    while (s.acc >= every) {
      s.acc -= every;
      const P = fx.reset();
      P.jit = 1;
      if (s.form === 'vapor') {
        P.frame = 'p2';
        P.c0 = FXC.vapor;
        P.s0 = 1;
        P.s1 = 3;
        P.a0 = 0.8;
        P.lifeMin = P.lifeMax = 350;
        P.vy = -6;
        fx.emit(fx.pixels, 1, s.headX, s.headY, s.mine);
      } else if (s.form === 'cinza') {
        P.frame = 'ash';
        P.c0 = FXC.ash;
        P.ay = 60;
        P.lifeMin = P.lifeMax = 400;
        fx.emit(fx.pixels, 1, s.headX, s.headY, s.mine);
      } else if (s.form === 'mangue') {
        P.frame = 'p2';
        P.pal = MUD;
        P.ay = 40;
        P.lifeMin = P.lifeMax = 350;
        fx.emit(fx.pixels, 1, s.headX, s.headY, s.mine);
      } else if (s.school === 'brasa') {
        const r = ELEM_RAMP.brasa;
        P.c0 = r[0];
        P.c1 = r[1];
        P.c2 = r[2];
        P.frame = 'p2';
        P.ay = -40;
        P.spMax = 10;
        P.lifeMin = P.lifeMax = 250;
        fx.emit(fx.spark, 2, s.headX, s.headY, s.mine);
      } else {
        P.frame = 'bubble';
        P.c0 = ELEM_RAMP.mare[0];
        P.vy = -8;
        P.a0 = 0.9;
        P.lifeMin = P.lifeMax = 300;
        fx.emit(fx.pixels, 1, s.headX, s.headY, s.mine);
      }
    }
  }

  /** Raio prismático da Quimera: zigue-zague de 3 segmentos trocando de cor a cada 40 ms. */
  private prism(g: Phaser.GameObjects.Graphics, now: number, el: number): void {
    const c = prismAt(now);
    const seed = Math.floor(el / 40);
    let x0 = A.x;
    let y0 = A.y;
    for (let i = 1; i <= 3; i++) {
      const k = i / 3;
      const off = i < 3 ? ((((seed * 7 + i * 13) % 9) - 4) | 0) : 0;
      const x1 = A.x + (D.x - A.x) * k - ((D.y - A.y) / 40) * off;
      const y1 = A.y + (D.y - A.y) * k + ((D.x - A.x) / 40) * off;
      g.lineStyle(2, c, 1);
      g.lineBetween(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1));
      x0 = x1;
      y0 = y1;
    }
  }

  /** Raio do golpe carregado: 4 segmentos, desvio de ±4 px, redesenhado aos 45 ms; e 8 raios curtos no alvo. */
  private drawBolt(s: Slot, el: number): void {
    const g = this.host.airG;
    const e = el - FX_IMPACT_MS;
    if (e < 90) {
      const seed = s.seed + (e < 45 ? 0 : 17);
      const dx = D.x - A.x;
      const dy = D.y - A.y;
      const len = Math.hypot(dx, dy) || 1;
      for (let pass = 0; pass < 2; pass++) {
        g.lineStyle(pass ? 1 : 3, pass ? 0xffffff : FXC.gold, 1);
        let x0 = A.x;
        let y0 = A.y;
        for (let i = 1; i <= 4; i++) {
          const k = i / 4;
          const off = i < 4 ? Math.round(Math.sin(seed + i * 2.3) * 4) : 0;
          const x1 = Math.round(A.x + dx * k - (dy / len) * off);
          const y1 = Math.round(A.y + dy * k + (dx / len) * off);
          g.lineBetween(x0, y0, x1, y1);
          x0 = x1;
          y0 = y1;
        }
      }
    }
    if (e < 120) {
      g.lineStyle(1, FXC.gold2, 1);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const r0 = 8;
        const r1 = 8 + 4 + (i & 1) * 2;
        g.lineBetween(Math.round(D.x + Math.cos(a) * r0), Math.round(D.y + Math.sin(a) * r0), Math.round(D.x + Math.cos(a) * r1), Math.round(D.y + Math.sin(a) * r1));
      }
    }
  }

  // ---------------------------------------------------------------- impacto

  private impact(s: Slot, now: number): void {
    const h = this.host;
    const fx = h.fx;
    const av = this.live(s.a);
    const dv = this.live(s.d);
    const charged = (s.fl & FX_CHARGED) !== 0;
    const ko = (s.fl & FX_KO) !== 0;
    const mhp = dv?.data.mhp ?? 100;
    const big = charged || s.m === 1 || s.v >= mhp * 0.25 || s.sp !== null;
    const stop = ko ? 150 : big ? 100 : 60;
    // Direção do golpe (do atacante para o alvo)
    let nx = D.x - A.x;
    let ny = D.y - A.y;
    const len = Math.hypot(nx, ny);
    if (len > 0) {
      nx /= len;
      ny /= len;
    } else {
      nx = 1;
      ny = 0;
    }
    if (dv) {
      flash(dv, 0xffffff, PAT_HIT, now, fx.rm);
      dv.freezeUntil = now + stop;
      nudge(dv, Math.round(nx * 3), Math.round(ny * 3), 50, 160, now + stop, true);
      this.dropHp(dv, s.hp, now);
      if (s.v >= mhp * 0.25) dv.thickUntil = now + 100;
      if (ko) {
        dv.koUntil = now + 1500;
        squash(dv, 1.2, 0.7, 120, 1380, 0, now);
      }
    }
    if (av) av.freezeUntil = now + stop;
    const cx = D.x - nx * 5;
    const cy = D.y - ny * 5;
    // Estrela branca parada no ponto de contato
    let P = fx.reset();
    if (s.sp) {
      P.frame = 'star';
      P.a1 = 1;
      P.lifeMin = P.lifeMax = 120;
      fx.emit(fx.spark, 1, cx, cy, s.mine, true);
      this.camera(s, dv, ko, charged, mhp);
      this.number(s, nx, charged, now);
      return;
    }
    P.frame = 'star';
    P.a1 = 1;
    P.lifeMin = P.lifeMax = 90;
    fx.emit(fx.spark, 1, cx, cy, s.mine, true);
    // Cone de faíscas pela escola
    const base = Math.atan2(ny, nx) / (Math.PI / 180);
    let n = s.m === 1 || charged ? 18 : 10;
    if (ko) n = Math.round(n * 1.5);
    P = fx.reset();
    P.seq = fx.SHRINK;
    P.angMin = base - 60;
    P.angMax = base + 60;
    P.spMin = 50;
    P.spMax = 130;
    P.lifeMin = 220;
    P.lifeMax = 320;
    P.a1 = 0.6;
    let em = fx.spark;
    switch (s.school) {
      case 'brasa': {
        const r = ELEM_RAMP.brasa;
        P.c0 = r[0];
        P.c1 = r[1];
        P.c2 = r[2];
        P.ay = -60;
        break;
      }
      case 'mare': {
        const r = ELEM_RAMP.mare;
        P.c0 = r[0];
        P.c1 = r[1];
        P.c2 = r[2];
        P.seq = null;
        P.frame = 'drop';
        P.ay = 220;
        em = fx.ground;
        break;
      }
      case 'broto': {
        P.pal = ELEM_RAMP.broto;
        P.seq = null;
        P.frame = 'leaf';
        P.ay = 40;
        P.spin = 90;
        em = fx.pixels;
        break;
      }
      case 'quimera':
        P.pal = PRISM;
        break;
      default:
        P.c0 = FXC.cream;
    }
    fx.emit(em, n, cx, cy, s.mine);
    if (s.m === 1) {
      P = fx.reset();
      P.frame = 'star';
      P.spMin = 70;
      P.spMax = 130;
      P.lifeMin = P.lifeMax = 350;
      fx.emit(fx.spark, 6, cx, cy, s.mine);
      P = fx.reset();
      P.seq = fx.GROW_BIG;
      P.c0 = av ? bodyTint(av.data.f, av.data.o) : 0xffffff;
      P.lifeMin = P.lifeMax = 220;
      P.a1 = 0.4;
      fx.emit(fx.ringAir, 1, D.x, D.y, s.mine, true);
    } else if (s.m === -1) {
      P = fx.reset();
      P.c0 = FXC.slate;
      P.spMin = 10;
      P.spMax = 30;
      P.ay = 80;
      P.lifeMin = P.lifeMax = 450;
      P.a1 = 0.3;
      fx.emit(fx.pixels, 5, cx, cy, s.mine);
    }
    if (s.act === 'carga' && s.shield) {
      // O escudo do alvo estilhaça.
      P = fx.reset();
      P.frame = 'shard';
      P.c0 = FXC.blue;
      P.spMin = 30;
      P.spMax = 70;
      P.ay = 150;
      P.lifeMin = P.lifeMax = 400;
      fx.emit(fx.ground, 6, D.x, D.y, s.mine);
      s.shield = fx.freeImage(s.shield);
    }
    if (s.school === 'neutro') {
      P = fx.reset();
      P.c0 = FXC.cream;
      P.spMin = 20;
      P.spMax = 50;
      P.lifeMin = P.lifeMax = 250;
      fx.emit(fx.spark, 6, cx, cy, s.mine);
    } else if (s.school === 'quimera') {
      P = fx.reset();
      P.pal = PRISM;
      P.seq = fx.SHRINK;
      P.spMin = 30;
      P.spMax = 80;
      P.lifeMin = P.lifeMax = 300;
      fx.emit(fx.spark, 8, cx, cy, s.mine);
    }
    this.camera(s, dv, ko, charged, mhp);
    this.number(s, nx, charged, now);
  }

  private camera(s: Slot, dv: EntView | undefined, ko: boolean, charged: boolean, mhp: number): void {
    const h = this.host;
    const focus = h.focusId();
    if (dv) {
      const rel = Math.min(0.6, Math.max(0.15, (s.v / mhp) * 1.4));
      if (s.d === focus) {
        h.addTrauma(rel);
        if (s.v >= mhp * 0.3) h.punch(0.04, 90, 160);
      } else if (s.a === focus) h.addTrauma(rel * 0.6);
      else {
        const f = h.view(focus);
        if (f) {
          const dist = Math.hypot(f.x - dv.x, f.y - dv.y) / TILE;
          if (dist < 10) h.addTrauma(0.4 * (1 - dist / 10) * rel);
        }
      }
      if (ko && (s.d === focus || s.a === focus)) h.addTrauma(0.8);
    }
    if (charged && s.a === focus) h.addTrauma(0.15);
  }

  /** Número (na sua batalha o painel mostra o número grande); o Especial sai na cor da linha. */
  private number(s: Slot, nx: number, charged: boolean, now: number): void {
    const h = this.host;
    if (s.bt === h.panelBattle()) return;
    let font = 'w';
    let txt = `${Math.round(s.v)}`;
    let sc = 1;
    if (s.sp) {
      font = SP_FONT[s.sp];
      txt += charged ? 'x2' : '!';
      sc = 2;
    } else if (charged) {
      font = 'c';
      txt += 'x2';
      sc = 2;
    } else if (s.m === 1) {
      font = s.school === 'brasa' || s.school === 'mare' || s.school === 'broto' ? s.school : 'y';
      txt += '!';
      sc = 2;
    } else if (s.m === -1) {
      font = 'l';
      txt += '.';
    }
    h.fx.number(font, txt, D.x, D.y - 4, sc, nx >= 0 ? 1 : -1, s.d, now);
  }

  private furyImpact(s: Slot, now: number): void {
    const h = this.host;
    const fx = h.fx;
    for (let side = 0; side < 2; side++) {
      const id = side ? s.d : s.a;
      const dmg = side ? s.vb : s.v;
      const v = this.live(id);
      this.pos(A, v, s.ex, s.ey);
      const P = fx.reset();
      P.c0 = FXC.red;
      P.c1 = 0xff7a3d;
      P.frame = 'p2';
      P.jit = 5;
      P.vy = -10;
      P.ay = -80;
      P.lifeMin = P.lifeMax = 500;
      P.delay = 150;
      fx.emit(fx.spark, 12, A.x, A.y + 4, s.mine);
      if (v) {
        flash(v, FXC.red, FURY_PAT, now, fx.rm);
        this.dropHp(v, Math.max(0, v.data.hp), now);
      }
      if (dmg > 0 && s.bt !== h.panelBattle()) fx.number('r', `${Math.round(dmg)}`, A.x, A.y - 4, 1, side ? 1 : -1, id, now);
    }
    if (s.mine) h.addTrauma(0.3);
  }

  /** Cai para o HP do evento com o fantasma segurando 350 ms. */
  private dropHp(v: EntView, hp: number, now: number): void {
    v.hpHoldUntil = 0;
    if (hp < v.shownHp) {
      v.ghostHp = Math.max(v.ghostHp, v.shownHp);
      v.ghostHoldUntil = now + 350;
    }
    v.shownHp = hp;
  }
}

const MUD: readonly number[] = [FXC.mud, 0x17803a];
const SP_FONT: Record<SpecialKind, string> = { brutal: 'r', arcana: 'a', armadilha: 'g' };
const FURY_PAT = [100] as const;
