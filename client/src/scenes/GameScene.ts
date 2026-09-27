import Phaser from 'phaser';
import type { EntSnap, Fruit, FxEvent, Snap } from '@vb/shared';
import { ZoneFx } from '../render/ambient';
import { drawCreature, lookKey } from '../render/creature';
import { Fx, pop, stepView, type EntView, type FxHost } from '../render/fx';
import { FXC } from '../render/fxpalette';
import { TILE, drawFruit, renderMap } from '../render/map';
import { Runes } from '../render/runes';
import { Spells } from '../render/spells';

const center = (t: number) => t * TILE + TILE / 2;
const byYDesc = (a: Phaser.GameObjects.Text, b: Phaser.GameObjects.Text) => b.y - a.y;
const CO = Phaser.Math.Easing.Cubic.Out;

export class GameScene extends Phaser.Scene implements FxHost {
  onTap: (tile: { x: number; y: number } | null, entityId: number | null) => void = () => {};

  fx!: Fx;
  groundG!: Phaser.GameObjects.Graphics;
  airG!: Phaser.GameObjects.Graphics;
  groundBudget = 0;
  private mapImg: Phaser.GameObjects.Image | null = null;
  private fruitImgs: Phaser.GameObjects.Image[] = [];
  private ents = new Map<number, EntView>();
  private dying: EntView[] = [];
  private seen = new Set<number>();
  private marked = new Set<number>();
  private zoneG!: Phaser.GameObjects.Graphics;
  private auraBackG!: Phaser.GameObjects.Graphics;
  private bubbleG!: Phaser.GameObjects.Graphics;
  private overG!: Phaser.GameObjects.Graphics;
  private zone!: ZoneFx;
  private spells!: Spells;
  private runes!: Runes;
  private snap: Snap | null = null;
  private fresh = true;
  private camPos: { x: number; y: number } | null = null;
  private dest: { x: number; y: number; until: number } | null = null;
  private ready = false;
  private pending: (() => void)[] = [];
  private zw = { x: 0, y: 0, r: 0 };
  // Câmera viva
  private baseZoom = 2;
  private trauma = 0;
  private punchAmt = 0;
  private punchT0 = -1e9;
  private punchIn = 1;
  private punchOut = 1;
  private bzFrom = 1;
  private bzTo = 1;
  private bzT0 = -1e9;
  private bzMs = 1;
  private inBattle: number | null = null;
  private insetPx = 0;
  private focusOff = 0;
  // separateLabels sem alocar
  private labs: Phaser.GameObjects.Text[] = [];
  private placedX: number[] = [];
  private placedY: number[] = [];
  private placedW: number[] = [];

  constructor() {
    super('game');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0b0716');
    this.fx = new Fx(this);
    this.zoneG = this.add.graphics().setDepth(5);
    this.groundG = this.add.graphics().setDepth(7);
    this.auraBackG = this.add.graphics().setDepth(9);
    this.airG = this.add.graphics().setDepth(890);
    this.bubbleG = this.add.graphics().setDepth(900);
    this.overG = this.add.graphics().setDepth(950);
    this.zone = new ZoneFx(this, this.zoneG);
    this.spells = new Spells(this);
    this.runes = new Runes(this, this);
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
    this.baseZoom = z;
    this.cameras.main.setZoom(z);
    const res = Math.ceil(z * (window.devicePixelRatio || 1));
    for (const v of this.ents.values()) v.label?.setResolution(res);
  }

  /** Altura do painel de batalha: o foco da câmera sobe para o centro da área visível acima dele. */
  setBattleInset(px: number): void {
    this.insetPx = Math.max(0, px);
  }

  // ---------------------------------------------------------------- FxHost

  view(id: number): EntView | undefined {
    return this.ents.get(id);
  }

  focusId(): number {
    return this.snap?.view ?? -1;
  }

  meId(): number {
    return this.snap?.me?.id ?? -1;
  }

  panelBattle(): number | null {
    const s = this.snap;
    if (!s) return null;
    if (s.me?.alive && s.me.battle !== null) return s.me.battle;
    // No Duelo Final todos assistem pelo painel.
    return s.ph === 'duelo' ? (s.bs[0]?.id ?? null) : null;
  }

  addTrauma(v: number): void {
    if (!this.fx.rm) this.trauma = Math.min(1, this.trauma + v);
  }

  punch(amt: number, inMs: number, outMs: number): void {
    if (this.fx.rm || amt < this.punchValue(this.time.now)) return;
    this.punchAmt = amt;
    this.punchT0 = this.time.now;
    this.punchIn = inMs;
    this.punchOut = outMs;
  }

  private punchValue(now: number): number {
    const e = now - this.punchT0;
    if (e < 0 || e >= this.punchIn + this.punchOut) return 0;
    return e < this.punchIn ? this.punchAmt * (e / this.punchIn) : this.punchAmt * (1 - (e - this.punchIn) / this.punchOut);
  }

  zoneWorld(): { x: number; y: number; r: number } {
    const z = this.snap?.z;
    if (z) {
      this.zw.x = center(z.x);
      this.zw.y = center(z.y);
      this.zw.r = z.r * TILE;
    }
    return this.zw;
  }

  texFor(e: Pick<EntSnap, 'f' | 's' | 'o'>): string {
    const look = { form: e.f, stage: e.s, order: e.o };
    const key = `cr:${lookKey(look)}`;
    if (!this.textures.exists(key)) this.textures.addCanvas(key, drawCreature(look));
    return key;
  }

  // ---------------------------------------------------------------- mundo

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
      this.fx.readPrefs();
      this.fx.prewarm();
    });
  }

  clearWorld(): void {
    for (const v of this.ents.values()) this.destroyView(v);
    this.ents.clear();
    for (const v of this.dying) this.destroyView(v);
    this.dying.length = 0;
    this.mapImg?.destroy();
    this.mapImg = null;
    for (const f of this.fruitImgs) f.destroy();
    this.fruitImgs = [];
    this.snap = null;
    this.fresh = true;
    this.camPos = null;
    this.trauma = 0;
    this.punchT0 = -1e9;
    this.bzFrom = this.bzTo = 1;
    this.bzT0 = -1e9;
    this.inBattle = null;
    this.focusOff = 0;
    if (!this.ready) return;
    this.cameras.main.setZoom(this.baseZoom);
    this.spells.clear();
    this.runes.clear();
    this.fx.killAll();
    this.zone.reset();
    this.groundG.clear();
    this.auraBackG.clear();
    this.airG.clear();
    this.bubbleG.clear();
    this.overG.clear();
  }

  private destroyView(v: EntView): void {
    v.img.destroy();
    v.label?.destroy();
  }

  private newView(e: EntSnap, key: string, res: number): EntView {
    const img = this.add.image(center(e.x), center(e.y), key).setOrigin(0.5, 0.62);
    const label =
      e.k === 'p'
        ? this.add
            .text(0, 0, '', { fontFamily: 'Nunito, sans-serif', fontSize: '7px', fontStyle: 'bold', color: '#ffffff', stroke: '#140f24', strokeThickness: 2 })
            .setOrigin(0.5, 1)
            .setDepth(1000)
            .setResolution(res)
        : null;
    const base = e.k === 'w' ? 0.8 : 1;
    img.setScale(base);
    return {
      img,
      label,
      key,
      x: center(e.x),
      y: center(e.y),
      data: e,
      base,
      px: e.x,
      py: e.y,
      ps: e.s,
      shownHp: e.hp,
      ghostHp: e.hp,
      ghostHoldUntil: 0,
      hpHoldUntil: 0,
      thickUntil: 0,
      ox: 0,
      oy: 0,
      nx: 0,
      ny: 0,
      nT0: -1e9,
      nOut: 1,
      nBack: 1,
      nBackEase: false,
      sx: 1,
      sy: 1,
      qx: 1,
      qy: 1,
      qT0: -1e9,
      qIn: 1,
      qHold: 0,
      qOut: 1,
      qSteps: 0,
      popFrom: 1,
      popT0: -1e9,
      popMs: 1,
      texSwapAt: 0,
      texPop: 1.5,
      alpha: 0,
      blinkT0: 0,
      blinkUntil: 0,
      freezeUntil: 0,
      koUntil: 0,
      flashPat: null,
      flashT0: 0,
      flashColor: 0,
      tintOn: -1,
      bob: 0,
      burning: false,
      stepAt: 0,
      dir: 1,
      acc: 0,
      burnT: 0,
      burnFlashT: 0,
      dieAt: 0,
      fadeMs: 0,
      hidden: false,
    };
  }

  applySnap(s: Snap): void {
    if (!this.ready || !this.mapImg) return;
    const prev = this.snap;
    const now = this.time.now;
    // Diffs são ignorados no primeiro snapshot após setWorld e quando a câmera troca de alvo.
    const skipDiff = this.fresh || (prev !== null && prev.view !== s.view);
    this.snap = s;
    this.fx.fighting = !!(s.me?.alive && s.me.battle !== null);
    this.zone.onSnap(s, now, this.fresh);
    this.fresh = false;

    // (1) Eventos, com as EntViews ainda vivas.
    this.marked.clear();
    if (s.fx) for (const ev of s.fx) this.onFx(ev, now);

    // (2) Entidades e diffs.
    const seen = this.seen;
    seen.clear();
    const res = Math.ceil(this.zoom() * (window.devicePixelRatio || 1));
    for (const e of s.ents) {
      seen.add(e.id);
      const key = this.texFor(e);
      let v = this.ents.get(e.id);
      if (!v) {
        v = this.newView(e, key, res);
        this.ents.set(e.id, v);
        this.tweens.add({ targets: v, alpha: 1, duration: 200 });
      } else if (v.key !== key && v.texSwapAt === 0) {
        // Sem evento (ou já liberada): troca direto, com o pop que já existia.
        v.key = key;
        v.img.setTexture(key);
        if (!skipDiff) pop(v, 1.5, 350, now);
      }
      if (!skipDiff && (e.x !== v.px || e.y !== v.py)) {
        v.stepAt = now;
        if (e.x !== v.px) v.dir = e.x > v.px ? 1 : -1;
      }
      v.px = e.x;
      v.py = e.y;
      v.ps = e.s;
      v.data = e;
      if (v.label) {
        const txt = `${e.cr ? '👑 ' : ''}${e.n ?? ''}`;
        if (v.label.text !== txt) v.label.setText(txt);
        v.label.setColor(e.id === s.me?.id ? '#ffcf3f' : e.cr ? '#ffe28a' : '#ffffff');
      }
    }

    // (3) Os marcados por 'x'/'c' ficam com o efeito; os outros saem com fade de 150 ms.
    for (const [id, v] of this.ents) {
      if (seen.has(id)) continue;
      this.ents.delete(id);
      if (this.marked.has(id)) {
        if (v.dieAt === 0) v.dieAt = now + 600;
      } else {
        v.dieAt = now + 150;
        v.fadeMs = 150;
      }
      this.dying.push(v);
    }
    const avail = new Set(s.fr);
    this.fruitImgs.forEach((img, i) => img.setVisible(avail.has(i)));
  }

  private onFx(ev: FxEvent, now: number): void {
    switch (ev.k) {
      case 'h':
        this.spells.hit(ev, now);
        return;
      case 'fu':
        this.spells.fury(ev, now);
        return;
      case 'v': {
        const v = this.ents.get(ev.id);
        if (v) this.runes.evolve(v, ev.s, now, ev.id === this.focusId());
        return;
      }
      case 'z': {
        const v = this.ents.get(ev.id);
        if (v) this.runes.crumble(v, now, 360, true);
        return;
      }
      case 's': {
        const l = this.ents.get(ev.l);
        if (l) l.koUntil = 0;
        this.runes.steal(ev, now);
        return;
      }
      case 'x': {
        this.marked.add(ev.id);
        const v = this.ents.get(ev.id);
        if (v) v.koUntil = 0;
        this.runes.eliminate(ev, v, now);
        return;
      }
      case 'c': {
        this.marked.add(ev.w);
        const v = this.ents.get(ev.w);
        if (v) {
          v.koUntil = 0;
          v.dieAt = now + 150;
          v.fadeMs = 150;
        }
        return;
      }
      default:
        return;
    }
  }

  update(_time: number, delta: number): void {
    const s = this.snap;
    if (!s) return;
    const now = this.time.now;
    const fx = this.fx;
    fx.preUpdate(now);
    this.groundG.clear();
    this.airG.clear();
    this.groundBudget = 0;
    const k = 1 - Math.exp(-delta / 60);
    const focus = s.view ?? -1;
    for (const v of this.ents.values()) {
      const e = v.data;
      const frozen = now < v.freezeUntil;
      if (!frozen) {
        const tx = center(e.x);
        const ty = center(e.y);
        v.x += (tx - v.x) * k;
        v.y += (ty - v.y) * k;
        const moving = Math.abs(tx - v.x) + Math.abs(ty - v.y) > 0.5;
        v.bob = moving ? Math.abs(Math.sin(now / 70 + e.id)) * -1.5 : Math.sin(now / 380 + e.id) * 0.6;
      }
      if (v.texSwapAt > 0 && now >= v.texSwapAt) this.swapTexture(v, now);
      this.place(v, now, frozen);
      v.label?.setPosition(v.x, v.y - 13);
      v.burning = false;
      if (s.ph !== 'duelo' && Math.hypot(e.x - s.z.x, e.y - s.z.y) >= s.z.r) this.zone.burn(v, now, delta, e.id === focus);
      else v.burnT = v.burnFlashT = 0;
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const v = this.dying[i];
      if (now >= v.dieAt) {
        this.destroyView(v);
        this.dying[i] = this.dying[this.dying.length - 1];
        this.dying.pop();
        continue;
      }
      this.place(v, now, false);
      if (v.label) v.label.setAlpha(v.img.alpha);
    }
    this.separateLabels();
    this.updateCamera(s, now, delta);
    this.zone.draw(s, now, delta);
    this.spells.update(now, delta);
    this.runes.update(now, delta);
    this.drawBubbles(s, now);
    this.drawOverlay(s, now, delta);
    fx.postUpdate(now);
  }

  private swapTexture(v: EntView, now: number): void {
    v.texSwapAt = 0;
    const key = this.texFor(v.data);
    v.key = key;
    v.img.setTexture(key);
    pop(v, v.texPop, v.texPop < 1 ? 250 : 350, now);
  }

  private place(v: EntView, now: number, frozen: boolean): void {
    const p = stepView(v, now, frozen);
    const sc = v.base * p;
    v.img
      .setPosition(v.x + v.ox, v.y + v.bob + v.oy)
      .setScale(sc * v.sx, sc * v.sy)
      .setDepth(10 + v.y / TILE)
      .setVisible(!v.hidden || now < v.dieAt - 20);
  }

  /** Empurra para cima os nomes que se sobrepõem (bichos colados numa batalha, por exemplo). */
  private separateLabels(): void {
    const labs = this.labs;
    labs.length = 0;
    for (const v of this.ents.values()) if (v.label) labs.push(v.label);
    labs.sort(byYDesc);
    const px = this.placedX;
    const py = this.placedY;
    const pw = this.placedW;
    let n = 0;
    for (const l of labs) {
      const w = l.width / 2 + 2;
      let y = l.y;
      for (let guard = 0; guard < 8; guard++) {
        let hit = -1;
        for (let j = 0; j < n; j++) {
          if (Math.abs(px[j] - l.x) < pw[j] + w && Math.abs(py[j] - y) < 8) {
            hit = j;
            break;
          }
        }
        if (hit < 0) break;
        y = py[hit] - 8;
      }
      l.setY(y);
      px[n] = l.x;
      py[n] = y;
      pw[n] = w;
      n++;
    }
  }

  // ---------------------------------------------------------------- câmera viva

  private updateCamera(s: Snap, now: number, delta: number): void {
    const cam = this.cameras.main;
    const rm = this.fx.rm;
    const target = s.view !== null ? this.ents.get(s.view) : undefined;
    let tx = target?.x ?? 0;
    let ty = target?.y ?? 0;
    // Na sua batalha, mira o ponto médio entre você e o oponente.
    const myBt = s.me?.alive ? s.me.battle : null;
    if (target && myBt !== null) {
      for (const v of this.ents.values()) {
        if (v !== target && v.data.b === myBt) {
          tx = (tx + v.x) / 2;
          ty = (ty + v.y) / 2;
          break;
        }
      }
    }
    if (myBt !== this.inBattle) {
      if (myBt !== null && this.inBattle === null) this.battleZoom(1.15, 320, now);
      else if (myBt === null) this.battleZoom(1, 400, now);
      this.inBattle = myBt;
    }
    let bz = this.bzTo;
    const be = now - this.bzT0;
    if (be < this.bzMs) bz = this.bzFrom + (this.bzTo - this.bzFrom) * CO(be / this.bzMs);
    const mul = rm ? 1 : bz * (1 + this.punchValue(now));
    const z = this.baseZoom * mul;
    if (Math.abs(cam.zoom - z) > 1e-4) cam.setZoom(z);
    if (!target) return;
    const kc = 1 - Math.exp(-delta / 120);
    if (!this.camPos) this.camPos = { x: tx, y: ty };
    this.camPos.x += (tx - this.camPos.x) * kc;
    this.camPos.y += (ty - this.camPos.y) * kc;
    const fo = this.insetPx / 2 / z;
    this.focusOff = rm ? fo : this.focusOff + (fo - this.focusOff) * kc;
    // Trauma pixelado: decai 2,2/s, amplitude 3 px × trauma².
    this.trauma = Math.max(0, this.trauma - (2.2 * delta) / 1000);
    const a = rm ? 0 : 3 * this.trauma * this.trauma;
    let ox = 0;
    let oy = 0;
    if (a > 0) {
      ox = Math.round(((a * (Math.sin(now * 0.071) + Math.sin(now * 0.113 + 1.7))) / 2) * z) / z;
      oy = Math.round(((a * (Math.sin(now * 0.089 + 0.4) + Math.sin(now * 0.131 + 2.9))) / 2) * z) / z;
    }
    cam.centerOn(this.camPos.x + ox, this.camPos.y + oy + this.focusOff);
  }

  private battleZoom(to: number, ms: number, now: number): void {
    const e = now - this.bzT0;
    this.bzFrom = e < this.bzMs ? this.bzFrom + (this.bzTo - this.bzFrom) * CO(e / this.bzMs) : this.bzTo;
    this.bzTo = to;
    this.bzT0 = now;
    this.bzMs = ms;
  }

  // ---------------------------------------------------------------- camadas por frame

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

  private drawOverlay(s: Snap, now: number, delta: number): void {
    const g = this.overG;
    g.clear();
    const myTarget = s.me?.target ?? null;
    for (const v of this.ents.values()) {
      const e = v.data;
      const mhp = Math.max(1, e.mhp);
      // HP: segura até o impacto; quedas sem golpe (zona) usam o mesmo fantasma, sem o hold.
      if (now >= v.hpHoldUntil) {
        if (e.hp < v.shownHp) {
          if (v.ghostHp <= v.shownHp) v.ghostHoldUntil = now + 350;
          v.ghostHp = Math.max(v.ghostHp, v.shownHp);
          v.shownHp = e.hp;
        } else if (e.hp > v.shownHp) v.shownHp = e.hp;
      }
      if (v.ghostHp > v.shownHp && now >= v.ghostHoldUntil) v.ghostHp = Math.max(v.shownHp, v.ghostHp - (mhp * delta) / 450);
      if (v.ghostHp < v.shownHp) v.ghostHp = v.shownHp;
      const showBar = e.k === 'p' || v.shownHp < mhp || v.ghostHp > v.shownHp || e.b !== undefined;
      if (showBar) {
        const pct = Math.max(0, v.shownHp / mhp);
        const thick = now < v.thickUntil ? 1 : 0;
        const bx = v.x - 8;
        const by = v.y + 8 - thick;
        if (v.burning && Math.floor(now / 150) & 1) {
          g.fillStyle(FXC.magenta, 1);
          g.fillRect(bx - 1, by - 1, 18, 5 + thick);
        }
        g.fillStyle(0x000000, 0.65);
        g.fillRect(bx, by, 16, 3 + thick);
        if (v.ghostHp > v.shownHp) {
          g.fillStyle(FXC.ghost, 1);
          g.fillRect(bx + 0.5, by + 0.5, 15 * Math.min(1, v.ghostHp / mhp), 2 + thick);
        }
        const blink = pct <= 0.25 && Math.floor(now / 250) & 1 ? 0.4 : 1;
        g.fillStyle(pct > 0.5 ? 0x58e07a : pct > 0.25 ? 0xffcf3f : 0xff4f6d, blink);
        g.fillRect(bx + 0.5, by + 0.5, 15 * pct, 2 + thick);
      }
      if (e.sh) {
        g.lineStyle(1, 0x7cc4ff, 0.6 + Math.sin(now / 120) * 0.3);
        g.strokeCircle(v.x, v.y, 11);
      }
      if (e.ch) {
        g.fillStyle(0xffe066, 1);
        g.fillRect(v.x + 7, v.y - 9 + Math.sin(now / 90) * 1.5, 2, 2);
      }
      if (e.id === myTarget) {
        g.lineStyle(1.5, 0xffcf3f, 0.6 + Math.sin(now / 110) * 0.35);
        g.strokeEllipse(v.x, v.y + 7, 20, 8);
      }
    }
    if (this.dest && now < this.dest.until) {
      const x = center(this.dest.x);
      const y = center(this.dest.y);
      const a = (this.dest.until - now) / 900;
      g.lineStyle(1.5, 0xffffff, a);
      g.lineBetween(x - 3, y - 3, x + 3, y + 3);
      g.lineBetween(x - 3, y + 3, x + 3, y - 3);
    }
  }

  /** Estatísticas para testes (partículas vivas e tier). */
  fxStats(): { alive: number; tier: number; rm: boolean; wisp: number; pixels: number } {
    const fx = this.fx;
    return { alive: fx.alive(), tier: fx.tier, rm: fx.rm, wisp: fx.wisp.getAliveParticleCount(), pixels: fx.pixels.getAliveParticleCount() };
  }
}
