import Phaser from 'phaser';
import { LINES, LINE_INFO, SKILLS, type FxEvent, type Line } from '@vb/shared';
import { flash, type EntView, type FxHost } from './fx';
import { FXC } from './fxpalette';
import { hexNum, mix } from './palette';
import { TILE } from './map';

/**
 * Build no mundo: o distintivo da linha do título ao lado do nome (7×7 no aprendiz,
 * 9×9 com moldura dourada e brilho no mestre) e o brilho da compra na cor da linha.
 */

type Buy = Extract<FxEvent, { k: 'k' }>;

// Legenda: x cor da linha | w clara
const ICONS: Record<Line, string[]> = {
  guerreiro: ['....w', '...x.', 'x.x..', '.x...', 'x.x..'],
  mago: ['..x..', '.xwx.', 'xxxxx', '.xxx.', '..x..'],
  cacador: ['..xxx', '...wx', '..x.x', '.x...', 'x....'],
};

const INK = '#140f24';
const GOLD = '#ffcf3f';
const GOLD_L = '#fff3b0';
const BUY_MS = 700;
const BUY_PAT = [70, 50, 70] as const;

/** Largura do distintivo (0 sem título). */
export const badgeWidth = (tl: 1 | 2 | undefined): number => (tl === 2 ? 9 : tl === 1 ? 7 : 0);

export const badgeKey = (ln: Line, tl: 1 | 2): string => `bdg:${ln}:${tl}`;

export const lineTint = (ln: Line): number => hexNum(LINE_INFO[ln].color);

function badgeCanvas(ln: Line, tl: 1 | 2): HTMLCanvasElement {
  const color = LINE_INFO[ln].color;
  const size = tl === 2 ? 9 : 7;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const px = (x: number, y: number, col: string) => {
    ctx.fillStyle = col;
    ctx.fillRect(x, y, 1, 1);
  };
  const o = tl === 2 ? 1 : 0;
  // Halo da cor da linha em volta da moldura dourada do mestre
  if (tl === 2) {
    for (let i = 2; i < 7; i++) {
      px(i, 0, color);
      px(i, 8, color);
      px(0, i, color);
      px(8, i, color);
    }
    px(1, 1, color);
    px(7, 1, color);
    px(1, 7, color);
    px(7, 7, color);
  }
  // Placa: miolo escuro e borda (cor da linha escurecida, ou ouro no mestre)
  const border = tl === 2 ? GOLD : mix(color, INK, 0.35);
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const corner = (x === 0 || x === 6) && (y === 0 || y === 6);
      if (corner) continue;
      px(o + x, o + y, x === 0 || x === 6 || y === 0 || y === 6 ? border : INK);
    }
  }
  if (tl === 2) {
    px(o + 1, o, GOLD_L);
    px(o, o + 1, GOLD_L);
  }
  const light = mix(color, '#ffffff', 0.55);
  ICONS[ln].forEach((row, y) => {
    for (let x = 0; x < 5; x++) {
      const ch = row[x];
      if (ch === 'x') px(o + 1 + x, o + 1 + y, color);
      else if (ch === 'w') px(o + 1 + x, o + 1 + y, light);
    }
  });
  return c;
}

interface BuySlot {
  on: boolean;
  t0: number;
  id: number;
  x: number;
  y: number;
  color: number;
  mine: boolean;
  column: Phaser.GameObjects.Image | null;
  icon: Phaser.GameObjects.Image | null;
}

export class Builds {
  private buys: BuySlot[] = [];

  constructor(
    private scene: Phaser.Scene,
    private host: FxHost,
  ) {
    for (const ln of LINES) {
      for (const tl of [1, 2] as const) {
        const key = badgeKey(ln, tl);
        if (!scene.textures.exists(key)) scene.textures.addCanvas(key, badgeCanvas(ln, tl));
      }
    }
    for (let i = 0; i < 4; i++) this.buys.push({ on: false, t0: 0, id: 0, x: 0, y: 0, color: 0, mine: false, column: null, icon: null });
  }

  clear(): void {
    for (const s of this.buys) if (s.on) this.end(s);
  }

  // ---------------------------------------------------------------- distintivo

  /** Cria, troca ou tira o distintivo conforme ln/tl do snapshot. */
  badge(v: EntView): void {
    const d = v.data;
    if (!v.label) return;
    const key = d.ln && d.tl ? badgeKey(d.ln, d.tl) : '';
    if (key === v.badgeKey) return;
    v.badgeKey = key;
    if (!key) {
      v.badge?.destroy();
      v.badge = null;
      return;
    }
    if (v.badge) v.badge.setTexture(key);
    else v.badge = this.scene.add.image(0, 0, key).setOrigin(0, 0.5).setDepth(1000);
  }

  /** Brilho do mestre: um '+' branco pisca no canto do distintivo a cada 1,4 s. */
  shine(v: EntView, now: number): void {
    const b = v.badge;
    if (!b || v.data.tl !== 2 || !b.visible || this.host.fx.rm) return;
    const p = (now + v.data.id * 211) % 1400;
    if (p >= 180 || this.host.overBudget + 2 > 160) return;
    this.host.overBudget += 2;
    const g = this.host.overG;
    const x = Math.round(b.x + 8);
    const y = Math.round(b.y - 4);
    g.fillStyle(FXC.white, p < 90 ? 1 : 0.6);
    g.fillRect(x - 1, y, 3, 1);
    g.fillRect(x, y - 1, 1, 3);
  }

  // ---------------------------------------------------------------- compra

  /** 'k': lampejo e coluna de luz na cor da linha, faíscas subindo e o distintivo da linha no alto. */
  buy(ev: Buy, now: number): void {
    const h = this.host;
    const fx = h.fx;
    const def = SKILLS[ev.s];
    if (!def) return;
    const v = h.view(ev.id);
    const color = lineTint(def.line);
    const x = v ? v.x : (ev.x + 0.5) * TILE;
    const y = v ? v.y : (ev.y + 0.5) * TILE;
    const mine = ev.id === h.focusId();
    if (v) flash(v, color, BUY_PAT, now, fx.rm);
    let P = fx.reset();
    P.frame = 'plus';
    P.pal = [color, FXC.white, color];
    P.rad = 8;
    P.angMin = 200;
    P.angMax = 340;
    P.spMin = 8;
    P.spMax = 20;
    P.vy = -26;
    P.lifeMin = 420;
    P.lifeMax = 560;
    P.a1 = 0.2;
    fx.emit(fx.magic, 10, x, y - 2, mine);
    P = fx.reset();
    P.seq = fx.GROW_BIG;
    P.c0 = color;
    P.lifeMin = P.lifeMax = 320;
    P.a1 = 0.2;
    fx.emit(fx.ring, 1, x, y + 6, mine, true);
    if (mine) h.punch(0.03, 80, 200);
    let s: BuySlot | null = null;
    for (const k of this.buys) if (!k.on) s ??= k;
    if (!s) return;
    s.on = true;
    s.t0 = now;
    s.id = ev.id;
    s.x = x;
    s.y = y;
    s.color = color;
    s.mine = mine;
    s.column = fx.takeImage('p1');
    s.column?.setOrigin(0.5, 1).setDisplaySize(4, 30).setTint(color).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
    s.icon = fx.takeImage('p1');
    s.icon?.setTexture(badgeKey(def.line, 1)).setScale(2);
  }

  private end(s: BuySlot): void {
    const fx = this.host.fx;
    s.column = fx.freeImage(s.column);
    s.icon = fx.freeImage(s.icon);
    s.on = false;
  }

  update(now: number): void {
    const h = this.host;
    for (const s of this.buys) {
      if (!s.on) continue;
      const el = now - s.t0;
      if (el >= BUY_MS) {
        this.end(s);
        continue;
      }
      const v = h.view(s.id);
      if (v) {
        s.x = v.x;
        s.y = v.y;
      }
      const k = el / BUY_MS;
      s.column?.setPosition(Math.round(s.x), Math.round(s.y + 7)).setAlpha(0.6 * Math.sin(Math.min(1, el / 450) * Math.PI));
      // O distintivo nasce em escala 2, assenta em 1 e sobe 8 px.
      if (s.icon) {
        const rise = h.fx.rm ? 0 : 8 * Phaser.Math.Easing.Quadratic.Out(k);
        s.icon
          .setScale(el < 90 ? 2 : 1)
          .setPosition(Math.round(s.x), Math.round(s.y - 30 - rise))
          .setAlpha(k > 0.7 ? (1 - k) / 0.3 : 1);
      }
    }
  }
}
