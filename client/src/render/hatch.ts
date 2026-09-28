import Phaser from 'phaser';
import { BALANCE, type EntSnap, type Form, type FxEvent } from '@vb/shared';
import { drawEggPart, type EggPart } from './creature';
import { flash, nudge, pop, squash, type EntView, type FxHost } from './fx';
import { ELEM_FRAME, FXC, PRISM, RAMP, bodyTint, lightTint } from './fxpalette';
import { eggCrackAt, eggTiltAt } from './fxrules';
import { TILE } from './map';

/**
 * Eclosão: o ovo surge num brilho no renascimento (FxEvent 'r'), balança e racha enquanto
 * choca (EntSnap.hx) e, quando o hx cai, estoura em casca e partículas do elemento e o
 * bebê aparece com um pop. A rachadura segue o relógio local desde que o ovo apareceu;
 * o estouro segue o servidor (hatchMs).
 */

type Born = Extract<FxEvent, { k: 'r' }>;

const HATCH_MS = BALANCE.respawn.hatchMs;
/** O ovo surge no brilho este tempo depois do 'r'. */
const APPEAR_MS = 150;
const GLOW_MS = 700;
const SHELL_MS = 650;
const PARTS: readonly EggPart[] = ['top', 'left', 'right'];
const WHITE_80 = [80] as const;
const WHITE_60 = [60] as const;
const TAU = Math.PI * 2;
/** do centro do sprite (origem 0,62) até a tampa do ovo e até os pés */
const CAP_DY = -5;
const FEET = 7;

interface Glow {
  on: boolean;
  t0: number;
  x: number;
  y: number;
  light: number;
  body: number;
  mine: boolean;
  /** motes já soltos (saem no 3º quadro: no 1º snapshot da partida a câmera ainda não chegou) */
  motes: boolean;
  column: Phaser.GameObjects.Image | null;
}

interface Shell {
  on: boolean;
  t0: number;
  x: number;
  y: number;
  depth: number;
  side: number;
  imgs: (Phaser.GameObjects.Image | null)[];
}

export class Hatch {
  private glows: Glow[] = [];
  private shells: Shell[] = [];
  private pool: Phaser.GameObjects.Image[] = [];
  private busy: boolean[] = [];
  /** id → instante do 'r' (a EntView nasce neste mesmo snapshot) */
  private pending = new Map<number, number>();

  constructor(
    private scene: Phaser.Scene,
    private host: FxHost,
  ) {
    for (let i = 0; i < 8; i++) this.glows.push({ on: false, t0: 0, x: 0, y: 0, light: 0, body: 0, mine: false, motes: false, column: null });
    for (let i = 0; i < 6; i++) this.shells.push({ on: false, t0: 0, x: 0, y: 0, depth: 0, side: 1, imgs: [null, null, null] });
    for (let i = 0; i < 18; i++) {
      this.pool.push(scene.add.image(0, 0, 'fx', 'p1').setVisible(false).setDepth(10));
      this.busy.push(false);
    }
  }

  clear(): void {
    const fx = this.host.fx;
    for (const g of this.glows) {
      g.on = false;
      g.column = fx.freeImage(g.column);
    }
    for (const s of this.shells) if (s.on) this.endShell(s);
    this.pending.clear();
  }

  // ---------------------------------------------------------------- renascimento

  /** 'r': brilho no tile e o ovo surge nele. e = a entidade no snapshot (se veio junto). */
  born(ev: Born, e: EntSnap | undefined, now: number): void {
    const h = this.host;
    const fx = h.fx;
    const x = (ev.x + 0.5) * TILE;
    const y = (ev.y + 0.5) * TILE;
    const mine = ev.id === h.focusId();
    const f: Form = e?.f ?? 'neutro';
    const o = e?.o ?? [];
    const light = f === 'neutro' ? FXC.cream : lightTint(f, o);
    const body = f === 'neutro' ? FXC.gold2 : bodyTint(f, o);
    this.pending.set(ev.id, now);
    if (this.pending.size > 40) this.pending.clear();
    // Já existe (renasceu sem sair do snapshot): vai direto para o tile novo e vira ovo.
    // Se já é o ovo recém-chegado neste tile (o 'r' veio um tick depois), só acende o brilho.
    const v = h.view(ev.id);
    const same = v !== undefined && v.egg && v.px === ev.x && v.py === ev.y && now - v.eggT0 < 600;
    if (same) this.pending.delete(ev.id);
    else if (v) {
      v.x = x;
      v.y = y;
      v.px = ev.x;
      v.py = ev.y;
      v.dieAt = 0;
      v.hidden = false;
      v.fadeMs = 0;
      v.label?.setVisible(true);
      this.startEgg(v, now, true);
      this.pending.delete(ev.id);
    }
    let g: Glow | null = null;
    for (const k of this.glows) if (!k.on) g ??= k;
    if (g) {
      g.on = true;
      g.t0 = now;
      g.x = x;
      g.y = y;
      g.light = light;
      g.body = body;
      g.mine = mine;
      g.motes = false;
      g.column = fx.takeImage('p1');
      g.column?.setOrigin(0.5, 1).setDisplaySize(6, 44).setTint(light).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0).setPosition(Math.round(x), Math.round(y + FEET));
    }
  }

  /** Nova EntView. Chocando: começa o ovo (no brilho, se veio de um 'r'). Devolve true se o ovo cuida da entrada. */
  enter(v: EntView, now: number): boolean {
    const t = this.pending.get(v.data.id);
    const intro = t !== undefined && now - t < 400;
    if (t !== undefined) this.pending.delete(v.data.id);
    if (!v.data.hx && !intro) return false;
    this.startEgg(v, now, intro);
    return intro;
  }

  /** EntView existente começou a chocar (hx ligou sem 'r'): vira ovo sem o brilho. */
  diff(v: EntView, e: EntSnap, now: number): void {
    if (e.hx && !v.egg) {
      v.data = e;
      this.startEgg(v, now, false);
    }
  }

  private startEgg(v: EntView, now: number, intro: boolean): void {
    v.egg = true;
    v.eggT0 = now;
    v.eggVar = v.data.id & 3;
    v.eggCrack = 0;
    v.eggAcc = 0;
    v.eggIntro = intro;
    // Sem hx (renasceu num 'r' sem o campo): choca pelo relógio local.
    v.eggHold = v.data.hx ? 0 : now + HATCH_MS;
    v.texSwapAt = 0;
    v.koUntil = 0;
    const key = this.host.eggTex(v.data, 0, 0);
    v.key = key;
    v.img.setTexture(key);
    if (intro) v.alpha = 0;
  }

  // ---------------------------------------------------------------- chocando

  /** Por frame, para cada EntView com egg. */
  view(v: EntView, now: number, delta: number): void {
    const h = this.host;
    const fx = h.fx;
    const el = now - v.eggT0;
    if (v.eggIntro) {
      if (el < APPEAR_MS) {
        v.alpha = 0;
        return;
      }
      v.eggIntro = false;
      v.alpha = 1;
      if (!fx.rm) pop(v, 0.2, 320, now);
      flash(v, 0xffffff, WHITE_80, now, fx.rm);
    }
    if (!v.data.hx && now >= v.eggHold) {
      this.hatch(v, now);
      return;
    }
    const crack = eggCrackAt(el, HATCH_MS);
    const tilt = fx.rm ? 0 : eggTiltAt(el, HATCH_MS);
    const mine = v.data.id === h.focusId();
    if (crack > v.eggCrack) {
      v.eggCrack = crack;
      if (!fx.rm) squash(v, 1.12, 0.9, 40, 30, 90, now);
      // Lascas da casca saltando da rachadura.
      const P = fx.reset();
      P.pal = SHELL;
      P.spMin = 20;
      P.spMax = 40;
      P.angMin = 220;
      P.angMax = 320;
      P.ay = 220;
      P.lifeMin = P.lifeMax = 320;
      fx.emit(fx.pixels, 3, v.x + (crack === 1 ? 3 : crack === 2 ? 0 : -3), v.y + CAP_DY + 2, mine);
    }
    const key = h.eggTex(v.data, crack, tilt);
    if (key !== v.key) {
      v.key = key;
      v.img.setTexture(key);
    }
    // A luz do bebê vaza pelas frestas.
    if (crack === 3 && !fx.rm) {
      v.eggAcc += delta;
      if (v.eggAcc >= 180) {
        v.eggAcc = 0;
        const d = v.data;
        const P = fx.reset();
        P.c0 = d.f === 'neutro' ? FXC.cream : lightTint(d.f, d.o);
        P.jit = 3;
        P.vy = -14;
        P.lifeMin = P.lifeMax = 450;
        P.a0 = 0.9;
        fx.emit(fx.spark, 1, v.x, v.y + CAP_DY + 1, mine, true, 0.8);
      }
    }
  }

  /** O hx caiu: a casca estoura e o bebê aparece com pop. */
  private hatch(v: EntView, now: number): void {
    const h = this.host;
    const fx = h.fx;
    const d = v.data;
    const mine = d.id === h.focusId();
    v.egg = false;
    v.eggIntro = false;
    v.alpha = 1;
    const look = { form: d.f, stage: d.s, order: d.o };
    const variant = v.eggVar;
    const key = h.texFor(d);
    v.key = key;
    v.img.setTexture(key);
    flash(v, 0xffffff, WHITE_60, now, fx.rm);
    if (!fx.rm) {
      pop(v, 0.35, 340, now);
      nudge(v, 0, -3, 90, 170, now, true);
    }
    const x = v.x;
    const y = v.y;
    // Clarão no centro
    let P = fx.reset();
    P.frame = 'star';
    P.a1 = 1;
    P.lifeMin = P.lifeMax = 90;
    fx.emit(fx.spark, 1, x, y + CAP_DY + 2, mine, true);
    // Lascas da casca
    P = fx.reset();
    P.frame = 'shard';
    P.pal = SHELL;
    P.spMin = 40;
    P.spMax = 90;
    P.angMin = 200;
    P.angMax = 340;
    P.ay = 260;
    P.lifeMin = 420;
    P.lifeMax = 560;
    fx.emit(fx.pixels, 8, x, y + CAP_DY + 2, mine);
    // Partículas do elemento (cada um com a sua física)
    const e0 = d.o[0];
    P = fx.reset();
    P.spMin = 50;
    P.spMax = 110;
    P.lifeMin = 380;
    P.lifeMax = 520;
    P.a1 = 0.4;
    let em = fx.spark;
    if (d.f === 'quimera') {
      P.pal = PRISM;
      P.seq = fx.SHRINK;
    } else if (d.f === 'neutro' || !e0) {
      P.frame = 'plus';
      P.pal = NEUTRAL_BURST;
    } else {
      P.frame = ELEM_FRAME[e0];
      P.pal = RAMP[d.f];
      if (e0 === 'brasa') P.ay = -70;
      else if (e0 === 'mare') {
        P.ay = 220;
        em = fx.pixels;
      } else {
        P.ay = 40;
        P.spin = 90;
        em = fx.pixels;
      }
    }
    fx.emit(em, 10, x, y - 2, mine);
    // Anel no chão na cor do bicho
    P = fx.reset();
    P.seq = fx.GROW_BIG;
    P.c0 = d.f === 'neutro' ? FXC.cream : bodyTint(d.f, d.o);
    P.lifeMin = P.lifeMax = 300;
    P.a1 = 0.2;
    fx.emit(fx.ring, 1, x, y + FEET - 1, mine, true);
    if (mine) {
      h.addTrauma(0.15);
      h.punch(0.03, 80, 220);
    }
    // A tampa voa girando e as metades de baixo se abrem para os lados.
    let s: Shell | null = null;
    for (const k of this.shells) if (!k.on) s ??= k;
    if (!s || !fx.view.contains(x, y)) return;
    s.on = true;
    s.t0 = now;
    s.x = x;
    s.y = y;
    s.depth = v.img.depth - 0.001;
    s.side = d.id & 1 ? 1 : -1;
    for (let i = 0; i < 3; i++) {
      const part = PARTS[i];
      const tk = `eggp:${look.form}-${look.order.join('')}-${variant}-${part}`;
      if (!this.scene.textures.exists(tk)) this.scene.textures.addCanvas(tk, drawEggPart(look, variant, part));
      const img = this.take();
      if (!img) break;
      img.setTexture(tk).setOrigin(0.5, i === 0 ? 14.5 / 32 : 0.62).setAngle(0).setAlpha(1).setDepth(i === 0 ? 890 : s.depth).setVisible(true);
      s.imgs[i] = img;
    }
    this.updateShell(s, now);
  }

  // ---------------------------------------------------------------- casca e brilho

  private take(): Phaser.GameObjects.Image | null {
    for (let i = 0; i < this.pool.length; i++) {
      if (this.busy[i]) continue;
      this.busy[i] = true;
      return this.pool[i];
    }
    return null;
  }

  private free(img: Phaser.GameObjects.Image | null): null {
    if (!img) return null;
    const i = this.pool.indexOf(img);
    if (i >= 0) this.busy[i] = false;
    img.setVisible(false);
    return null;
  }

  private endShell(s: Shell): void {
    for (let i = 0; i < 3; i++) s.imgs[i] = this.free(s.imgs[i]);
    s.on = false;
  }

  private updateShell(s: Shell, now: number): void {
    const el = now - s.t0;
    if (el >= SHELL_MS) {
      this.endShell(s);
      return;
    }
    const t = el / 1000;
    const rm = this.host.fx.rm;
    const fade = el < 380 ? 1 : 1 - (el - 380) / (SHELL_MS - 380);
    // Tampa: sobe, cai para o lado e gira em degraus de 90°.
    const top = s.imgs[0];
    if (top) {
      const dx = rm ? 0 : s.side * 28 * t;
      const dy = rm ? -4 * Math.min(1, el / 150) : -80 * t + 0.5 * 320 * t * t;
      top.setPosition(Math.round(s.x + dx), Math.round(s.y + CAP_DY + dy)).setAngle(rm ? 0 : Math.floor(el / 90) * 90 * s.side).setAlpha(fade);
    }
    // Metades: abrem 5 px para os lados e afundam 2 px (atrás do bebê).
    const k = rm ? 1 : Math.min(1, el / 200);
    for (let i = 1; i < 3; i++) {
      const img = s.imgs[i];
      if (!img) continue;
      const dir = i === 1 ? -1 : 1;
      img.setPosition(Math.round(s.x + dir * 5 * k), Math.round(s.y + 2 * k)).setAlpha(fade);
    }
  }

  private updateGlow(g: Glow, now: number): void {
    const h = this.host;
    const el = now - g.t0;
    if (!g.motes && el >= 40) {
      // Motes que descem e convergem no ovo.
      g.motes = true;
      const P = h.fx.reset();
      P.rad = 14;
      P.mt = true;
      P.tx = g.x;
      P.ty = g.y - 2;
      P.pal = [g.light, FXC.white, g.body];
      P.lifeMin = 240;
      P.lifeMax = 300;
      P.a0 = 1;
      P.a1 = 0.6;
      h.fx.emit(h.fx.magic, 12, g.x, g.y - 2, g.mine);
    }
    if (el >= GLOW_MS) {
      g.column = h.fx.freeImage(g.column);
      g.on = false;
      return;
    }
    const k = el / GLOW_MS;
    // Coluna de luz: sobe e some.
    g.column?.setAlpha(0.75 * Math.sin(k * Math.PI));
    // Anéis no chão: um abre, outro fecha no ovo.
    const fy = g.y + FEET;
    const r1 = 4 + 12 * Math.min(1, el / 350);
    if (!h.fx.rm) this.ring(g.x, fy, r1, g.light, 1 - k);
    const r2 = 14 * (1 - k);
    if (r2 >= 2) this.ring(g.x, fy, r2, g.body, 0.8);
  }

  private ring(x: number, y: number, rx: number, color: number, alpha: number): void {
    const h = this.host;
    const n = Math.max(12, Math.min(32, Math.round(rx * 2.5)));
    if (h.groundBudget + n > 220) return;
    h.groundBudget += n;
    const g = h.groundG;
    g.fillStyle(color, alpha);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      g.fillRect(Math.round(x + Math.cos(a) * rx), Math.round(y + Math.sin(a) * rx * 0.4), 1, 1);
    }
  }

  update(now: number): void {
    for (const g of this.glows) if (g.on) this.updateGlow(g, now);
    for (const s of this.shells) if (s.on) this.updateShell(s, now);
  }
}

const SHELL: readonly number[] = [FXC.cream, FXC.dust, FXC.stone];
const NEUTRAL_BURST: readonly number[] = [FXC.cream, FXC.gold2, FXC.white];
