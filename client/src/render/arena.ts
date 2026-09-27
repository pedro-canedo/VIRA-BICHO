import Phaser from 'phaser';
import type { FxEvent, Snap } from '@vb/shared';
import { dotEllipse, nudge, spanEllipse, squash, type EntView, type FxHost } from './fx';
import { FORM_TINT, FXC, bodyTint } from './fxpalette';
import { TILE } from './map';

/**
 * Arena de duelo no chão (groundG): substitui a bolha branca por dois semicírculos
 * nas cores dos lutadores, runas douradas em órbita e anel tracejado. Abre no 'bt',
 * pisca a cada 'h' e fecha quando a batalha some de s.bs.
 */

type BtEv = Extract<FxEvent, { k: 'bt' }>;

interface Arena {
  on: boolean;
  id: number;
  x: number;
  y: number;
  final: boolean;
  t0: number;
  /** início do colapso (-1 = aberta) */
  end: number;
  seen: boolean;
  l: EntView | null;
  r: EntView | null;
  flashT0: number;
  flashC: number;
  acc: number;
  alt: boolean;
  fill: Phaser.GameObjects.Image | null;
  bangs: (Phaser.GameObjects.Image | null)[];
}

const TAU = Math.PI * 2;
const BO = Phaser.Math.Easing.Back.Out;
const OPEN_MS = 250;
const CLOSE_MS = 200;
const BANG_MS = 690;

export class Arenas {
  private pool: Arena[] = [];
  private map = new Map<number, Arena>();
  private fills: Phaser.GameObjects.Image[] = [];
  private fillBusy = [false, false, false, false];

  constructor(
    scene: Phaser.Scene,
    private host: FxHost,
  ) {
    for (let i = 0; i < 8; i++) {
      this.pool.push({ on: false, id: 0, x: 0, y: 0, final: false, t0: 0, end: -1, seen: false, l: null, r: null, flashT0: -1e9, flashC: 0, acc: 0, alt: false, fill: null, bangs: [null, null] });
    }
    fillTexture(scene, 'arenaFill', 48, 20, 22, 9);
    fillTexture(scene, 'arenaFillF', 82, 34, 40, 16);
    for (let i = 0; i < 4; i++) this.fills.push(scene.add.image(0, 0, 'arenaFill').setDepth(6.5).setVisible(false).setAlpha(0.12));
  }

  clear(): void {
    for (const a of this.pool) if (a.on) this.release(a);
    this.map.clear();
  }

  private take(id: number, now: number): Arena | null {
    let a = this.map.get(id);
    if (a) return a;
    a = this.pool.find((p) => !p.on);
    if (!a) return null;
    a.on = true;
    a.id = id;
    a.final = false;
    a.t0 = now - 1000;
    a.end = -1;
    a.l = a.r = null;
    a.flashT0 = -1e9;
    a.acc = 0;
    a.seen = true;
    for (let i = 0; i < 4; i++) {
      if (this.fillBusy[i]) continue;
      this.fillBusy[i] = true;
      a.fill = this.fills[i];
      break;
    }
    this.map.set(id, a);
    return a;
  }

  private release(a: Arena): void {
    const fx = this.host.fx;
    if (a.fill) {
      this.fillBusy[this.fills.indexOf(a.fill)] = false;
      a.fill.setVisible(false);
      a.fill = null;
    }
    a.bangs[0] = fx.freeImage(a.bangs[0]);
    a.bangs[1] = fx.freeImage(a.bangs[1]);
    a.on = false;
    this.map.delete(a.id);
  }

  /** 'bt': o anel cresce, 12 (24 no Duelo) faíscas saem da borda, '!' sobre os lutadores e o salto. */
  open(e: BtEv, now: number): void {
    const a = this.take(e.id, now);
    if (!a) return;
    const h = this.host;
    const fx = h.fx;
    a.t0 = now;
    a.end = -1;
    a.final = e.kd === 'f';
    a.x = (e.x + 0.5) * TILE;
    a.y = (e.y + 0.5) * TILE + 5;
    a.fill?.setTexture(a.final ? 'arenaFillF' : 'arenaFill');
    const focus = h.focusId();
    const mine = a.final || e.a === focus || e.b === focus;
    const rx = a.final ? 40 : 22;
    const ry = a.final ? 16 : 9;
    const n = a.final ? 24 : 12;
    const P = fx.reset();
    P.frame = 'plus';
    P.c0 = FXC.gold;
    P.spMin = 30;
    P.spMax = 60;
    P.lifeMin = P.lifeMax = 300;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU;
      P.angMin = P.angMax = ang / (Math.PI / 180);
      fx.emit(fx.spark, 1, a.x + Math.cos(ang) * rx, a.y + Math.sin(ang) * ry, mine, true);
    }
    if (a.final) fx.screenFlash(FXC.gold, 0.25, 150, now);
    const va = h.view(e.a);
    const vb = h.view(e.b);
    for (let i = 0; i < 2; i++) {
      const v = i ? vb : va;
      const o = i ? va : vb;
      if (!v) continue;
      a.bangs[i] = fx.freeImage(a.bangs[i]);
      a.bangs[i] = fx.takeImage('bango')?.setTint(FXC.gold).setVisible(false) ?? null;
      if (fx.rm) continue;
      squash(v, 1.15, 0.85, 1, 90, 1, now);
      const dx = o ? Math.sign(o.x - v.x) : 0;
      nudge(v, dx * 3, 0, 60, 60, now);
    }
  }

  /** Cada 'h' pisca a elipse na cor da forma do atacante. */
  hit(bt: number, attacker: number, now: number): void {
    const a = this.map.get(bt);
    const v = this.host.view(attacker);
    if (!a || !v) return;
    a.flashT0 = now;
    a.flashC = colorOf(v);
  }

  /** Marca as batalhas vivas; as que sumiram começam a fechar. */
  onSnap(s: Snap, now: number): void {
    for (const a of this.pool) if (a.on) a.seen = false;
    for (const b of s.bs) {
      const a = this.take(b.id, now);
      if (!a) continue;
      a.seen = true;
      a.x = (b.x + 0.5) * TILE;
      a.y = (b.y + 0.5) * TILE + 5;
      if (s.ph === 'duelo' && s.bs.length === 1 && !a.final) {
        a.final = true;
        a.fill?.setTexture('arenaFillF');
      }
    }
    for (const a of this.pool) {
      if (!a.on || a.seen || a.end >= 0) continue;
      a.end = now;
      const fx = this.host.fx;
      const mine = this.isMine(a);
      const P = fx.reset();
      P.frame = 'p2';
      P.c0 = mine ? FXC.gold : FXC.dust;
      P.spMin = 30;
      P.spMax = 70;
      P.lifeMin = P.lifeMax = 300;
      P.rad = 10;
      fx.emit(fx.spark, 8, a.x, a.y, mine, true);
    }
  }

  /** Zera os lutadores; o GameScene devolve cada EntView com data.b via fighter(). */
  begin(): void {
    for (const a of this.pool) a.l = a.r = null;
  }

  fighter(v: EntView): void {
    const a = this.map.get(v.data.b ?? -1);
    if (!a) return;
    if (!a.l) a.l = v;
    else if (!a.r) {
      if (v.x < a.l.x) {
        a.r = a.l;
        a.l = v;
      } else a.r = v;
    }
  }

  private isMine(a: Arena): boolean {
    const f = this.host.focusId();
    return a.final || a.l?.data.id === f || a.r?.data.id === f;
  }

  update(now: number, delta: number): void {
    const h = this.host;
    const fx = h.fx;
    const g = h.groundG;
    for (const a of this.pool) {
      if (!a.on) continue;
      let k = 1;
      if (a.end >= 0) {
        const ce = now - a.end;
        if (ce >= CLOSE_MS) {
          this.release(a);
          continue;
        }
        k = 1 - ce / CLOSE_MS;
      } else if (now - a.t0 < OPEN_MS) k = BO((now - a.t0) / OPEN_MS);
      const mine = this.isMine(a);
      const other = !mine && fx.fighting;
      const alpha = mine ? 1 : other ? 0.4 : 0.45;
      let cl = other ? FXC.white : a.l ? colorOf(a.l) : FXC.dust;
      let cr = other ? FXC.white : a.r ? colorOf(a.r) : cl;
      if (now - a.flashT0 < 150) cl = cr = a.flashC;
      const RX = a.final ? 40 : 22;
      const RY = a.final ? 16 : 9;
      const rx = RX * k;
      const ry = RY * k;
      if (!fx.view.contains(a.x, a.y) && !mine) {
        a.fill?.setVisible(false);
        continue;
      }
      a.fill?.setPosition(Math.round(a.x), Math.round(a.y)).setVisible(k > 0.6).setAlpha(0.12 * alpha * k);
      h.groundBudget += spanEllipse(g, a.x, a.y, rx, ry, cl, cr, alpha, 220 - h.groundBudget);
      const rot = fx.rm ? 0 : (now / 1000) * 0.5 * TAU;
      if (a.final) {
        dotEllipse(h, a.x, a.y, rx * 0.75, ry * 0.75, 28, -rot * 0.5, FXC.magenta, alpha * 0.8);
        dotEllipse(h, a.x, a.y, rx * 0.5, ry * 0.5, 20, rot * 0.5, FXC.gold, alpha * 0.7);
      }
      // Runas 2×2 em órbita (0,5 volta/s) e anel externo tracejado girando ao contrário.
      const nr = a.final ? 12 : 8;
      if (h.groundBudget + nr + 18 <= 220) {
        h.groundBudget += nr + 18;
        for (let i = 0; i < nr; i++) {
          const ang = rot + (i / nr) * TAU;
          g.fillStyle(a.final && i & 1 ? FXC.magenta : other ? FXC.white : FXC.gold, alpha);
          g.fillRect(Math.round(a.x + Math.cos(ang) * rx) - 1, Math.round(a.y + Math.sin(ang) * ry) - 1, 2, 2);
        }
        g.fillStyle(other ? FXC.white : FXC.gold, mine ? 1 : alpha);
        const ox = rx + 4 * k;
        const oy = ry + 2 * k;
        for (let i = 0; i < 18; i++) {
          const ang = -rot * 0.5 + (i / 18) * TAU;
          g.fillRect(Math.round(a.x + Math.cos(ang) * ox), Math.round(a.y + Math.sin(ang) * oy), 2, 1);
        }
      }
      // Um mote sobe da borda a cada 150 ms, alternando as cores dos lutadores.
      if (a.end < 0 && !fx.rm) {
        a.acc += delta;
        while (a.acc >= 150) {
          a.acc -= 150;
          a.alt = !a.alt;
          const ang = Math.random() * TAU;
          const P = fx.reset();
          P.c0 = a.alt ? cl : cr;
          P.vy = -14;
          P.lifeMin = 500;
          P.lifeMax = 700;
          fx.emit(fx.spark, 1, a.x + Math.cos(ang) * rx, a.y + Math.sin(ang) * ry, mine, true, 0.9);
        }
      }
      this.drawBangs(a, now);
    }
  }

  /** '!' dourado sobre cada lutador: 0→2→1 em degraus (140 ms), fica 450 ms e some em 100 ms. */
  private drawBangs(a: Arena, now: number): void {
    const e = now - a.t0;
    for (let i = 0; i < 2; i++) {
      const b = a.bangs[i];
      if (!b) continue;
      if (e >= BANG_MS) {
        a.bangs[i] = this.host.fx.freeImage(b);
        continue;
      }
      const f = i === 0 ? a.l : a.r;
      if (!f) {
        b.setVisible(false);
        continue;
      }
      const sc = e < 45 ? 0 : e < 95 ? 2 : 1;
      b.setVisible(sc > 0)
        .setScale(sc)
        .setPosition(Math.round(f.x), Math.round(f.y - 27))
        .setAlpha(e > BANG_MS - 100 ? (BANG_MS - e) / 100 : 1);
    }
  }
}

function colorOf(v: EntView): number {
  const d = v.data;
  return d.k === 'w' ? bodyTint(d.f, d.o) : FORM_TINT[d.f];
}

/** Miolo pontilhado da arena: xadrez de pontos dentro da elipse, gerado uma vez. */
function fillTexture(scene: Phaser.Scene, key: string, w: number, h: number, rx: number, ry: number): void {
  if (scene.textures.exists(key)) return;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if ((x + y) % 2 === 0 && dx * dx + dy * dy < 0.92) ctx.fillRect(x, y, 1, 1);
    }
  }
  scene.textures.addCanvas(key, c);
}
