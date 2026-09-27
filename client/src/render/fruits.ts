import Phaser from 'phaser';
import type { Elem, Fruit, Snap } from '@vb/shared';
import type { FxHost } from './fx';
import { ELEM_FRAME, ELEM_RAMP, FXC } from './fxpalette';
import { TILE, drawFruit } from './map';

/**
 * Frutas raras encantadas: glifo pontilhado no chão, brilhos e aura do elemento;
 * explosão de coleta com runas e '+3' em quem comeu; estria de luz no renascimento.
 * O diff usa dois Sets reaproveitados, alternados entre snapshots.
 */

interface FruitFx {
  f: Fruit;
  img: Phaser.GameObjects.Image;
  glyph: Phaser.GameObjects.Image;
  acc: number;
  twinkle: number;
  /** renascimento: estria (250 ms) e crescimento (300 ms) */
  rsT0: number;
  streak: Phaser.GameObjects.Image | null;
  /** coleta: 3 runas subindo 16 px em 500 ms */
  eatT0: number;
  runes: (Phaser.GameObjects.Image | null)[];
}

const BO = Phaser.Math.Easing.Back.Out;
const center = (t: number) => t * TILE + TILE / 2;
const EVERY: Record<Elem, number> = { brasa: 300, mare: 500, broto: 400 };
const FONT: Record<Elem, string> = { brasa: 'brasa', mare: 'mare', broto: 'broto' };

export class Fruits {
  private list: FruitFx[] = [];
  private setA = new Set<number>();
  private setB = new Set<number>();
  private cur = this.setA;
  private glyphTween: Phaser.Tweens.Tween | null = null;
  private readonly TWINKLE: Phaser.Textures.Frame[];
  private readonly SHRINK_RING: Phaser.Textures.Frame[];

  constructor(
    private scene: Phaser.Scene,
    private host: FxHost,
  ) {
    const fx = host.fx;
    this.TWINKLE = [fx.frame('p1'), fx.frame('plus'), fx.frame('star'), fx.frame('p1')];
    this.SHRINK_RING = [fx.frame('ring12'), fx.frame('ring8'), fx.frame('ring5'), fx.frame('ring3')];
  }

  setWorld(fruits: Fruit[]): void {
    this.clear();
    const scene = this.scene;
    for (const f of fruits) {
      const key = `fruit-${f.elem}`;
      if (!scene.textures.exists(key)) scene.textures.addCanvas(key, drawFruit(f.elem));
      const gk = `fglyph-${f.elem}`;
      if (!scene.textures.exists(gk)) scene.textures.addCanvas(gk, glyphCanvas(ELEM_RAMP[f.elem][0]));
      const img = scene.add.image(center(f.x), center(f.y), key).setDepth(3);
      scene.tweens.add({ targets: img, y: img.y - 2, yoyo: true, repeat: -1, duration: 700, ease: 'Sine.easeInOut' });
      const glyph = scene.add.image(center(f.x), center(f.y) + 5, gk).setDepth(2).setAlpha(0.3);
      this.list.push({ f, img, glyph, acc: Math.random() * 300, twinkle: 400 + Math.random() * 400, rsT0: -1, streak: null, eatT0: -1, runes: [null, null, null] });
    }
    // Um único tween compartilhado por todos os glifos: alpha 0,3↔0,6 em 1400 ms.
    if (this.list.length) {
      this.glyphTween = scene.tweens.add({ targets: this.list.map((l) => l.glyph), alpha: 0.6, yoyo: true, repeat: -1, duration: 700, ease: 'Sine.easeInOut' });
    }
    this.setA.clear();
    this.setB.clear();
  }

  clear(): void {
    const fx = this.host.fx;
    this.glyphTween?.remove();
    this.glyphTween = null;
    for (const l of this.list) {
      this.scene.tweens.killTweensOf(l.img);
      l.img.destroy();
      l.glyph.destroy();
      l.streak = fx.freeImage(l.streak);
      for (let i = 0; i < 3; i++) l.runes[i] = fx.freeImage(l.runes[i]);
    }
    this.list = [];
  }

  /** Diff de s.fr: índice sumiu = comida (quem comeu é o jogador no tile); voltou = renasceu. */
  onSnap(s: Snap, now: number, skip: boolean): void {
    const prev = this.cur;
    const next = prev === this.setA ? this.setB : this.setA;
    next.clear();
    for (const i of s.fr) next.add(i);
    this.cur = next;
    for (let i = 0; i < this.list.length; i++) {
      const l = this.list[i];
      const has = next.has(i);
      const had = prev.has(i);
      if (!skip && had && !has) this.eaten(l, now);
      else if (!skip && !had && has) {
        l.rsT0 = now;
        l.streak = this.host.fx.takeImage('p12');
        l.streak?.setTint(ELEM_RAMP[l.f.elem][0]).setBlendMode(Phaser.BlendModes.ADD).setScale(1, 3).setVisible(false);
      }
      if (l.rsT0 < 0) {
        l.img.setVisible(has);
        l.glyph.setVisible(has);
      }
    }
  }

  private eaten(l: FruitFx, now: number): void {
    const h = this.host;
    const fx = h.fx;
    const x = l.img.x;
    const y = center(l.f.y);
    const e = l.f.elem;
    const r = ELEM_RAMP[e];
    const who = h.playerAt(l.f.x, l.f.y);
    const mine = !!who && who.data.id === h.focusId();
    let P = fx.reset();
    P.frame = e === 'brasa' ? 'p2' : ELEM_FRAME[e];
    P.pal = r;
    P.spMin = 30;
    P.spMax = 50;
    P.lifeMin = P.lifeMax = 400;
    fx.emit(e === 'brasa' ? fx.spark : fx.pixels, 20, x, y, mine);
    P = fx.reset();
    P.frame = 'ring8';
    P.c0 = r[0];
    P.lifeMin = P.lifeMax = 300;
    fx.emit(fx.ringAir, 1, x, y, mine, true);
    l.eatT0 = now;
    for (let i = 0; i < 3; i++) {
      l.runes[i] = fx.freeImage(l.runes[i]);
      l.runes[i] = fx.takeImage(`rune${i}`)?.setTint(r[0]).setBlendMode(Phaser.BlendModes.ADD).setVisible(false) ?? null;
    }
    if (!who) return;
    // No tile da fruta: é onde quem comeu está chegando.
    fx.number(FONT[e], '+3', x, y - 4, 1, 0, who.data.id, now);
    // Espiral ascendente: 12 partículas numa hélice de r 8 em 600 ms.
    P = fx.reset();
    P.c0 = r[0];
    P.vy = -14;
    P.lifeMin = P.lifeMax = 260;
    for (let i = 0; i < 12; i++) {
      const a = (i / 6) * Math.PI * 2;
      P.delayMin = P.delay = i * 50;
      fx.emit(fx.spark, 1, x + Math.cos(a) * 8, y + 4 - i * 1.5, mine, true);
    }
  }

  update(now: number, delta: number): void {
    const h = this.host;
    const fx = h.fx;
    for (const l of this.list) {
      const x = l.img.x;
      const y = center(l.f.y);
      const r = ELEM_RAMP[l.f.elem];
      // Coleta: runas subindo.
      if (l.eatT0 >= 0) {
        const k = (now - l.eatT0) / 500;
        for (let i = 0; i < 3; i++) {
          const rn = l.runes[i];
          if (!rn) continue;
          if (k >= 1) l.runes[i] = fx.freeImage(rn);
          else rn.setVisible(true).setPosition(Math.round(x + (i - 1) * 7), Math.round(y - 4 - 16 * k)).setAlpha(1 - k * k);
        }
        if (k >= 1) l.eatT0 = -1;
      }
      // Renascimento: estria de luz cai de y−40 em 250 ms, depois a fruta cresce 0→1 (Back.easeOut, 300 ms).
      if (l.rsT0 >= 0) {
        const e = now - l.rsT0;
        if (e < 250) {
          l.img.setVisible(false);
          l.glyph.setVisible(false);
          l.streak?.setVisible(true).setPosition(Math.round(x), Math.round(y - 40 + (40 * e) / 250));
        } else {
          if (l.streak) {
            l.streak = fx.freeImage(l.streak);
            let P = fx.reset();
            P.frame = 'plus';
            P.c0 = r[0];
            P.spMin = 30;
            P.spMax = 50;
            P.lifeMin = P.lifeMax = 350;
            fx.emit(fx.spark, 8, x, y, false, true);
            P = fx.reset();
            P.seq = this.SHRINK_RING;
            P.c0 = r[0];
            P.lifeMin = P.lifeMax = 300;
            fx.emit(fx.ring, 1, x, y + 4, false, true);
          }
          const k = Math.min(1, (e - 250) / 300);
          l.img.setVisible(true).setScale(BO(k));
          l.glyph.setVisible(true);
          if (k >= 1) {
            l.rsT0 = -1;
            l.img.setScale(1);
          }
        }
      }
      if (!l.img.visible || !fx.view.contains(x, y) || fx.rm) continue;
      // Brilho: uma estrela pisca a até 8 px a cada 600 ± 200 ms.
      l.twinkle -= delta;
      if (l.twinkle <= 0) {
        l.twinkle = 400 + Math.random() * 400;
        const P = fx.reset();
        P.seq = this.TWINKLE;
        P.c0 = r[0];
        P.jit = 8;
        P.a1 = 1;
        P.lifeMin = P.lifeMax = 400;
        fx.emit(fx.spark, 1, x, y - 2, false, true, 0.8);
      }
      // Aura por tipo.
      l.acc += delta;
      const every = EVERY[l.f.elem];
      if (l.acc < every) continue;
      l.acc -= every;
      const P = fx.reset();
      P.jit = 4;
      if (l.f.elem === 'brasa') {
        P.c0 = r[0];
        P.c1 = r[1];
        P.c2 = r[2];
        P.vy = -14;
        P.lifeMin = P.lifeMax = 700;
        fx.emit(fx.spark, 1, x, y - 2, false, true, 0.8);
      } else if (l.f.elem === 'mare') {
        P.frame = 'bubble';
        P.c0 = r[0];
        P.vy = -14;
        P.a0 = 0.9;
        P.a1 = 0.6;
        P.lifeMin = P.lifeMax = 500;
        if (!fx.emit(fx.pixels, 1, x, y - 2, false, true, 0.8)) continue;
        const Q = fx.reset();
        Q.c0 = r[0];
        Q.spMin = 15;
        Q.spMax = 25;
        Q.delayMin = Q.delay = 500;
        Q.lifeMin = Q.lifeMax = 200;
        fx.emit(fx.pixels, 3, x, y - 9, false, true, 0.8);
      } else {
        P.frame = 'leaf';
        P.c0 = FXC.petal;
        P.vx = 6;
        P.vy = 10;
        P.spin = 120;
        P.lifeMin = P.lifeMax = 900;
        fx.emit(fx.pixels, 1, x, y - 8, false, true, 0.8);
      }
    }
  }
}

/** Glifo do chão: elipse pontilhada 12×5 na cor clara do elemento. */
function glyphCanvas(color: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 13;
  c.height = 6;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ctx.fillRect(Math.round(6 + Math.cos(a) * 6), Math.round(2.5 + Math.sin(a) * 2.5), 1, 1);
  }
  return c;
}

