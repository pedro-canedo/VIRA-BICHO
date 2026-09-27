import { BALANCE, FORM_LABEL, STAGE_LABEL, speciesName, type Fruit, type Snap } from '@vb/shared';
import { creatureImg, lookKey } from '../render/creature';
import { renderMinimap } from '../render/map';
import { ELEM_TONE, FORM_COLOR } from '../render/palette';
import { fmtTime, h, mount } from './dom';

const SHORT_STAGE = ['Ovo', 'Filhote', 'Adulto', 'Final'] as const;

const PHASE_INFO: Record<string, { label: string; next: string; at: number }> = {
  coleta: { label: 'COLETA', next: 'Caçada em', at: BALANCE.phases.coletaEnd },
  cacada: { label: 'CAÇADA', next: 'Final em', at: BALANCE.phases.cacadaEnd },
  final: { label: 'FINAL', next: 'Duelo Final em', at: BALANCE.phases.finalEnd },
};

export class Hud {
  private root: HTMLElement;
  private phaseEl = h('div', { class: 'phase' });
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
  private creatureSlot = h('div');
  private meText = h('div');

  constructor() {
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
    const outside = me?.alive && s.ph !== 'duelo' && Math.hypot(me.x - s.z.x, me.y - s.z.y) >= s.z.r;
    this.phaseEl.className = `phase${outside || s.ph === 'duelo' ? ' danger' : ''}`;
    if (s.ph === 'duelo' && s.duel) {
      this.phaseEl.replaceChildren(h('span', {}, '⚔ DUELO FINAL'), h('span', { class: 'clock' }, `${s.duel.a} × ${s.duel.b}`));
    } else {
      const info = PHASE_INFO[s.ph] ?? PHASE_INFO.final;
      this.phaseEl.replaceChildren(
        h('span', {}, outside ? '⚠ FORA DA ZONA' : info.label),
        h('span', { class: 'clock' }, `${info.next} ${fmtTime(info.at - s.el)}`),
      );
    }
    this.aliveEl.textContent = `🐾 ${s.al} vivos`;

    this.boardEl.replaceChildren(
      ...s.lb.slice(0, 10).map((r) =>
        h(
          'div',
          { class: r.id === me?.id ? 'me-row' : '' },
          h('span', { class: 'dot', style: `background:${FORM_COLOR[r.f]}` }),
          h('span', {}, `${r.cr ? '👑 ' : ''}${r.n}`),
          h('span', { class: 'muted', style: 'margin-left:auto' }, SHORT_STAGE[r.s]),
        ),
      ),
    );

    if (me) this.updateMe(s);
    this.drawMinimap(s);
  }

  private updateMe(s: Snap): void {
    const me = s.me!;
    const key = lookKey(me.look);
    if (key !== this.lastLook) {
      this.lastLook = key;
      this.creatureSlot.replaceChildren(creatureImg(me.look, 2));
    }
    const total = me.points.brasa + me.points.mare + me.points.broto || 1;
    const statuses: string[] = [];
    if (me.crown) statuses.push('👑 Coroa');
    if (me.trophies) statuses.push(`🏆×${me.trophies}`);
    if (me.shieldMs > 0) statuses.push(`🛡️ ${Math.ceil(me.shieldMs / 1000)}s`);
    if (me.hungerMs > 0) statuses.push(`🍖 Fome ${Math.ceil(me.hungerMs / 1000)}s`);
    this.meText.replaceChildren(
      h('div', { class: 'name' }, speciesName(me.look.form, me.look.stage)),
      h('div', { class: 'species' }, `${FORM_LABEL[me.look.form]} · ${STAGE_LABEL[me.look.stage]}`),
    );
    this.meEl.replaceChildren(
      this.creatureSlot,
      this.meText,
      h('div', { class: 'small muted' }, me.alive ? `❤ ${me.hp}/${me.mhp}` : 'Eliminado'),
      h(
        'div',
        { class: 'bars' },
        h('div', { class: 'bar' }, h('i', { style: `width:${(100 * me.hp) / me.mhp}%` })),
        h('div', { class: 'bar xp', title: 'XP' }, h('i', { style: `width:${me.xpNeed ? (100 * me.xp) / me.xpNeed : 100}%` })),
      ),
      h(
        'div',
        { class: 'types' },
        ...(['brasa', 'mare', 'broto'] as const).map((e) =>
          h('span', { style: `background:${ELEM_TONE[e].body};opacity:${0.35 + (0.65 * me.points[e]) / total}` }, `${e === 'brasa' ? '🔥' : e === 'mare' ? '🌊' : '🌿'}${me.points[e]}`),
        ),
      ),
      h('div', { class: 'status' }, ...statuses.map((t) => h('span', {}, t))),
    );
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
