import Phaser from 'phaser';
import { ROCK, type Snap } from '@vb/shared';
import type { FxHost } from './fx';
import { FXC } from './fxpalette';
import { DECOR, TILE } from './map';

/**
 * Mundo que respira: brasas, bolhas e pólen só nos tiles visíveis de cada bioma,
 * com o mesmo vento do chão vivo; no Duelo Final caem cinzas. E o chão vivo:
 * decorações do mapa numa SpriteGPULayer (grama com vento, água cintilando, lava respirando).
 */

/** Vento global em px/s (o mesmo do chão vivo). */
export const wind = (ms: number): number => 5 + 3 * Math.sin(ms / 7000);

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const CAP = 4096;
// Tetos por emissor [alto, médio]: somam no máximo 70 e 35 (teto do ambiente).
const MAX = { brasa: [26, 13], mare: [14, 7], broto: [30, 15], ash: [22, 10] } as const;
const FREQ = { brasa: [160, 320], mare: [260, 520], broto: [200, 400], ash: [110, 220] } as const;
const ASH_PAL = [FXC.stone, FXC.ash, FXC.soot] as const;

/** Tiles de um bioma dentro da câmera (+1 de margem); sorteia um ponto sem alocar. */
class BiomeSource {
  xs = new Int16Array(CAP);
  ys = new Int16Array(CAP);
  n = 0;
  getRandomPoint(p: Phaser.Types.Math.Vector2Like): Phaser.Types.Math.Vector2Like {
    if (this.n === 0) {
      p.x = p.y = -999;
      return p;
    }
    const i = (Math.random() * this.n) | 0;
    p.x = (this.xs[i] + Math.random()) * TILE;
    p.y = (this.ys[i] + Math.random()) * TILE;
    return p;
  }
}

/** Faixa no topo da vista (cinzas do Duelo). */
class TopSource {
  constructor(private cam: Phaser.Cameras.Scene2D.Camera) {}
  getRandomPoint(p: Phaser.Types.Math.Vector2Like): Phaser.Types.Math.Vector2Like {
    const wv = this.cam.worldView;
    p.x = wv.x - 16 + Math.random() * (wv.width + 32);
    p.y = wv.y - 4 + Math.random() * 8;
    return p;
  }
}

export class Biome {
  readonly ambBrasa: Phaser.GameObjects.Particles.ParticleEmitter;
  readonly ambMare: Phaser.GameObjects.Particles.ParticleEmitter;
  readonly ambBroto: Phaser.GameObjects.Particles.ParticleEmitter;
  private src = [new BiomeSource(), new BiomeSource(), new BiomeSource()];
  private top: TopSource;
  private tiles: Uint8Array = new Uint8Array(0);
  private w = 0;
  private h = 0;
  private wx0 = -1;
  private wy0 = -1;
  private wx1 = -1;
  private wy1 = -1;
  private duel = false;
  private mode = -1;
  private layers: Phaser.GameObjects.SpriteGPULayer[] | null = null;
  private pollenCfg: Phaser.Types.GameObjects.Particles.ParticleEmitterConfig;
  private ashCfg: Phaser.Types.GameObjects.Particles.ParticleEmitterConfig;

  constructor(
    private scene: Phaser.Scene,
    private host: FxHost,
  ) {
    const fx = host.fx;
    const t = () => scene.time.now;
    const [sb, sm, sp] = this.src;
    this.top = new TopSource(scene.cameras.main);
    this.ambBrasa = scene.add
      .particles(0, 0, 'fx', {
        frame: ['p1', 'p21'],
        emitting: false,
        frequency: 160,
        lifespan: { min: 1400, max: 2200 },
        speedX: { onEmit: () => rnd(-3, 3) + wind(t()) * 0.3 },
        speedY: { min: -14, max: -6 },
        color: [0xffd27a, 0xff7a3d, 0xb8400f],
        colorEase: 'Linear',
        alpha: { start: 0.9, end: 0 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: MAX.brasa[0],
        reserve: MAX.brasa[0],
        emitZone: { type: 'random', source: sb },
      })
      .setDepth(4);
    this.ambMare = scene.add
      .particles(0, 0, 'fx', {
        frame: 'bubble',
        emitting: false,
        frequency: 260,
        lifespan: { min: 900, max: 1300 },
        speedX: 0,
        speedY: { min: -8, max: -4 },
        tint: FXC.blueL,
        alpha: { start: 0.7, end: 0 },
        maxAliveParticles: MAX.mare[0],
        reserve: MAX.mare[0],
        emitZone: { type: 'random', source: sm },
        // Só no alto: a bolha estoura em 1 pixel.
        deathCallback: (p: Phaser.GameObjects.Particles.Particle) => {
          if (fx.tier !== 0) return;
          const P = fx.reset();
          P.c0 = FXC.blueL;
          P.spMin = 8;
          P.spMax = 16;
          P.lifeMin = P.lifeMax = 160;
          fx.emit(fx.pixels, 1, p.x, p.y, false, true, 0.3);
        },
      })
      .setDepth(4);
    this.pollenCfg = {
      frame: ['p1', 'p1', 'p1', 'p1', 'leaf'],
      emitting: false,
      frequency: 200,
      lifespan: { min: 2600, max: 3600 },
      // 1 em cada 5 é uma folha caindo; o resto é pólen ao vento.
      speedX: { onEmit: (p?: Phaser.GameObjects.Particles.Particle) => wind(t()) + (p?.frame.name === 'leaf' ? rnd(-2, 2) : rnd(0, 5)) },
      speedY: { onEmit: (p?: Phaser.GameObjects.Particles.Particle) => (p?.frame.name === 'leaf' ? rnd(6, 10) : rnd(-2, 3)) },
      tint: {
        onEmit: (p?: Phaser.GameObjects.Particles.Particle) =>
          p?.frame.name === 'leaf' ? (Math.random() < 0.5 ? 0x52c95f : 0x17803a) : Math.random() < 0.5 ? 0xd2f7b8 : FXC.blossom,
      },
      alpha: { values: [0, 0.8, 0], interpolation: 'linear' },
      maxAliveParticles: MAX.broto[0],
      reserve: MAX.ash[0] + MAX.broto[0],
      emitZone: { type: 'random', source: sp },
    };
    this.ashCfg = {
      frame: ['p1', 'p21'],
      emitting: false,
      frequency: 110,
      lifespan: 2600,
      speedX: { onEmit: () => wind(t()) + rnd(-2, 2) },
      speedY: { min: 10, max: 16 },
      tint: { onEmit: () => ASH_PAL[(Math.random() * 3) | 0] },
      alpha: { start: 0.7, end: 0 },
      maxAliveParticles: MAX.ash[0],
      emitZone: { type: 'random', source: this.top },
    };
    this.ambBroto = scene.add.particles(0, 0, 'fx', this.pollenCfg).setDepth(4);
    fx.amb = [this.ambBrasa, this.ambMare, this.ambBroto];
    fx.onTier = () => {
      this.mode = -1;
    };
  }

  /** Guarda os tiles da partida. Devolve false quando o chão vivo vai para a GPU (o mapa não assa as decorações). */
  setWorld(w: number, h: number, tiles: Uint8Array): boolean {
    this.tiles = tiles;
    this.w = w;
    this.h = h;
    this.wx0 = this.wy0 = this.wx1 = this.wy1 = -1;
    this.setDuel(false);
    this.mode = -1;
    const fx = this.host.fx;
    return !(fx.tier < 2 && this.scene.game.renderer.type === Phaser.WEBGL);
  }

  /** Elemento do tile (0 brasa, 1 maré, 2 broto) ou -1 fora do mapa ou na rocha. */
  biomeAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    const t = this.tiles[y * this.w + x];
    return t === ROCK ? -1 : t;
  }

  clear(): void {
    for (const em of this.host.fx.amb) em.stop(true);
    this.layers?.forEach((l) => l.setVisible(false));
    this.setDuel(false);
  }

  private setDuel(on: boolean): void {
    if (on === this.duel) return;
    this.duel = on;
    const em = this.ambBroto;
    em.killAll();
    em.emitZones.length = 0;
    em.setConfig(on ? this.ashCfg : this.pollenCfg);
    this.mode = -1;
    this.layers?.forEach((l) => l.setAlpha(on ? 0.6 : 1));
  }

  update(s: Snap, fighting: boolean): void {
    const fx = this.host.fx;
    this.setDuel(s.ph === 'duelo');
    // Pausado no tier baixo e com reduced-motion; no Duelo só caem as cinzas.
    const on = !fx.rm && fx.tier < 2;
    const tier = fx.tier === 0 ? 0 : 1;
    const mode = (on ? 1 : 0) | (tier << 1) | (fighting ? 4 : 0) | (this.duel ? 8 : 0);
    if (mode !== this.mode) {
      this.mode = mode;
      const slow = fighting ? 2.5 : 1;
      if (!on) for (const em of fx.amb) em.stop(true);
      else if (this.duel) {
        this.ambBrasa.stop();
        this.ambMare.stop();
        this.ambBroto.frequency = FREQ.ash[tier];
        this.ambBroto.maxAliveParticles = MAX.ash[tier];
        this.ambBroto.emitting = true;
      } else {
        this.ambBrasa.frequency = FREQ.brasa[tier] * slow;
        this.ambMare.frequency = FREQ.mare[tier] * slow;
        this.ambBroto.frequency = FREQ.broto[tier] * slow;
        this.ambBrasa.maxAliveParticles = MAX.brasa[tier];
        this.ambMare.maxAliveParticles = MAX.mare[tier];
        this.ambBroto.maxAliveParticles = MAX.broto[tier];
        this.wx0 = -1;
      }
    }
    if (!on || this.duel) return;
    // Janela de tiles da câmera (+1): a lista só é refeita quando ela muda.
    const wv = this.scene.cameras.main.worldView;
    const x0 = Math.max(0, Math.floor(wv.x / TILE) - 1);
    const y0 = Math.max(0, Math.floor(wv.y / TILE) - 1);
    const x1 = Math.min(this.w - 1, Math.floor(wv.right / TILE) + 1);
    const y1 = Math.min(this.h - 1, Math.floor(wv.bottom / TILE) + 1);
    if (x0 === this.wx0 && y0 === this.wy0 && x1 === this.wx1 && y1 === this.wy1) return;
    this.wx0 = x0;
    this.wy0 = y0;
    this.wx1 = x1;
    this.wy1 = y1;
    const [sb, sm, sp] = this.src;
    sb.n = sm.n = sp.n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = this.tiles[y * this.w + x];
        if (t === ROCK) continue;
        const src = this.src[t];
        if (src.n >= CAP) continue;
        src.xs[src.n] = x;
        src.ys[src.n] = y;
        src.n++;
      }
    }
    this.ambBrasa.emitting = sb.n > 0;
    this.ambMare.emitting = sm.n > 0;
    this.ambBroto.emitting = sp.n > 0;
  }

  // ---------------------------------------------------------------- chão vivo

  /** Monta as duas SpriteGPULayer (normal em 1, ADD em 2) com a lista de decorações do mapa. */
  buildDecor(decor: number[]): void {
    const scene = this.scene;
    decorTexture(scene);
    if (!this.layers) {
      const a = scene.add.spriteGPULayer('decor', 1).setDepth(1);
      const b = scene.add.spriteGPULayer('decor', 1).setDepth(2).setBlendMode(Phaser.BlendModes.ADD);
      a.setAnimations([{ name: 'sway', frames: ['tuftS', 'tuftR', 'tuftS', 'tuftL'], duration: 2000 }]);
      this.layers = [a, b];
    }
    const [norm, add] = this.layers;
    let nn = 0;
    for (let i = 0; i < decor.length; i += 3) if (decor[i] === DECOR.tuft) nn++;
    norm.resize(Math.max(1, nn), true);
    add.resize(Math.max(1, decor.length / 3 - nn), true);
    const rm = this.host.fx.rm;
    // Um único objeto membro, reaproveitado em todos os addMember.
    const M: Partial<Phaser.Types.GameObjects.SpriteGPULayer.Member> & { alpha: number | Phaser.Types.GameObjects.SpriteGPULayer.MemberAnimation } = { x: 0, y: 0, originX: 0, originY: 0, frame: 'tuftS', alpha: 1 };
    const sway: Phaser.Types.GameObjects.SpriteGPULayer.MemberAnimation & { base: string } = { base: 'sway', duration: 2000, delay: 0 } as never;
    const pulse = { base: 0.35, amplitude: 0.6, duration: 900, ease: 'Sine.easeInOut', yoyo: true, delay: 0 };
    for (let i = 0; i < decor.length; i += 3) {
      const k = decor[i];
      const x = decor[i + 1];
      const y = decor[i + 2];
      M.x = x;
      M.y = y;
      if (k === DECOR.tuft) {
        M.frame = 'tuftS';
        M.alpha = 1;
        // Onda de vento cruzando o bioma na diagonal.
        sway.delay = (x * 60 + y * 25) % 2000;
        M.animation = rm ? undefined : (sway as never);
        norm.addMember(M);
        continue;
      }
      M.animation = undefined;
      const hsh = ((x * 73856093) ^ (y * 19349663)) >>> 0;
      if (k === DECOR.glint) {
        M.frame = 'glint';
        pulse.base = 0;
        pulse.amplitude = 0.85;
        pulse.duration = 600 + (hsh % 400);
      } else {
        M.frame = k === DECOR.crack ? 'crack' : 'mark';
        pulse.base = 0.35;
        pulse.amplitude = 0.6;
        pulse.duration = 900;
      }
      pulse.delay = hsh % 2000;
      M.alpha = rm ? pulse.base + pulse.amplitude / 2 : pulse;
      add.addMember(M);
    }
    for (const l of this.layers) l.setVisible(true).setAlpha(1);
  }

  hideDecor(): void {
    this.layers?.forEach((l) => l.setVisible(false));
  }
}

/** Textura 'decor' 16×16 (potência de 2): tufos em 3 quadros, brilho da água, marca e rachadura de lava. */
function decorTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists('decor')) return;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  const put = (rows: string[], ox: number, oy: number, color: string) => {
    ctx.fillStyle = color;
    rows.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) if (r[x] === 'x') ctx.fillRect(ox + x, oy + y, 1, 1);
    });
  };
  const grass = '#9be36b';
  put(['..x.', 'x.x.', 'x.x.'], 0, 0, grass);
  put(['...x', '.xx.', 'x.x.'], 4, 0, grass);
  put(['.x..', 'x.x.', 'x.x.'], 8, 0, grass);
  put(['xx'], 12, 0, '#ff8c42');
  put(['xx'], 12, 2, '#c4e6ff');
  put(['xxxxxx...', '.....xxxx'], 0, 4, '#ff8c42');
  const tex = scene.textures.addCanvas('decor', c)!;
  tex.add('tuftS', 0, 0, 0, 4, 3);
  tex.add('tuftR', 0, 4, 0, 4, 3);
  tex.add('tuftL', 0, 8, 0, 4, 3);
  tex.add('mark', 0, 12, 0, 2, 1);
  tex.add('glint', 0, 12, 2, 2, 1);
  tex.add('crack', 0, 0, 4, 9, 2);
}
