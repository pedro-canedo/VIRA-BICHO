import { BALANCE, FORM_LABEL, STAGE_LABEL, speciesName, type Elem, type Fruit, type Snap } from '@vb/shared';
import { creatureImg, lookKey } from '../render/creature';
import { renderMinimap } from '../render/map';
import { ELEM_TONE, FORM_COLOR } from '../render/palette';
import { countTo, GhostBar } from './anim';
import { fmtTime, h, mount } from './dom';

const SHORT_STAGE = ['Ovo', 'Filhote', 'Adulto', 'Final'] as const;
const ELEM_ICON: Record<Elem, string> = { brasa: '🔥', mare: '🌊', broto: '🌿' };

const PHASE_INFO: Record<string, { label: string; next: string; at: number }> = {
  coleta: { label: 'COLETA', next: 'Caçada em', at: BALANCE.phases.coletaEnd },
  cacada: { label: 'CAÇADA', next: 'Final em', at: BALANCE.phases.cacadaEnd },
  final: { label: 'FINAL', next: 'Duelo Final em', at: BALANCE.phases.finalEnd },
};

/** Troca o texto só quando muda (não reinicia animações nem gera lixo à toa). */
function setText(el: HTMLElement, v: string): void {
  if (el.textContent !== v) el.textContent = v;
}

function toggle(el: HTMLElement, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

interface BoardRow {
  el: HTMLElement;
  dot: HTMLElement;
  name: HTMLElement;
  stage: HTMLElement;
  key: string;
}

/** HUD da partida. Os nós são criados uma vez; cada snapshot só mexe no que mudou. */
export class Hud {
  private root: HTMLElement;
  private phaseEl = h('div', { class: 'phase' });
  private phaseLabel = h('span');
  private clockEl = h('span', { class: 'clock' });
  private meEl = h('div', { class: 'me' });
  private mini = h('canvas', { class: 'minimap', width: 224, height: 224 }) as HTMLCanvasElement;
  private aliveEl = h('div', { class: 'alive' });
  private boardEl = h('div', { class: 'board' });
  private feedEl = h('div', { class: 'feed' });
  private toastEl = h('div', { class: 'toasts' });
  private miniBase: HTMLCanvasElement | null = null;
  private mapW = 1;
  private fruits: Fruit[] = [];
  private lastLook = '';
  private creatureSlot = h('div', { class: 'portrait' });
  private nameEl = h('div', { class: 'name' });
  private speciesEl = h('div', { class: 'species' });
  private hpText = h('div', { class: 'small muted hptext' });
  private hpBar = new GhostBar();
  private xpFill = h('i');
  private chips = {} as Record<Elem, { el: HTMLElement; key: string }>;
  private st = {
    crown: h('span', { class: 'hidden' }, '👑 Coroa'),
    trophies: h('span', { class: 'hidden' }),
    shield: h('span', { class: 'hidden' }),
    hunger: h('span', { class: 'hidden' }),
  };
  private rows: BoardRow[] = [];
  private last = { phaseCls: '', alive: -1, hp: -1, mhp: -1, dead: false, xp: '' };

  constructor() {
    for (const e of ['brasa', 'mare', 'broto'] as const) this.chips[e] = { el: h('span', { style: `background:${ELEM_TONE[e].body}` }), key: '' };
    for (let i = 0; i < 10; i++) {
      const dot = h('span', { class: 'dot' });
      const name = h('span');
      const stage = h('span', { class: 'muted', style: 'margin-left:auto' });
      this.rows.push({ el: h('div', { class: 'hidden' }, dot, name, stage), dot, name, stage, key: '' });
    }
    this.phaseEl.append(this.phaseLabel, this.clockEl);
    this.meEl.append(
      this.creatureSlot,
      h('div', {}, this.nameEl, this.speciesEl),
      this.hpText,
      h('div', { class: 'bars' }, this.hpBar.el, h('div', { class: 'bar xp', title: 'XP' }, this.xpFill)),
      h('div', { class: 'types' }, this.chips.brasa.el, this.chips.mare.el, this.chips.broto.el),
      h('div', { class: 'status' }, this.st.crown, this.st.trophies, this.st.shield, this.st.hunger),
    );
    this.boardEl.append(...this.rows.map((r) => r.el));
    this.root = mount(
      h(
        'div',
        {},
        h('div', { class: 'hud-top' }, this.phaseEl),
        this.meEl,
        h('div', { class: 'side' }, this.mini, this.aliveEl, this.boardEl),
        this.feedEl,
        this.toastEl,
        h('div', { class: 'hint' }, 'Toque no chão para andar · toque num bicho para batalhar'),
      ),
    );
  }

  destroy(): void {
    this.root.remove();
  }

  setMap(w: number, hgt: number, tiles: Uint8Array, fruits: Fruit[]): void {
    this.miniBase = renderMinimap(w, hgt, tiles);
    this.mapW = w;
    this.fruits = fruits;
  }

  feed(text: string, kind: string): void {
    const cls = kind === 'phase' ? 'phase-msg' : kind;
    this.feedEl.append(h('div', { class: cls }, text));
    while (this.feedEl.children.length > 6) this.feedEl.firstElementChild!.remove();
    const el = this.feedEl.lastElementChild!;
    window.setTimeout(() => el.remove(), 9000);
  }

  toast(text: string): void {
    const el = h('div', { class: 'toast' }, text);
    this.toastEl.append(el);
    while (this.toastEl.children.length > 3) this.toastEl.firstElementChild!.remove();
    window.setTimeout(() => el.remove(), 2600);
  }

  update(s: Snap): void {
    const me = s.me;
    const outside = !!me?.alive && s.ph !== 'duelo' && Math.hypot(me.x - s.z.x, me.y - s.z.y) >= s.z.r;
    const phaseCls = `phase${outside || s.ph === 'duelo' ? ' danger' : ''}`;
    if (phaseCls !== this.last.phaseCls) this.phaseEl.className = this.last.phaseCls = phaseCls;
    if (s.ph === 'duelo' && s.duel) {
      setText(this.phaseLabel, '⚔ DUELO FINAL');
      setText(this.clockEl, `${s.duel.a} × ${s.duel.b}`);
    } else {
      const info = PHASE_INFO[s.ph] ?? PHASE_INFO.final;
      setText(this.phaseLabel, outside ? '⚠ FORA DA ZONA' : info.label);
      setText(this.clockEl, `${info.next} ${fmtTime(info.at - s.el)}`);
    }
    if (s.al !== this.last.alive) {
      this.last.alive = s.al;
      this.aliveEl.textContent = `🐾 ${s.al} vivos`;
    }

    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const r = s.lb[i];
      const key = r ? `${r.id}|${r.f}|${r.s}|${r.cr ?? 0}|${r.n}|${r.id === me?.id ? 1 : 0}` : '';
      if (key === row.key) continue;
      row.key = key;
      toggle(row.el, 'hidden', !r);
      if (!r) continue;
      row.el.className = r.id === me?.id ? 'me-row' : '';
      row.dot.style.background = FORM_COLOR[r.f];
      row.name.textContent = `${r.cr ? '👑 ' : ''}${r.n}`;
      row.stage.textContent = SHORT_STAGE[r.s];
    }

    if (me) this.updateMe(s);
    this.drawMinimap(s);
  }

  private updateMe(s: Snap): void {
    const me = s.me!;
    const key = lookKey(me.look);
    if (key !== this.lastLook) {
      this.lastLook = key;
      this.creatureSlot.replaceChildren(creatureImg(me.look, 2));
      setText(this.nameEl, speciesName(me.look.form, me.look.stage));
      setText(this.speciesEl, `${FORM_LABEL[me.look.form]} · ${STAGE_LABEL[me.look.stage]}`);
    }

    const dead = !me.alive;
    if (dead) {
      if (!this.last.dead) setText(this.hpText, 'Eliminado');
    } else if (me.hp !== this.last.hp || me.mhp !== this.last.mhp || this.last.dead) {
      const from = this.last.hp < 0 || me.mhp !== this.last.mhp ? me.hp : this.last.hp;
      const mhp = me.mhp;
      countTo(this.hpText, from, me.hp, 300, (n) => `❤ ${n}/${mhp}`);
    }
    this.last.dead = dead;
    this.last.hp = me.hp;
    this.last.mhp = me.mhp;
    this.hpBar.set(me.mhp ? me.hp / me.mhp : 0);

    const xp = `scaleX(${me.xpNeed ? Math.min(1, me.xp / me.xpNeed) : 1})`;
    if (xp !== this.last.xp) this.xpFill.style.transform = this.last.xp = xp;

    const total = me.points.brasa + me.points.mare + me.points.broto || 1;
    for (const e of ['brasa', 'mare', 'broto'] as const) {
      const c = this.chips[e];
      const k = `${me.points[e]}|${total}`;
      if (k === c.key) continue;
      c.key = k;
      c.el.textContent = `${ELEM_ICON[e]}${me.points[e]}`;
      c.el.style.opacity = String(0.35 + (0.65 * me.points[e]) / total);
    }

    toggle(this.st.crown, 'hidden', !me.crown);
    toggle(this.st.trophies, 'hidden', !me.trophies);
    if (me.trophies) setText(this.st.trophies, `🏆×${me.trophies}`);
    toggle(this.st.shield, 'hidden', !(me.shieldMs > 0));
    if (me.shieldMs > 0) setText(this.st.shield, `🛡️ ${Math.ceil(me.shieldMs / 1000)}s`);
    toggle(this.st.hunger, 'hidden', !(me.hungerMs > 0));
    if (me.hungerMs > 0) setText(this.st.hunger, `🍖 Fome ${Math.ceil(me.hungerMs / 1000)}s`);
  }

  private drawMinimap(s: Snap): void {
    if (!this.miniBase) return;
    const c = this.mini;
    const ctx = c.getContext('2d')!;
    const k = c.width / this.mapW;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(this.miniBase, 0, 0, c.width, c.height);
    // Zona: escurece fora do círculo
    ctx.save();
    ctx.fillStyle = 'rgba(40, 8, 60, 0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, c.width, c.height);
    ctx.arc((s.z.x + 0.5) * k, (s.z.y + 0.5) * k, Math.max(0, s.z.r * k), 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#ff5fd2';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc((s.z.x + 0.5) * k, (s.z.y + 0.5) * k, Math.max(0, s.z.r * k), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.arc((s.z.x + 0.5) * k, (s.z.y + 0.5) * k, Math.max(0, s.z.tr * k), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    for (const i of s.fr) {
      const f = this.fruits[i];
      if (!f) continue;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(f.x * k - 2, f.y * k - 2, 5, 5);
      ctx.fillStyle = ELEM_TONE[f.elem].body;
      ctx.fillRect(f.x * k - 1, f.y * k - 1, 3, 3);
    }
    for (const e of s.ents) {
      if (e.k !== 'p' || e.id === s.me?.id) continue;
      ctx.fillStyle = e.cr ? '#ffcf3f' : '#ff4f6d';
      ctx.fillRect(e.x * k - 2, e.y * k - 2, 5, 5);
    }
    if (s.crown && Math.floor(performance.now() / 250) % 2 === 0) {
      ctx.fillStyle = '#ffcf3f';
      ctx.font = '18px sans-serif';
      ctx.fillText('👑', s.crown.x * k - 9, s.crown.y * k + 6);
    }
    if (s.me?.alive) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(s.me.x * k - 4, s.me.y * k - 4, 9, 9);
      ctx.fillStyle = '#ffcf3f';
      ctx.fillRect(s.me.x * k - 3, s.me.y * k - 3, 7, 7);
    }
  }
}
