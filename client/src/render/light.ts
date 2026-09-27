import Phaser from 'phaser';
import { BALANCE, type Snap } from '@vb/shared';
import type { EntView, FxHost } from './fx';
import { FXC } from './fxpalette';

/**
 * Luz da partida: shade MULTIPLY (crepúsculo pelas fases), vinheta pontilhada Bayer 4×4
 * e halo ADD no seu bicho. No Duelo Final o céu avermelha e a vinheta bate como coração.
 * Três quads criados uma vez, todos abaixo de 890 (feitiços, barras e nomes não escurecem).
 */

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const C_COLETA = 0xffffff;
const C_CACADA = 0xd9c8ff;
const C_FINAL = 0xb8a4e0;
const MAX_TEX = 480;

const lerpRgb = (a: number, b: number, t: number): number => {
  const k = Math.max(0, Math.min(1, t));
  const r = ((a >> 16) & 255) + ((((b >> 16) & 255) - ((a >> 16) & 255)) * k);
  const g = ((a >> 8) & 255) + ((((b >> 8) & 255) - ((a >> 8) & 255)) * k);
  const bl = (a & 255) + (((b & 255) - (a & 255)) * k);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
};

/** Batimento do Duelo: base 0,28, batida até 0,50 (80 ms sobe, 200 ms desce) e outra até 0,40 aos 300 ms. */
export function heartbeat(ms: number): number {
  const p = ms % 1000;
  if (p < 80) return 0.28 + 0.22 * (p / 80);
  if (p < 280) return 0.5 - 0.22 * ((p - 80) / 200);
  if (p < 300) return 0.28;
  if (p < 380) return 0.28 + 0.12 * ((p - 300) / 80);
  if (p < 580) return 0.4 - 0.12 * ((p - 380) / 200);
  return 0.28;
}

export class Light {
  private shade: Phaser.GameObjects.Rectangle;
  private vig: Phaser.GameObjects.Image;
  private halos: Phaser.GameObjects.Image[] = [];
  private color = C_COLETA;
  private target = C_COLETA;
  private vigBase = 0.18;
  private phase = '';
  private pulseT0 = -1e9;
  private duelT0 = -1;
  private duelFrom = C_COLETA;
  private vigScale = 1;

  constructor(
    private scene: Phaser.Scene,
    private host: FxHost,
  ) {
    this.shade = scene.add.rectangle(0, 0, 1, 1, 0xffffff, 1).setOrigin(0, 0).setBlendMode(Phaser.BlendModes.MULTIPLY).setDepth(880);
    haloTexture(scene);
    this.vig = scene.add.image(0, 0, '__WHITE').setDepth(882).setTint(FXC.night).setVisible(false);
    for (let i = 0; i < 2; i++) this.halos.push(scene.add.image(0, 0, 'halo').setDepth(884).setBlendMode(Phaser.BlendModes.ADD).setTint(FXC.cream).setAlpha(0.1).setVisible(false));
    this.resize();
  }

  reset(): void {
    this.color = this.target = C_COLETA;
    this.shade.setFillStyle(C_COLETA, 1);
    this.phase = '';
    this.pulseT0 = -1e9;
    this.duelT0 = -1;
    this.vig.setVisible(false);
    for (const h of this.halos) h.setVisible(false);
  }

  /** Regera a vinheta com 1,5× o worldView (no máximo 480×480, escala inteira). */
  resize(): void {
    const cam = this.scene.cameras.main;
    const w = (cam.width / cam.zoom) * 1.5;
    const h = (cam.height / cam.zoom) * 1.5;
    const s = Math.max(1, Math.ceil(Math.max(w, h) / MAX_TEX));
    const tw = Math.ceil(w / s);
    const th = Math.ceil(h / s);
    const key = 'vig';
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    this.scene.textures.addCanvas(key, vignetteCanvas(tw, th));
    this.vig.setTexture(key).setScale(s);
    this.vigScale = s;
  }

  /** Cor do crepúsculo pela fração do tempo em BALANCE.phases (calculada por snapshot). */
  onSnap(s: Snap, now: number, fresh: boolean): void {
    const P = BALANCE.phases;
    const el = s.el;
    if (el < P.coletaEnd) {
      this.target = C_COLETA;
      this.vigBase = 0.18;
    } else if (el < P.cacadaEnd) {
      const k = (el - P.coletaEnd) / (P.cacadaEnd - P.coletaEnd);
      this.target = lerpRgb(C_COLETA, C_CACADA, k);
      this.vigBase = 0.18 + 0.12 * k;
    } else {
      const k = Math.min(1, (el - P.cacadaEnd) / (P.finalEnd - P.cacadaEnd));
      this.target = lerpRgb(C_CACADA, C_FINAL, k);
      this.vigBase = 0.3 + 0.12 * k;
    }
    if (s.ph !== this.phase) {
      if (!fresh && this.phase !== '') this.pulseT0 = now;
      if (s.ph === 'duelo') {
        this.duelT0 = fresh ? now - 800 : now;
        this.duelFrom = this.color;
      } else this.duelT0 = -1;
      this.phase = s.ph;
    }
  }

  update(s: Snap, now: number, fx: number, fy: number, duelists: (EntView | null)[]): void {
    const cam = this.scene.cameras.main;
    const wv = cam.worldView;
    const rm = this.host.fx.rm;
    const duel = s.ph === 'duelo' && this.duelT0 >= 0;
    // Shade: setFillStyle só quando o valor inteiro muda.
    const c = duel ? lerpRgb(this.duelFrom, FXC.duelShade, (now - this.duelT0) / 800) : this.target;
    if (c !== this.color) {
      this.color = c;
      this.shade.setFillStyle(c, 1);
    }
    // Branco no MULTIPLY não muda nada: na Coleta o quad nem é desenhado.
    this.shade.setVisible(c !== 0xffffff);
    if (c !== 0xffffff) this.shade.setPosition(Math.floor(wv.x) - 16, Math.floor(wv.y) - 16).setScale(Math.ceil(wv.width) + 32, Math.ceil(wv.height) + 32);
    // Tier baixo: só o shade.
    const low = this.host.fx.tier === 2;
    this.vig.setVisible(!low);
    if (!low) {
      let a: number;
      if (duel) a = rm ? 0.38 : heartbeat(now);
      else {
        const pe = now - this.pulseT0;
        a = this.vigBase + (!rm && pe >= 0 && pe < 600 ? 0.15 * (1 - pe / 600) : 0);
      }
      const sc = this.vigScale;
      this.vig
        .setTint(duel ? FXC.red : FXC.night)
        .setAlpha(a)
        .setPosition(Math.round(fx / sc) * sc, Math.round(fy / sc) * sc);
    }
    // Halo: seu bicho nas fases final e duelo; no Duelo, os dois finalistas.
    const showHalo = !low && (s.ph === 'final' || duel);
    for (let i = 0; i < 2; i++) {
      const v = showHalo ? (duel ? duelists[i] : i === 0 ? this.host.view(this.host.focusId()) : null) : null;
      const h = this.halos[i];
      if (!v) {
        if (h.visible) h.setVisible(false);
        continue;
      }
      h.setVisible(true).setPosition(Math.round(v.x), Math.round(v.y - 2));
    }
  }
}

/** Vinheta Bayer 4×4 de 5 níveis: limpa no centro (~55% da vista) e fecha nas bordas. */
function vignetteCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  const cx = w / 2;
  const cy = h / 2;
  // A vista ocupa 1/1,5 da textura: limpa até 0,55 da vista, cheia um pouco depois da borda.
  const d0 = 0.55 / 1.5;
  const d1 = 1.1 / 1.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) / cx;
      const dy = (y + 0.5 - cy) / cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const lvl = Math.round(Math.max(0, Math.min(1, (d - d0) / (d1 - d0))) * 4) / 4;
      if (lvl > 0 && BAYER[(y & 3) * 4 + (x & 3)] < lvl * 16) ctx.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

/** Halo de raio 40 com borda pontilhada. */
function haloTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists('halo')) return;
  const c = document.createElement('canvas');
  c.width = c.height = 80;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 80; x++) {
      const d = Math.hypot(x + 0.5 - 40, y + 0.5 - 40);
      const lvl = d < 28 ? 1 : d < 40 ? Math.round((1 - (d - 28) / 12) * 4) / 4 : 0;
      if (lvl > 0 && BAYER[(y & 3) * 4 + (x & 3)] < lvl * 16) ctx.fillRect(x, y, 1, 1);
    }
  }
  scene.textures.addCanvas('halo', c);
}
