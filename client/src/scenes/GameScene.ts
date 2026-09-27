import Phaser from 'phaser';
import type { EntSnap, Fruit, Snap } from '@vb/shared';
import { drawCreature, lookKey } from '../render/creature';
import { TILE, drawFruit, renderMap } from '../render/map';

interface EntView {
  img: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text | null;
  key: string;
  x: number;
  y: number;
  data: EntSnap;
}

const center = (t: number) => t * TILE + TILE / 2;

export class GameScene extends Phaser.Scene {
  onTap: (tile: { x: number; y: number } | null, entityId: number | null) => void = () => {};

  private mapImg: Phaser.GameObjects.Image | null = null;
  private fruitImgs: Phaser.GameObjects.Image[] = [];
  private ents = new Map<number, EntView>();
  private zoneG!: Phaser.GameObjects.Graphics;
  private bubbleG!: Phaser.GameObjects.Graphics;
  private overG!: Phaser.GameObjects.Graphics;
  private snap: Snap | null = null;
  private camPos: { x: number; y: number } | null = null;
  private dest: { x: number; y: number; until: number } | null = null;
  private ready = false;
  private pending: (() => void)[] = [];

  constructor() {
    super('game');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0b0716');
    this.zoneG = this.add.graphics().setDepth(5);
    this.bubbleG = this.add.graphics().setDepth(900);
    this.overG = this.add.graphics().setDepth(950);
    this.applyZoom();
    this.scale.on('resize', () => this.applyZoom());
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => this.handleTap(p));
    this.ready = true;
    for (const fn of this.pending.splice(0)) fn();
  }

  private whenReady(fn: () => void): void {
    if (this.ready) fn();
    else this.pending.push(fn);
  }

  private zoom(): number {
    const s = Math.min(this.scale.width, this.scale.height);
    return Phaser.Math.Clamp(s / (TILE * 13), 2, 4);
  }

  private applyZoom(): void {
    const z = this.zoom();
    this.cameras.main.setZoom(z);
    const res = Math.ceil(z * (window.devicePixelRatio || 1));
    for (const v of this.ents.values()) v.label?.setResolution(res);
  }

  private handleTap(p: Phaser.Input.Pointer): void {
    if (!this.snap?.me?.alive) return;
    const wx = p.worldX;
    const wy = p.worldY;
    let best: { id: number; d: number } | null = null;
    for (const v of this.ents.values()) {
      if (v.data.id === this.snap.me.id) continue;
      const d = Math.hypot(v.x - wx, v.y - 2 - wy);
      if (d < 13 && (!best || d < best.d)) best = { id: v.data.id, d };
    }
    if (best) {
      this.onTap(null, best.id);
      return;
    }
    const tile = { x: Math.floor(wx / TILE), y: Math.floor(wy / TILE) };
    this.dest = { ...tile, until: this.time.now + 900 };
    this.onTap(tile, null);
  }

  /** Monta o mundo de uma nova partida. */
  setWorld(w: number, h: number, tiles: Uint8Array, fruits: Fruit[]): void {
    this.whenReady(() => {
      this.clearWorld();
      if (this.textures.exists('map')) this.textures.remove('map');
      this.textures.addCanvas('map', renderMap(w, h, tiles));
      this.mapImg = this.add.image(0, 0, 'map').setOrigin(0, 0).setDepth(0);
      this.fruitImgs = fruits.map((f) => {
        const key = `fruit-${f.elem}`;
        if (!this.textures.exists(key)) this.textures.addCanvas(key, drawFruit(f.elem));
        const img = this.add.image(center(f.x), center(f.y), key).setDepth(3);
        this.tweens.add({ targets: img, y: img.y - 2, yoyo: true, repeat: -1, duration: 700, ease: 'Sine.easeInOut' });
        return img;
      });
    });
  }

  clearWorld(): void {
    for (const v of this.ents.values()) {
      v.img.destroy();
      v.label?.destroy();
    }
    this.ents.clear();
    this.mapImg?.destroy();
    this.mapImg = null;
    for (const f of this.fruitImgs) f.destroy();
    this.fruitImgs = [];
    this.snap = null;
    this.camPos = null;
    this.zoneG?.clear();
    this.bubbleG?.clear();
    this.overG?.clear();
  }

  private texFor(e: EntSnap): string {
    const look = { form: e.f, stage: e.s, order: e.o };
    const key = `cr:${lookKey(look)}`;
    if (!this.textures.exists(key)) this.textures.addCanvas(key, drawCreature(look));
    return key;
  }

  applySnap(s: Snap): void {
    if (!this.ready || !this.mapImg) return;
    this.snap = s;
    const seen = new Set<number>();
    const res = Math.ceil(this.zoom() * (window.devicePixelRatio || 1));
    for (const e of s.ents) {
      seen.add(e.id);
      const key = this.texFor(e);
      let v = this.ents.get(e.id);
      if (!v) {
        const img = this.add.image(center(e.x), center(e.y), key).setOrigin(0.5, 0.62);
        if (e.k === 'w') img.setScale(0.8);
        const label =
          e.k === 'p'
            ? this.add
                .text(0, 0, '', { fontFamily: 'Nunito, sans-serif', fontSize: '7px', fontStyle: 'bold', color: '#ffffff', stroke: '#140f24', strokeThickness: 2 })
                .setOrigin(0.5, 1)
                .setDepth(1000)
                .setResolution(res)
            : null;
        v = { img, label, key, x: center(e.x), y: center(e.y), data: e };
        this.ents.set(e.id, v);
        img.setAlpha(0);
        this.tweens.add({ targets: img, alpha: 1, duration: 200 });
      } else if (v.key !== key) {
        v.key = key;
        v.img.setTexture(key);
        // Evoluiu ou perdeu estágio: um "pop" visual
        this.tweens.add({ targets: v.img, scale: { from: (e.k === 'w' ? 0.8 : 1) * 1.5, to: e.k === 'w' ? 0.8 : 1 }, duration: 350, ease: 'Back.easeOut' });
      }
      v.data = e;
      if (v.label) {
        const txt = `${e.cr ? '👑 ' : ''}${e.n ?? ''}`;
        if (v.label.text !== txt) v.label.setText(txt);
        v.label.setColor(e.id === s.me?.id ? '#ffcf3f' : e.cr ? '#ffe28a' : '#ffffff');
      }
    }
    for (const [id, v] of this.ents) {
      if (seen.has(id)) continue;
      v.img.destroy();
      v.label?.destroy();
      this.ents.delete(id);
    }
    const avail = new Set(s.fr);
    this.fruitImgs.forEach((img, i) => img.setVisible(avail.has(i)));
  }

  update(time: number, delta: number): void {
    const s = this.snap;
    if (!s) return;
    const k = 1 - Math.exp(-delta / 60);
    for (const v of this.ents.values()) {
      const tx = center(v.data.x);
      const ty = center(v.data.y);
      v.x += (tx - v.x) * k;
      v.y += (ty - v.y) * k;
      const moving = Math.abs(tx - v.x) + Math.abs(ty - v.y) > 0.5;
      const bob = moving ? Math.abs(Math.sin(time / 70 + v.data.id)) * -1.5 : Math.sin(time / 380 + v.data.id) * 0.6;
      v.img.setPosition(v.x, v.y + bob).setDepth(10 + v.y / TILE);
      v.label?.setPosition(v.x, v.y - 13);
    }
    this.separateLabels();

    // Câmera segue você (ou quem você assiste).
    const target = s.view !== null ? this.ents.get(s.view) : undefined;
    if (target) {
      if (!this.camPos) this.camPos = { x: target.x, y: target.y };
      const kc = 1 - Math.exp(-delta / 120);
      this.camPos.x += (target.x - this.camPos.x) * kc;
      this.camPos.y += (target.y - this.camPos.y) * kc;
      this.cameras.main.centerOn(this.camPos.x, this.camPos.y);
    }

    this.drawZone(s);
    this.drawBubbles(s, time);
    this.drawOverlay(s, time);
  }

  /** Empurra para cima os nomes que se sobrepõem (bichos colados numa batalha, por exemplo). */
  private separateLabels(): void {
    const labels = [...this.ents.values()].map((v) => v.label).filter((l): l is Phaser.GameObjects.Text => !!l);
    labels.sort((a, b) => b.y - a.y);
    const placed: { x: number; y: number; w: number }[] = [];
    for (const l of labels) {
      const w = l.width / 2 + 2;
      let y = l.y;
      for (let guard = 0; guard < 8; guard++) {
        const hit = placed.find((p) => Math.abs(p.x - l.x) < p.w + w && Math.abs(p.y - y) < 8);
        if (!hit) break;
        y = hit.y - 8;
      }
      l.setY(y);
      placed.push({ x: l.x, y, w });
    }
  }

  private drawZone(s: Snap): void {
    const g = this.zoneG;
    g.clear();
    const cx = center(s.z.x);
    const cy = center(s.z.y);
    const r = Math.max(0, s.z.r * TILE);
    const thick = 4000;
    g.lineStyle(thick, 0x2a0840, 0.55);
    g.strokeCircle(cx, cy, r + thick / 2);
    g.lineStyle(2, 0xff5fd2, 0.95);
    g.strokeCircle(cx, cy, r);
    if (s.z.tr < s.z.r - 0.5) {
      g.lineStyle(1, 0xffffff, 0.35);
      g.strokeCircle(cx, cy, s.z.tr * TILE);
    }
  }

  private drawBubbles(s: Snap, time: number): void {
    const g = this.bubbleG;
    g.clear();
    for (const b of s.bs) {
      const r = 22 + Math.sin(time / 200 + b.id) * 1.5;
      g.fillStyle(0xffffff, 0.07);
      g.fillCircle(center(b.x), center(b.y), r);
      g.lineStyle(1.5, 0xffcf3f, 0.85);
      g.strokeCircle(center(b.x), center(b.y), r);
    }
  }

  private drawOverlay(s: Snap, time: number): void {
    const g = this.overG;
    g.clear();
    const myTarget = s.me?.target ?? null;
    for (const v of this.ents.values()) {
      const e = v.data;
      const showBar = e.k === 'p' || e.hp < e.mhp || e.b !== undefined;
      if (showBar) {
        const pct = Math.max(0, e.hp / e.mhp);
        g.fillStyle(0x000000, 0.65);
        g.fillRect(v.x - 8, v.y + 8, 16, 3);
        g.fillStyle(pct > 0.5 ? 0x58e07a : pct > 0.25 ? 0xffcf3f : 0xff4f6d, 1);
        g.fillRect(v.x - 7.5, v.y + 8.5, 15 * pct, 2);
      }
      if (e.sh) {
        g.lineStyle(1, 0x7cc4ff, 0.6 + Math.sin(time / 120) * 0.3);
        g.strokeCircle(v.x, v.y, 11);
      }
      if (e.ch) {
        g.fillStyle(0xffe066, 1);
        g.fillRect(v.x + 7, v.y - 9 + Math.sin(time / 90) * 1.5, 2, 2);
      }
      if (e.id === myTarget) {
        g.lineStyle(1.5, 0xffcf3f, 0.6 + Math.sin(time / 110) * 0.35);
        g.strokeEllipse(v.x, v.y + 7, 20, 8);
      }
    }
    if (this.dest && time < this.dest.until) {
      const x = center(this.dest.x);
      const y = center(this.dest.y);
      const a = (this.dest.until - time) / 900;
      g.lineStyle(1.5, 0xffffff, a);
      g.lineBetween(x - 3, y - 3, x + 3, y + 3);
      g.lineBetween(x - 3, y + 3, x + 3, y - 3);
    }
  }
}
