import Phaser from 'phaser';
import type { EntSnap } from '@vb/shared';
import { buildFxAtlas } from './fxatlas';
import { clearBottom } from './fxrules';

/**
 * Diretor de efeitos do mundo: emissores criados uma vez, orçamento de partículas
 * por tier, reduced-motion, pools (imagens, números, lampejo) e os estados de efeito
 * que vivem em cada EntView (lampejo, empurrão, squash, pop).
 */

/** 0 alto, 1 médio, 2 baixo */
export type Tier = 0 | 1 | 2;
export const TIER_NAMES = ['alto', 'medio', 'baixo'] as const;

const CAPS = [
  { total: 300, amb: 70, zone: 24, ev: 206 },
  { total: 170, amb: 35, zone: 12, ev: 123 },
  { total: 90, amb: 0, zone: 0, ev: 90 },
] as const;
const MULT = [1, 0.6, 0.35] as const;
const RM_CAP = 60;

/** Estado visual de um bicho no mundo, compartilhado pelos efeitos. */
export interface EntView {
  img: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text | null;
  key: string;
  x: number;
  y: number;
  data: EntSnap;
  /** escala base (0,8 nos selvagens) */
  base: number;
  // Tile e estágio anteriores (diffs)
  px: number;
  py: number;
  ps: number;
  // Barra de HP
  shownHp: number;
  ghostHp: number;
  ghostHoldUntil: number;
  hpHoldUntil: number;
  thickUntil: number;
  // Offset de efeito (empurrão) somado no update
  ox: number;
  oy: number;
  nx: number;
  ny: number;
  nT0: number;
  nOut: number;
  nBack: number;
  nBackEase: boolean;
  // Squash
  sx: number;
  sy: number;
  qx: number;
  qy: number;
  qT0: number;
  qIn: number;
  qHold: number;
  qOut: number;
  qSteps: number;
  // Pop de troca de textura
  popFrom: number;
  popT0: number;
  popMs: number;
  /** A textura fica presa até este instante; aí entra a do snapshot com pop a partir de texPop. */
  texSwapAt: number;
  texPop: number;
  alpha: number;
  blinkT0: number;
  blinkUntil: number;
  freezeUntil: number;
  koUntil: number;
  flashPat: readonly number[] | null;
  flashT0: number;
  flashColor: number;
  /** cor do FILL aplicado agora (-1 = sem tint) */
  tintOn: number;
  /** balanço atual (fica parado no hitstop) */
  bob: number;
  burning: boolean;
  /** barra de HP desenhada no último frame (os números desviam dela) */
  barOn: boolean;
  stepAt: number;
  /** -1 olha para a esquerda (desenho original), 1 para a direita */
  dir: number;
  acc: number;
  burnT: number;
  burnFlashT: number;
  // Passos: salto, squash de passo e respiração
  hop: number;
  wsx: number;
  wsy: number;
  stepN: number;
  // Deslocamento e escala extras de efeito (comer, portal)
  fxX: number;
  fxY: number;
  fxSx: number;
  fxSy: number;
  portalT0: number;
  // Carga
  chOn: boolean;
  chT0: number;
  chSlot: number;
  chAcc: number;
  chUsed: boolean;
  // Escudo e Coroa
  shOn: boolean;
  shT0: number;
  crOn: boolean;
  /** acumuladores das auras contínuas */
  auraAcc: number;
  auraAcc2: number;
  /** some neste instante (lista dying) */
  dieAt: number;
  fadeMs: number;
  hidden: boolean;
}

/** Partícula com rampa de cor, escala inteira, troca de frame e moveTo próprios (sem alocar). */
export class FxParticle extends Phaser.GameObjects.Particles.Particle {
  seq: Phaser.Textures.Frame[] | null = null;
  c0 = 0xffffff;
  c1 = -1;
  c2 = -1;
  s0 = 1;
  s1 = 1;
  a0 = 1;
  a1 = 0;
  mt = false;
  mx = 0;
  my = 0;
  /** giro do moveTo (espiral) */
  sw = 0;
  spin = 0;

  update(delta: number, step: number, processors: Phaser.GameObjects.Particles.ParticleProcessor[]): boolean {
    if (this.mt && this.delayCurrent <= 0 && this.lifeCurrent > 0) {
      const ls = Math.max(this.lifeCurrent, 16) / 1000;
      const dx = (this.mx - this.x) / ls;
      const dy = (this.my - this.y) / ls;
      this.velocityX = dx - dy * this.sw;
      this.velocityY = dy + dx * this.sw;
    }
    const done = super.update(delta, step, processors);
    // Com atraso, fica invisível até nascer.
    if (this.delayCurrent > 0) {
      this.alpha = 0;
      return done;
    }
    const t = this.lifeT;
    const seq = this.seq;
    if (seq) this.frame = seq[Math.min(seq.length - 1, (t * seq.length) | 0)];
    const s = this.s0 === this.s1 ? this.s0 : this.s0 + Math.round((this.s1 - this.s0) * t);
    this.scaleX = this.scaleY = s;
    this.alpha = this.a0 + (this.a1 - this.a0) * t;
    if (this.c1 >= 0) this.tint = this.c2 >= 0 ? (t < 0.34 ? this.c0 : t < 0.67 ? this.c1 : this.c2) : t < 0.5 ? this.c0 : this.c1;
    if (this.spin > 0) this.angle = Math.floor((this.life - this.lifeCurrent) / this.spin) * 90;
    return done;
  }
}

/** Parâmetros do próximo burst: um objeto só, ajustado antes de cada emit. */
export class BurstParams {
  frame = 'p1';
  seq: Phaser.Textures.Frame[] | null = null;
  c0 = 0xffffff;
  c1 = -1;
  c2 = -1;
  pal: readonly number[] | null = null;
  spMin = 0;
  spMax = 0;
  angMin = 0;
  angMax = 360;
  /** nasce a esta distância do ponto, na direção do ângulo */
  rad = 0;
  jit = 0;
  lifeMin = 300;
  lifeMax = 300;
  vx = 0;
  vy = 0;
  ax = 0;
  ay = 0;
  s0 = 1;
  s1 = 1;
  a0 = 1;
  a1 = 0;
  mt = false;
  tx = 0;
  ty = 0;
  sw = 0;
  spin = 0;
  delay = 0;
  delayMin = 0;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const DEG = Math.PI / 180;

// Padrões de lampejo: durações alternadas [liga, desliga, liga, ...]
export const PAT_HIT = [50, 40, 40] as const;
export const PAT_RM = [120] as const;

interface NumSlot {
  t: Phaser.GameObjects.BitmapText;
  on: boolean;
  t0: number;
  x: number;
  y: number;
  dx: number;
  sc: number;
  id: number;
}

export class Fx {
  tier: Tier = 0;
  private ceiling: Tier = 0;
  private auto = true;
  /** prefers-reduced-motion */
  rm = false;
  /** você está lutando (bursts alheios ×0,3) */
  fighting = false;
  readonly P = new BurstParams();
  readonly spark: Phaser.GameObjects.Particles.ParticleEmitter;
  readonly magic: Phaser.GameObjects.Particles.ParticleEmitter;
  readonly ground: Phaser.GameObjects.Particles.ParticleEmitter;
  readonly pixels: Phaser.GameObjects.Particles.ParticleEmitter;
  readonly ring: Phaser.GameObjects.Particles.ParticleEmitter;
  readonly ringAir: Phaser.GameObjects.Particles.ParticleEmitter;
  readonly wisp: Phaser.GameObjects.Particles.ParticleEmitter;
  /** Carga: 4 emissores dedicados, um por bicho carregado */
  readonly charge: Phaser.GameObjects.Particles.ParticleEmitter[] = [];
  /** ambiente de bioma (registrados pelo módulo de bioma) */
  amb: Phaser.GameObjects.Particles.ParticleEmitter[] = [];
  /** chamado quando o tier muda */
  onTier: (() => void) | null = null;
  /** Caixas que os números não cobrem (nomes e barras): escreve [esq, topo, dir, base] em out e devolve quantas. */
  blockers: ((out: number[], max: number) => number) | null = null;
  private boxes: number[] = new Array<number>(4 * 72).fill(0);
  private readonly events: Phaser.GameObjects.Particles.ParticleEmitter[];
  // Instrumentação: picos de partículas vivas e quadros acima do teto
  peak = 0;
  peakEv = 0;
  peakAmb = 0;
  overCap = 0;
  /** worldView + 24 px, atualizado 1× por frame */
  readonly view = new Phaser.Geom.Rectangle();
  private aliveEv = 0;
  private frames = new Map<string, Phaser.Textures.Frame>();
  readonly SHRINK: Phaser.Textures.Frame[];
  readonly GROW: Phaser.Textures.Frame[];
  readonly GROW_BIG: Phaser.Textures.Frame[];
  private imgs: Phaser.GameObjects.Image[] = [];
  private imgBusy: boolean[] = [];
  private nums: NumSlot[] = [];
  private flashRect: Phaser.GameObjects.Rectangle;
  private flashT0 = -1e9;
  private flashMs = 0;
  private flashA = 0;
  private flashTimes = [-1e9, -1e9, -1e9];
  private fpsEma = 60;
  private lowN = 0;
  private highMs = 0;
  private lastSample = 0;
  private cooldownUntil = 0;
  private mq: MediaQueryList | null = null;

  constructor(private scene: Phaser.Scene) {
    buildFxAtlas(scene);
    const tex = scene.textures.get('fx');
    for (const name of tex.getFrameNames()) this.frames.set(name, tex.get(name));
    this.SHRINK = ['star', 'plus', 'p1'].map((n) => this.frame(n));
    this.GROW = ['ring3', 'ring5', 'ring8', 'ring12'].map((n) => this.frame(n));
    this.GROW_BIG = ['ring5', 'ring8', 'ring12'].map((n) => this.frame(n));
    const ADD = Phaser.BlendModes.ADD;
    const NORMAL = Phaser.BlendModes.NORMAL;
    this.spark = this.mk(890, ADD, 110);
    this.magic = this.mk(890, ADD, 60);
    this.ground = this.mk(8, NORMAL, 40);
    this.pixels = this.mk(890, NORMAL, 110);
    this.ring = this.mk(7, NORMAL, 12);
    this.ringAir = this.mk(890, ADD, 8);
    this.wisp = this.mk(6, ADD, 24);
    for (let i = 0; i < 4; i++) this.charge.push(this.mk(890, ADD, 20));
    this.events = [this.spark, this.magic, this.ground, this.pixels, this.ring, this.ringAir, ...this.charge];
    for (let i = 0; i < 24; i++) {
      this.imgs.push(scene.add.image(0, 0, 'fx', 'p1').setVisible(false).setDepth(890));
      this.imgBusy.push(false);
    }
    for (let i = 0; i < 8; i++) {
      const t = scene.add.bitmapText(0, 0, 'dmg-w', '').setOrigin(0.5, 1).setDepth(990).setVisible(false);
      this.nums.push({ t, on: false, t0: 0, x: 0, y: 0, dx: 0, sc: 1, id: 0 });
    }
    this.flashRect = scene.add.rectangle(0, 0, 10, 10, 0xffffff, 1).setOrigin(0, 0).setScrollFactor(0).setDepth(889).setVisible(false);
    try {
      this.mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.rm = this.mq.matches;
      this.mq.addEventListener('change', (e) => (this.rm = e.matches));
    } catch {
      this.rm = false;
    }
    this.readPrefs();
  }

  private mk(depth: number, blend: number, cap: number): Phaser.GameObjects.Particles.ParticleEmitter {
    return this.scene.add
      .particles(0, 0, 'fx', {
        frame: 'p1',
        emitting: false,
        lifespan: 300,
        speed: 0,
        reserve: cap,
        maxAliveParticles: cap,
        particleClass: FxParticle,
        blendMode: blend,
        emitCallback: this.onEmit,
        emitCallbackScope: this,
      })
      .setDepth(depth);
  }

  frame(name: string): Phaser.Textures.Frame {
    return this.frames.get(name)!;
  }

  // ---------------------------------------------------------------- tier

  /** Lê 'vb.fx' (a interface grava no menu) e decide o tier inicial. */
  readPrefs(): void {
    const r = this.scene.game.renderer;
    const nav = navigator as Navigator & { deviceMemory?: number };
    let ceiling: Tier = 0;
    if (!r || r.type !== Phaser.WEBGL) ceiling = 2;
    else if ((nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 3) ceiling = 1;
    this.ceiling = ceiling;
    let pref = 'auto';
    let stable: string | null = null;
    try {
      pref = localStorage.getItem('vb.fx') ?? 'auto';
      stable = localStorage.getItem('vb.fx.auto');
    } catch {
      /* armazenamento bloqueado */
    }
    const fixed = TIER_NAMES.indexOf(pref as (typeof TIER_NAMES)[number]);
    this.auto = fixed < 0;
    if (!this.auto) this.setTier(fixed as Tier);
    else {
      const st = TIER_NAMES.indexOf(stable as (typeof TIER_NAMES)[number]);
      this.setTier(Math.max(ceiling, st < 0 ? ceiling : st) as Tier);
    }
  }

  private setTier(t: Tier): void {
    this.tier = t;
    this.wisp.maxAliveParticles = CAPS[t].zone;
    if (CAPS[t].zone === 0) this.wisp.killAll();
    this.onTier?.();
  }

  /** Teto global de partículas vivas (ambiente + zona + eventos). */
  get cap(): number {
    return this.rm ? RM_CAP : CAPS[this.tier].total;
  }

  get ambCap(): number {
    return this.rm ? 0 : CAPS[this.tier].amb;
  }

  /** Amostra o FPS a cada 1000 ms e desce/sobe o tier no modo automático. */
  private sampleFps(now: number): void {
    if (now - this.lastSample < 1000) return;
    const dt = now - this.lastSample;
    this.lastSample = now;
    this.fpsEma = 0.3 * this.scene.game.loop.actualFps + 0.7 * this.fpsEma;
    if (!this.auto || now < this.cooldownUntil) return;
    if (this.fpsEma < 48) {
      this.highMs = 0;
      if (++this.lowN >= 3 && this.tier < 2) {
        this.lowN = 0;
        this.cooldownUntil = now + 5000;
        this.setTier((this.tier + 1) as Tier);
        this.store();
      }
    } else {
      this.lowN = 0;
      this.highMs = this.fpsEma > 57 ? this.highMs + dt : 0;
      if (this.highMs >= 12000 && this.tier > this.ceiling) {
        this.highMs = 0;
        this.cooldownUntil = now + 5000;
        this.setTier((this.tier - 1) as Tier);
        this.store();
      }
    }
  }

  private store(): void {
    try {
      localStorage.setItem('vb.fx.auto', TIER_NAMES[this.tier]);
    } catch {
      /* armazenamento bloqueado */
    }
  }

  get evCap(): number {
    return this.rm ? RM_CAP : CAPS[this.tier].ev;
  }

  get zoneCap(): number {
    return this.rm ? 0 : CAPS[this.tier].zone;
  }

  /** Pré-aquece os shaders ADD/MULTIPLY com 1 partícula invisível por emissor. */
  prewarm(): void {
    for (const em of [...this.events, this.wisp]) {
      const P = this.reset();
      P.a0 = P.a1 = 0;
      P.lifeMin = P.lifeMax = 16;
      em.emitParticleAt(-64, -64, 1);
    }
  }

  // ---------------------------------------------------------------- bursts

  /** Zera os parâmetros do burst e devolve o objeto para ajuste. */
  reset(): BurstParams {
    const P = this.P;
    P.frame = 'p1';
    P.seq = null;
    P.c0 = 0xffffff;
    P.c1 = P.c2 = -1;
    P.pal = null;
    P.spMin = P.spMax = 0;
    P.angMin = 0;
    P.angMax = 360;
    P.rad = P.jit = 0;
    P.lifeMin = P.lifeMax = 300;
    P.vx = P.vy = P.ax = P.ay = 0;
    P.s0 = P.s1 = 1;
    P.a0 = 1;
    P.a1 = 0;
    P.mt = false;
    P.tx = P.ty = 0;
    P.sw = 0;
    P.spin = 0;
    P.delay = P.delayMin = 0;
    return P;
  }

  private onEmit(p: Phaser.GameObjects.Particles.Particle): void {
    const q = p as FxParticle;
    const P = this.P;
    q.seq = P.seq;
    q.frame = P.seq ? P.seq[0] : this.frame(P.frame);
    const a = rnd(P.angMin, P.angMax) * DEG;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let sp = rnd(P.spMin, P.spMax);
    if (this.rm && sp > 30) sp = 30;
    q.velocityX = c * sp + P.vx;
    q.velocityY = s * sp + P.vy;
    q.accelerationX = P.ax;
    q.accelerationY = P.ay;
    if (P.rad) {
      q.x += Math.round(c * P.rad);
      q.y += Math.round(s * P.rad);
    }
    if (P.jit) {
      q.x += Math.round(rnd(-P.jit, P.jit));
      q.y += Math.round(rnd(-P.jit, P.jit));
    }
    q.life = q.lifeCurrent = rnd(P.lifeMin, P.lifeMax);
    q.delayCurrent = P.delay ? rnd(P.delayMin, P.delay) : 0;
    q.mt = P.mt;
    q.sw = P.sw;
    q.mx = P.tx;
    q.my = P.ty;
    q.s0 = P.s0;
    q.s1 = P.s1;
    q.a0 = P.a0;
    q.a1 = P.a1;
    q.c0 = P.pal ? P.pal[(Math.random() * P.pal.length) | 0] : P.c0;
    q.c1 = P.c1;
    q.c2 = P.c2;
    q.tint = q.c0;
    q.alpha = q.delayCurrent > 0 ? 0 : P.a0;
    q.scaleX = q.scaleY = P.s0;
    q.spin = P.spin;
    q.angle = q.rotation = 0;
  }

  /**
   * Emite n partículas com os parâmetros de P. Descarta fora da câmera,
   * multiplica pelo tier (×0,3 se é alheio e você luta) e corta pelo teto global.
   * O que envolve você (mine) nunca é cortado pelo teto.
   */
  emit(em: Phaser.GameObjects.Particles.ParticleEmitter, n: number, x: number, y: number, mine: boolean, raw = false, frac = 1): number {
    if (!mine && !this.view.contains(x, y)) return 0;
    if (!raw) {
      n *= MULT[this.tier];
      if (this.rm) n *= 0.4;
      if (!mine && this.fighting) n *= 0.3;
      n = mine ? Math.max(1, Math.round(n)) : Math.round(n);
    }
    // O que é seu usa o teto inteiro; o resto deixa 15% livres e corta pela prioridade (frac):
    // pegadas 0,5, rastros 0,65, auras 0,8, batalhas alheias 1.
    const cap = mine ? this.evCap : this.evCap * 0.85 * frac;
    n = Math.min(n, Math.floor(cap - this.aliveEv));
    if (n <= 0) return 0;
    em.emitParticleAt(x, y, n);
    this.aliveEv += n;
    return n;
  }

  /** Chamado 1× por frame antes dos efeitos. */
  preUpdate(now: number): void {
    const wv = this.scene.cameras.main.worldView;
    this.view.setTo(wv.x - 24, wv.y - 24, wv.width + 48, wv.height + 48);
    let n = 0;
    for (const em of this.events) n += em.getAliveParticleCount();
    this.aliveEv = n;
    this.sampleFps(now);
    this.updateFlash(now);
  }

  /** Total de partículas vivas (para testes). */
  alive(): number {
    return this.wisp.getAliveParticleCount() + this.aliveOf(this.events) + this.aliveOf(this.amb);
  }

  aliveOf(list: Phaser.GameObjects.Particles.ParticleEmitter[]): number {
    let n = 0;
    for (const em of list) n += em.getAliveParticleCount();
    return n;
  }

  resetPeaks(): void {
    this.peak = this.peakEv = this.peakAmb = this.overCap = 0;
  }

  killAll(): void {
    for (const em of this.events) em.killAll();
    for (const em of this.amb) em.killAll();
    this.wisp.killAll();
    for (let i = 0; i < this.imgs.length; i++) this.freeImage(this.imgs[i]);
    for (const s of this.nums) {
      s.on = false;
      s.t.setVisible(false);
    }
    this.flashRect.setVisible(false);
  }

  // ---------------------------------------------------------------- pools

  takeImage(frame = 'p1'): Phaser.GameObjects.Image | null {
    for (let i = 0; i < this.imgs.length; i++) {
      if (this.imgBusy[i]) continue;
      this.imgBusy[i] = true;
      return this.imgs[i].setTexture('fx', frame).setVisible(true).setAlpha(1).setScale(1).setAngle(0).setDepth(890).setOrigin(0.5).clearTint();
    }
    return null;
  }

  freeImage(img: Phaser.GameObjects.Image | null): null {
    if (!img) return null;
    const i = this.imgs.indexOf(img);
    if (i >= 0) this.imgBusy[i] = false;
    img.setVisible(false).setBlendMode(Phaser.BlendModes.NORMAL).setTintMode(Phaser.TintModes.MULTIPLY).clearTint();
    return null;
  }

  /**
   * Número de dano pixelado (pool de 8; esgotado, recicla o mais antigo). Nasce em y−16
   * com escala 2 e sobe até não encostar em nome, barra de HP ou outro número vivo.
   */
  number(font: string, text: string, x: number, y: number, sc: number, drift: number, id: number, now: number): void {
    let slot: NumSlot | null = null;
    let oldest: NumSlot = this.nums[0];
    for (const s of this.nums) {
      if (!s.on) slot ??= s;
      else if (s.t0 < oldest.t0) oldest = s;
    }
    slot ??= oldest;
    slot.on = false;
    const t = slot.t.setFont(`dmg-${font}`).setText(text).setScale(2);
    const bx = this.boxes;
    const max = bx.length / 4 - this.nums.length;
    let n = this.blockers ? Math.min(max, this.blockers(bx, max)) : 0;
    for (const o of this.nums) {
      if (!o.on) continue;
      const hw = o.t.width / 2;
      bx[n * 4] = o.t.x - hw;
      bx[n * 4 + 1] = o.t.y - o.t.height;
      bx[n * 4 + 2] = o.t.x + hw;
      bx[n * 4 + 3] = o.t.y;
      n++;
    }
    slot.on = true;
    slot.t0 = now;
    slot.x = Math.round(x);
    slot.y = Math.round(clearBottom(slot.x, t.width / 2, Math.round(y - 16), t.height, bx, n));
    slot.dx = drift;
    slot.sc = sc;
    slot.id = id;
    t.setAlpha(1).setVisible(true).setPosition(slot.x, slot.y);
  }

  private updateNumbers(now: number): void {
    const QO = Phaser.Math.Easing.Quadratic.Out;
    for (const s of this.nums) {
      if (!s.on) continue;
      const el = now - s.t0;
      if (el >= 800) {
        s.on = false;
        s.t.setVisible(false);
        continue;
      }
      if (el >= 80) s.t.setScale(s.sc);
      let dy: number;
      let dx: number;
      let a = 1;
      if (el < 450) {
        const k = QO(el / 450);
        dy = -10 * k;
        dx = s.dx * 3 * k;
      } else {
        dx = s.dx * 3;
        dy = -10;
        if (el > 600) {
          const k = (el - 600) / 200;
          dy -= 4 * k;
          a = 1 - k;
        }
      }
      s.t.setPosition(Math.round(s.x + dx), Math.round(s.y + dy)).setAlpha(a);
    }
  }

  // ---------------------------------------------------------------- lampejo de tela

  /** Lampejo de tela cheia: alpha de no máximo 0,35 e no máximo 3 por segundo. */
  screenFlash(color: number, alpha: number, ms: number, now: number): void {
    const oldest = Math.min(this.flashTimes[0], this.flashTimes[1], this.flashTimes[2]);
    if (now - oldest < 1000) return;
    const i = this.flashTimes.indexOf(oldest);
    this.flashTimes[i] = now;
    const cam = this.scene.cameras.main;
    this.flashT0 = now;
    this.flashMs = this.rm ? 120 : ms;
    this.flashA = Math.min(0.35, alpha);
    this.flashRect.setSize(cam.width, cam.height).setFillStyle(color, 1).setAlpha(this.flashA).setVisible(true);
  }

  private updateFlash(now: number): void {
    if (!this.flashRect.visible) return;
    const el = now - this.flashT0;
    if (el >= this.flashMs) this.flashRect.setVisible(false);
    else this.flashRect.setAlpha(this.flashA * (1 - el / this.flashMs));
  }

  /** Números e instrumentação: chamado no fim do update. */
  postUpdate(now: number): void {
    this.updateNumbers(now);
    const ev = this.aliveOf(this.events);
    const amb = this.aliveOf(this.amb);
    const total = ev + amb + this.wisp.getAliveParticleCount();
    if (total > this.peak) this.peak = total;
    if (ev > this.peakEv) this.peakEv = ev;
    if (amb > this.peakAmb) this.peakAmb = amb;
    if (total > this.cap) this.overCap++;
  }
}

// ---------------------------------------------------------------- estados na EntView

/** Lampejo FILL por padrão de durações; com reduced-motion vira um único tint de 120 ms. */
export function flash(v: EntView, color: number, pat: readonly number[], now: number, rm: boolean): void {
  v.flashPat = rm ? PAT_RM : pat;
  v.flashT0 = now;
  v.flashColor = color;
}

/** Empurrão de efeito: vai até (dx, dy) em outMs e volta em backMs. */
export function nudge(v: EntView, dx: number, dy: number, outMs: number, backMs: number, now: number, backEase = false): void {
  v.nx = dx;
  v.ny = dy;
  v.nT0 = now;
  v.nOut = outMs;
  v.nBack = backMs;
  v.nBackEase = backEase;
}

/** Squash: vai até (sx, sy) em inMs (em degraus se steps > 0), segura holdMs e volta em outMs. */
export function squash(v: EntView, sx: number, sy: number, inMs: number, holdMs: number, outMs: number, now: number, steps = 0): void {
  v.qx = sx;
  v.qy = sy;
  v.qT0 = now;
  v.qIn = inMs;
  v.qHold = holdMs;
  v.qOut = outMs;
  v.qSteps = steps;
}

export function pop(v: EntView, from: number, ms: number, now: number): void {
  v.popFrom = from;
  v.popT0 = now;
  v.popMs = ms;
}

const QO = Phaser.Math.Easing.Quadratic.Out;
const BO = Phaser.Math.Easing.Back.Out;

/** Calcula ox/oy, sx/sy, escala de pop, alpha e tint da EntView neste instante. Devolve a escala de pop. */
export function stepView(v: EntView, now: number, frozen: boolean, rm = false): number {
  // Empurrão
  const ne = now - v.nT0;
  if (ne < 0 || ne >= v.nOut + v.nBack) {
    v.ox = v.oy = 0;
  } else {
    const k = ne < v.nOut ? QO(ne / v.nOut) : 1 - (v.nBackEase ? BO((ne - v.nOut) / v.nBack) : QO((ne - v.nOut) / v.nBack));
    v.ox = Math.round(v.nx * k);
    v.oy = Math.round(v.ny * k);
  }
  if (v.koUntil > now && !rm) v.ox += (Math.floor(now / 50) & 1) * 2 - 1;
  // Squash (congelado pelo hitstop)
  if (!frozen) {
    const qe = now - v.qT0;
    let k = 0;
    if (qe >= 0) {
      if (qe < v.qIn) k = v.qSteps > 0 ? Math.ceil((qe / v.qIn) * v.qSteps) / v.qSteps : qe / v.qIn;
      else if (qe < v.qIn + v.qHold) k = 1;
      else if (qe < v.qIn + v.qHold + v.qOut) k = 1 - (qe - v.qIn - v.qHold) / v.qOut;
    }
    v.sx = 1 + (v.qx - 1) * k;
    v.sy = 1 + (v.qy - 1) * k;
  }
  // Pop
  let p = 1;
  const pe = now - v.popT0;
  if (pe >= 0 && pe < v.popMs) p = v.popFrom + (1 - v.popFrom) * BO(pe / v.popMs);
  // Alpha piscando (desmoronar): 1 → 0,4 três vezes em 360 ms
  let a = v.alpha;
  if (now < v.blinkUntil && !rm) a *= 1 - 0.6 * (((now - v.blinkT0) % 120) / 120);
  if (v.dieAt > 0 && v.fadeMs > 0) a *= Math.max(0, Math.min(1, (v.dieAt - now) / v.fadeMs));
  v.img.setAlpha(a);
  // Lampejo FILL
  let tint = -1;
  if (v.flashPat) {
    let e = now - v.flashT0;
    let on = true;
    let done = true;
    for (let i = 0; i < v.flashPat.length; i++) {
      if (e < v.flashPat[i]) {
        done = false;
        break;
      }
      e -= v.flashPat[i];
      on = !on;
    }
    if (done) v.flashPat = null;
    else if (on) tint = v.flashColor;
  }
  if (tint !== v.tintOn) {
    v.tintOn = tint;
    if (tint < 0) v.img.clearTint().setTintMode(Phaser.TintModes.MULTIPLY);
    else v.img.setTint(tint).setTintMode(Phaser.TintModes.FILL);
  }
  return p;
}

/** O que os módulos de efeito precisam da cena. */
export interface FxHost {
  readonly fx: Fx;
  readonly groundG: Phaser.GameObjects.Graphics;
  readonly airG: Phaser.GameObjects.Graphics;
  view(id: number): EntView | undefined;
  /** id seguido pela câmera: você, ou quem você assiste */
  focusId(): number;
  /** seu id (-1 sem jogador) */
  meId(): number;
  /** batalha que o painel está mostrando (os números dela ficam no painel) */
  panelBattle(): number | null;
  addTrauma(v: number): void;
  punch(amt: number, inMs: number, outMs: number): void;
  texFor(e: Pick<EntSnap, 'f' | 's' | 'o'>): string;
  /** centro e raio da zona em px de mundo */
  zoneWorld(): { x: number; y: number; r: number };
  /** contador de fillRect do groundG neste frame (teto 220) */
  groundBudget: number;
  readonly overG: Phaser.GameObjects.Graphics;
  readonly auraBackG: Phaser.GameObjects.Graphics;
  /** contadores do overG (teto 160) e do auraBackG (teto 120) */
  overBudget: number;
  backBudget: number;
  /** elemento do tile (0 brasa, 1 maré, 2 broto; -1 rocha ou fora) */
  biomeAt(x: number, y: number): number;
  /** jogador parado no tile */
  playerAt(x: number, y: number): EntView | undefined;
}

// ---------------------------------------------------------------- desenho pixelado

/** Elipse de pontos 1×1 (n pontos, com Math.round), dentro do teto do groundG. */
export function dotEllipse(h: FxHost, cx: number, cy: number, rx: number, ry: number, n: number, rot: number, color: number, alpha: number): void {
  if (rx < 0.5 || h.groundBudget + n > 220) return;
  h.groundBudget += n;
  const g = h.groundG;
  g.fillStyle(color, alpha);
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    g.fillRect(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), 1, 1);
  }
}

/**
 * Anel elíptico contínuo de 1 px desenhado por faixas de linha (4 fillRect por linha):
 * metade esquerda na cor cl e direita na cr. Devolve quantos retângulos usou.
 */
export function spanEllipse(g: Phaser.GameObjects.Graphics, cx: number, cy: number, rx: number, ry: number, cl: number, cr: number, alpha: number, budget: number): number {
  const R = Math.round(ry);
  if (rx < 1 || R < 1) return 0;
  const need = (R + 1) * 4;
  if (need > budget) return 0;
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  let prev = Math.round(rx);
  // Da linha do meio (i = 0) até o topo/base (i = R).
  for (let i = 0; i <= R; i++) {
    const k = i < R ? (i + 1) / (R + 0.5) : 1;
    const next = i < R ? Math.round(rx * Math.sqrt(Math.max(0, 1 - k * k))) : 0;
    // Na última linha a faixa fecha o topo/base até o centro.
    const wl = i === R ? prev + 1 : Math.max(1, prev - next);
    const wr = i === R ? prev : wl;
    g.fillStyle(cl, alpha);
    g.fillRect(x0 - prev, y0 - i, wl, 1);
    if (i) g.fillRect(x0 - prev, y0 + i, wl, 1);
    g.fillStyle(cr, alpha);
    g.fillRect(x0 + prev - wr + 1, y0 - i, wr, 1);
    if (i) g.fillRect(x0 + prev - wr + 1, y0 + i, wr, 1);
    prev = next;
  }
  return need;
}
