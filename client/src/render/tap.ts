import Phaser from 'phaser';
import type { Snap } from '@vb/shared';
import { dotEllipse, squash, type EntView, type FxHost } from './fx';
import { FXC } from './fxpalette';
import { TILE } from './map';

/**
 * Toque: ondulação no chão, cantoneiras de destino que pulsam até você chegar,
 * cantoneiras encaixando no bicho tocado (ou tremendo no alvo inválido) e a
 * elipse dourada do alvo atual no chão.
 */

const BO = Phaser.Math.Easing.Back.Out;

export class Tap {
  private dest = { on: false, x: 0, y: 0, t0: 0 };
  private tgt = { on: false, id: 0, t0: 0, color: 0, bad: false };
  private readonly RIPPLE: Phaser.Textures.Frame[];

  constructor(private host: FxHost) {
    const fx = host.fx;
    this.RIPPLE = [fx.frame('ring3'), fx.frame('ring5'), fx.frame('ring8')];
  }

  clear(): void {
    this.dest.on = false;
    this.tgt.on = false;
  }

  /** Toque no chão: anel ring3→ring5→ring8 (80 ms cada) e 4 pixels de poeira. */
  ground(tx: number, ty: number, now: number): void {
    const fx = this.host.fx;
    const x = (tx + 0.5) * TILE;
    const y = (ty + 0.5) * TILE;
    let P = fx.reset();
    P.seq = this.RIPPLE;
    P.lifeMin = P.lifeMax = 240;
    P.a1 = 0;
    fx.emit(fx.ring, 1, x, y, true, true);
    P = fx.reset();
    P.c0 = FXC.dust;
    P.spMin = 10;
    P.spMax = 25;
    P.lifeMin = P.lifeMax = 250;
    fx.emit(fx.ground, 4, x, y, true, true);
    this.dest.on = true;
    this.dest.x = tx;
    this.dest.y = ty;
    this.dest.t0 = now;
    this.tgt.on = false;
  }

  /** Toque num bicho: cantoneiras douradas (selvagem) ou vermelhas (jogador); lilás se o alvo é inválido. */
  creature(v: EntView, invalid: boolean, now: number): void {
    const t = this.tgt;
    t.on = true;
    t.id = v.data.id;
    t.t0 = now;
    t.bad = invalid;
    t.color = invalid ? FXC.lilac2 : v.data.k === 'w' ? FXC.gold : FXC.red;
    if (!invalid && !this.host.fx.rm) squash(v, 1.1, 0.9, 1, 60, 1, now);
    this.dest.on = false;
  }

  update(s: Snap, now: number): void {
    const h = this.host;
    const me = s.me;
    const d = this.dest;
    if (d.on && (!me?.alive || (me.x === d.x && me.y === d.y))) d.on = false;
    if (d.on) {
      // Convergem de 10 para 5 px em 150 ms e pulsam a 3 Hz até você chegar.
      const e = now - d.t0;
      const r = e < 150 ? 10 - 5 * BO(e / 150) : 5;
      const a = e < 150 || h.fx.rm ? 1 : 0.75 + 0.25 * Math.sin((now / 1000) * Math.PI * 2 * 3);
      if (h.groundBudget + 8 <= 220) {
        h.groundBudget += 8;
        corners(h.groundG, (d.x + 0.5) * TILE, (d.y + 0.5) * TILE, r, FXC.white, a);
      }
    }
    // Elipse dourada do alvo atual, abaixo dos pés.
    const tid = me?.target ?? null;
    const tv = tid !== null ? h.view(tid) : undefined;
    if (tv) dotEllipse(h, tv.x, tv.y + 7, 10, 4, 28, 0, FXC.gold, h.fx.rm ? 0.8 : 0.6 + Math.sin(now / 110) * 0.35);
    const t = this.tgt;
    if (!t.on) return;
    const e = now - t.t0;
    const v = h.view(t.id);
    if (!v || (t.bad && e >= 150) || (!t.bad && e > 600 && tid !== t.id)) {
      t.on = false;
      return;
    }
    const r = e < 140 ? 12 - 3 * BO(e / 140) : 9;
    const shake = t.bad && !h.fx.rm ? ((Math.floor(e / 30) & 1) * 2 - 1) * 3 : 0;
    if (h.overBudget + 8 <= 160) {
      h.overBudget += 8;
      corners(h.overG, v.x + shake, v.y - 2, r, t.color, 1);
    }
  }
}

/** 4 cantoneiras de 2 px em volta de (cx, cy) a d px do centro. */
function corners(g: Phaser.GameObjects.Graphics, cx: number, cy: number, d: number, color: number, alpha: number): void {
  const x0 = Math.round(cx - d) - 1;
  const x1 = Math.round(cx + d);
  const y0 = Math.round(cy - d) - 1;
  const y1 = Math.round(cy + d);
  g.fillStyle(color, alpha);
  g.fillRect(x0, y0, 2, 1);
  g.fillRect(x0, y0, 1, 2);
  g.fillRect(x1 - 1, y0, 2, 1);
  g.fillRect(x1, y0, 1, 2);
  g.fillRect(x0, y1, 2, 1);
  g.fillRect(x0, y1 - 1, 1, 2);
  g.fillRect(x1 - 1, y1, 2, 1);
  g.fillRect(x1, y1 - 1, 1, 2);
}
