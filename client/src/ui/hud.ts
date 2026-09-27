import { BALANCE, ELEMS, FORM_LABEL, STAGE_LABEL, speciesName, type Elem, type FxEvent, type Fruit, type Phase, type SelfSnap, type Snap, type TypePoints } from '@vb/shared';
import { creatureImg, lookKey } from '../render/creature';
import { renderMinimap } from '../render/map';
import { ELEM_TONE, FORM_COLOR } from '../render/palette';
import { Anims, countTo, GhostBar, later, play, reduced, typeText } from './anim';
import { fmtTime, h, mount } from './dom';
import { burst, RAMP } from './fxcanvas';
import { PHASE_LOOK, PhaseSeal } from './phase';

const SHORT_STAGE = ['Ovo', 'Filhote', 'Adulto', 'Final'] as const;
const ELEM_ICON: Record<Elem, string> = { brasa: '🔥', mare: '🌊', broto: '🌿' };
const FEED_ICON: Record<string, string> = { steal: '⚔', elim: '💀', evo: '✨', phase: '⏳', info: '📢' };
const FEED_COLOR: Record<string, string> = { steal: '#ffcf3f', elim: '#ff5fd2', evo: '#58e07a', info: '#aa9fcc' };
const NO_FX: FxEvent[] = [];

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
  id: number;
}

interface Gain {
  n: number;
  color: string;
}

/** HUD da partida. Os nós são criados uma vez; cada snapshot só mexe no que mudou. */
export class Hud {
  private root: HTMLElement;
  private fx = new Anims();
  private seal = new PhaseSeal();
  private dangerZone = h('div', { class: 'danger zone' });
  private dangerHp = h('div', { class: 'danger hp' });
  private phaseEl = h('div', { class: 'phase' });
  private phaseLabel = h('span');
  private clockEl = h('span', { class: 'clock' });
  private evoBand = h('div', { class: 'evoband' }, 'EVOLUIU!');
  private meEl = h('div', { class: 'me' });
  private mini = h('canvas', { class: 'minimap', width: 224, height: 224 }) as HTMLCanvasElement;
  private aliveNum = h('span', { class: 'anum' });
  private aliveWrap = h('span', { class: 'anw' }, this.aliveNum);
  private aliveEl = h('div', { class: 'alive' }, '🐾 ', this.aliveWrap, ' vivos');
  private boardEl = h('div', { class: 'board' });
  private feedEl = h('div', { class: 'feed' });
  private toastEl = h('div', { class: 'toasts' });
  private miniBase: HTMLCanvasElement | null = null;
  private mapW = 1;
  private fruits: Fruit[] = [];
  private lastLook = '';
  private lastStage = -1;
  private lastPhase: Phase | '' = '';
  private clockSec = 0;
  private creatureSlot = h('div', { class: 'portrait' });
  private nameEl = h('div', { class: 'name' });
  private speciesEl = h('div', { class: 'species' });
  private hpText = h('div', { class: 'small muted hptext' });
  private hpBar = new GhostBar();
  private xpFill = h('i');
  private xpTip = h('u');
  private xpBar = h('div', { class: 'bar xp', title: 'XP' }, this.xpFill, this.xpTip);
  private chips = {} as Record<Elem, { el: HTMLElement; n: number; key: string }>;
  private st = {
    crown: h('span', { class: 'hidden' }, '👑 Coroa'),
    trophies: h('span', { class: 'hidden' }),
    shield: h('span', { class: 'st-shield hidden' }),
    hunger: h('span', { class: 'st-hunger hidden' }),
  };
  private rows: BoardRow[] = [];
  private rowOf = new Map<number, BoardRow>();
  private order = '';
  private myRank = -1;
  /** 5 orbes de XP reaproveitados. */
  private orbs: HTMLElement[] = [];
  /** Enquanto os orbes voam, a barra de XP e os chips esperam a chegada. */
  private held = false;
  private latest: SelfSnap | null = null;
  private prev: { pts: TypePoints; xp: number; stage: number } | null = null;
  private last = { phaseCls: '', alive: -1, hp: -1, mhp: -1, dead: false, xp: '', xpFrac: 0, ramp: '' };

  constructor() {
    for (const e of ELEMS) this.chips[e] = { el: h('span', { style: `background:${ELEM_TONE[e].body}` }), n: -1, key: '' };
    for (let i = 0; i < 10; i++) {
      const dot = h('span', { class: 'dot' });
      const name = h('span');
      const stage = h('span', { class: 'muted', style: 'margin-left:auto' });
      this.rows.push({ el: h('div', { class: 'hidden' }, dot, name, stage), dot, name, stage, key: '', id: -1 });
    }
    for (let i = 0; i < 5; i++) this.orbs.push(h('i', { class: 'orb' }));
    this.phaseEl.append(this.phaseLabel, this.clockEl);
    this.meEl.append(
      this.creatureSlot,
      h('div', {}, this.nameEl, this.speciesEl),
      this.hpText,
      h('div', { class: 'bars' }, this.hpBar.el, this.xpBar),
      h('div', { class: 'types' }, this.chips.brasa.el, this.chips.mare.el, this.chips.broto.el),
      h('div', { class: 'status' }, this.st.crown, this.st.trophies, this.st.shield, this.st.hunger),
    );
    this.boardEl.append(...this.rows.map((r) => r.el));
    this.root = mount(
      h(
        'div',
        {},
        // Vinhetas de perigo: primeiras da raiz, abaixo dos cartões
        this.dangerZone,
        this.dangerHp,
        h('div', { class: 'hud-top' }, this.phaseEl, this.evoBand),
        this.meEl,
        h('div', { class: 'side' }, this.mini, this.aliveEl, this.boardEl),
        this.feedEl,
        this.toastEl,
        h('div', { class: 'hint' }, 'Toque no chão para andar · toque num bicho para batalhar'),
        this.seal.el,
        ...this.orbs,
      ),
    );
  }

  destroy(): void {
    this.fx.cancel();
    this.seal.destroy();
    this.root.remove();
  }

  setMap(w: number, hgt: number, tiles: Uint8Array, fruits: Fruit[]): void {
    this.miniBase = renderMinimap(w, hgt, tiles);
    this.mapW = w;
    this.fruits = fruits;
  }

  private phaseColor(text: string): string {
    const ph: Phase | '' = /DUELO/.test(text) ? 'duelo' : /Caçada/.test(text) ? 'cacada' : /[Ff]ase final/.test(text) ? 'final' : /Coleta/.test(text) ? 'coleta' : this.lastPhase;
    return (ph && PHASE_LOOK[ph]?.color) || '#b98cff';
  }

  feed(text: string, kind: string): void {
    const cls = kind === 'phase' ? 'phase-msg' : kind;
    const color = kind === 'phase' ? this.phaseColor(text) : FEED_COLOR[kind] ?? '#aa9fcc';
    const el = h('div', { class: cls, style: `--fc:${color}` }, h('i', { class: 'ficon' }, FEED_ICON[kind] ?? '•'), h('span', {}, text));
    // Evolução na cor do elemento de quem evoluiu (o nome abre a mensagem)
    if (kind === 'evo') {
      const who = this.lbForms.find(([n]) => text.startsWith(n));
      if (who) el.style.setProperty('--fc', FORM_COLOR[who[1]]);
    }
    this.feedEl.append(el);
    while (this.feedEl.children.length > 6) this.feedEl.firstElementChild!.remove();
    window.setTimeout(() => el.remove(), 9000);
  }

  toast(text: string): void {
    const el = h('div', { class: 'toast' }, text);
    this.toastEl.append(el);
    while (this.toastEl.children.length > 3) this.toastEl.firstElementChild!.remove();
    window.setTimeout(() => el.remove(), 2600);
  }

  /** Nome e forma dos jogadores conhecidos (para colorir o feed). */
  private lbForms: [string, Snap['lb'][number]['f']][] = [];

  update(s: Snap): void {
    const me = s.me;
    const mine = this.myFx(s);
    if (s.ph !== this.lastPhase) {
      this.lastPhase = s.ph;
      this.seal.show(s.ph);
    }
    const outside = !!me?.alive && s.ph !== 'duelo' && Math.hypot(me.x - s.z.x, me.y - s.z.y) >= s.z.r;
    const phaseCls = `phase${outside || s.ph === 'duelo' ? ' danger' : ''}`;
    if (phaseCls !== this.last.phaseCls) this.phaseEl.className = this.last.phaseCls = phaseCls;
    if (s.ph === 'duelo' && s.duel) {
      setText(this.phaseLabel, '⚔ DUELO FINAL');
      setText(this.clockEl, `${s.duel.a} × ${s.duel.b}`);
      this.clockTension(0);
    } else {
      const info = PHASE_INFO[s.ph] ?? PHASE_INFO.final;
      setText(this.phaseLabel, outside ? '⚠ FORA DA ZONA' : info.label);
      setText(this.clockEl, `${info.next} ${fmtTime(info.at - s.el)}`);
      this.clockTension(s.ph === 'fim' ? 0 : info.at - s.el);
    }
    this.updateAlive(s.al);
    this.updateBoard(s);

    // Vinheta de perigo: fora da zona ou HP baixo fora de batalha
    const hpLow = !!me?.alive && me.battle === null && me.mhp > 0 && me.hp / me.mhp <= 0.25;
    toggle(this.dangerZone, 'on', outside);
    toggle(this.dangerHp, 'on', hpLow && !outside);
    if (outside && me && this.last.hp >= 0 && me.hp < this.last.hp) play(this.dangerZone, [{ opacity: 1 }, { opacity: 1 }], { duration: 120 }, this.fx);

    if (me) this.updateMe(s, mine);
    this.drawMinimap(s);
  }

  /** Só os eventos do próprio jogador. */
  private myFx(s: Snap): FxEvent[] {
    const id = s.me?.id;
    if (!s.fx || id === undefined) return NO_FX;
    return s.fx.filter((e) => (e.k === 'c' && e.p === id) || ((e.k === 'v' || e.k === 'z' || e.k === 'x') && e.id === id) || (e.k === 's' && (e.l === id || e.w === id)));
  }

  /** Relógio tenso: pula a cada segundo nos últimos 10 s e fica vermelho nos últimos 5 s. */
  private clockTension(rem: number): void {
    const sec = rem > 0 && rem <= 10_000 ? Math.ceil(rem / 1000) : 0;
    if (sec !== this.clockSec) {
      this.clockSec = sec;
      if (sec && !reduced()) play(this.clockEl, [{ scale: '1.15' }, { scale: '1' }], { duration: 200, easing: 'steps(2)' }, this.fx);
    }
    toggle(this.clockEl, 'hot', rem > 0 && rem <= 5000);
  }

  private updateAlive(al: number): void {
    const old = this.last.alive;
    if (al === old) return;
    this.last.alive = al;
    this.aliveNum.textContent = String(al);
    if (old < 0) return;
    const drop = al < old;
    if (reduced()) {
      if (drop) play(this.aliveEl, [{ color: '#ff4f6d' }, { color: '#ff4f6d' }], { duration: 300 }, this.fx);
      return;
    }
    // O número antigo sobe e some; o novo entra de baixo
    const ghost = h('span', { class: 'aold' }, String(old));
    this.aliveWrap.append(ghost);
    play(ghost, [{ translate: '0 0', opacity: 1 }, { translate: '0 -8px', opacity: 0 }], { duration: 220, easing: 'steps(4)', fill: 'forwards' });
    window.setTimeout(() => ghost.remove(), 240);
    play(this.aliveNum, [{ translate: '0 8px', opacity: 0 }, { translate: '0 0', opacity: 1 }], { duration: 220, easing: 'steps(4)' }, this.fx);
    if (drop) {
      play(this.aliveWrap, [{ scale: '1.2' }, { scale: '1' }], { duration: 220, easing: 'steps(2)' }, this.fx);
      play(this.aliveEl, [{ color: '#ff4f6d' }, { color: '#ff4f6d' }], { duration: 300 }, this.fx);
    }
  }

  /** Ranking com linhas persistentes que deslizam para a posição nova (FLIP). */
  private updateBoard(s: Snap): void {
    const me = s.me;
    const lb = s.lb.length > this.rows.length ? s.lb.slice(0, this.rows.length) : s.lb;
    const ids = lb.map((r) => r.id).join(',');
    if (ids !== this.order) {
      this.order = ids;
      this.lbForms = lb.map((r) => [r.n, r.f]);
      const flip = !reduced() && this.boardEl.offsetParent !== null;
      const before = new Map<number, number>();
      if (flip) for (const [id, r] of this.rowOf) before.set(id, r.el.offsetTop);
      const next = new Map<number, BoardRow>();
      const free = this.rows.filter((r) => !lb.some((l) => l.id === r.id));
      for (const l of lb) {
        let r = this.rowOf.get(l.id);
        if (!r) {
          r = free.shift()!;
          r.id = l.id;
          r.key = '';
        }
        next.set(l.id, r);
      }
      for (const r of free) {
        r.id = -1;
        r.key = '';
        toggle(r.el, 'hidden', true);
      }
      this.rowOf = next;
      this.boardEl.append(...[...next.values()].map((r) => r.el), ...free.map((r) => r.el));
      for (const r of next.values()) toggle(r.el, 'hidden', false);
      if (flip) {
        for (const [id, r] of next) {
          const y0 = before.get(id);
          if (y0 === undefined) continue;
          const dy = y0 - r.el.offsetTop;
          if (dy) play(r.el, [{ translate: `0 ${dy}px` }, { translate: '0 0' }], { duration: 200, easing: 'steps(4)' }, this.fx);
        }
      }
    }
    for (const l of lb) {
      const row = this.rowOf.get(l.id)!;
      const isMe = l.id === me?.id;
      const key = `${l.f}|${l.s}|${l.cr ?? 0}|${l.n}|${isMe ? 1 : 0}`;
      if (key === row.key) continue;
      row.key = key;
      row.el.className = `${isMe ? 'me-row' : ''}${l.cr ? ' crown-row' : ''}`;
      row.dot.style.background = FORM_COLOR[l.f];
      row.name.textContent = `${l.cr ? '👑 ' : ''}${l.n}`;
      row.stage.textContent = SHORT_STAGE[l.s];
    }
    // Sua linha pisca dourada quando você sobe no ranking
    const rank = me ? lb.findIndex((l) => l.id === me.id) : -1;
    if (rank >= 0 && this.myRank >= 0 && rank < this.myRank && !reduced()) {
      const row = this.rowOf.get(me!.id)!;
      play(row.el, [{ background: 'rgba(255,207,63,.35)' }, { background: 'rgba(255,207,63,.35)', offset: 0.5 }, { background: 'transparent', offset: 0.5 }, { background: 'transparent' }], { duration: 200, iterations: 3 }, this.fx);
    }
    this.myRank = rank;
  }

  private updateMe(s: Snap, mine: FxEvent[]): void {
    const me = s.me!;
    const key = lookKey(me.look);
    if (key !== this.lastLook) {
      const prevStage = this.lastStage;
      this.lastLook = key;
      this.lastStage = me.look.stage;
      this.creatureSlot.replaceChildren(creatureImg(me.look, 2));
      const name = speciesName(me.look.form, me.look.stage);
      setText(this.speciesEl, `${FORM_LABEL[me.look.form]} · ${STAGE_LABEL[me.look.stage]}`);
      this.meEl.style.setProperty('--fc', FORM_COLOR[me.look.form]);
      toggle(this.meEl, 'final', me.look.stage === 3);
      const ramp = RAMP[me.look.form];
      const grad = ramp.length > 3 ? ramp.join(',') : `${ramp[2]},${ramp[1]},${ramp[0]}`;
      if (grad !== this.last.ramp) this.xpFill.style.background = `linear-gradient(90deg,${(this.last.ramp = grad)})`;
      const up = prevStage >= 0 && (me.look.stage > prevStage || mine.some((e) => e.k === 'v'));
      const down = prevStage >= 0 && (me.look.stage < prevStage || mine.some((e) => (e.k === 's' && e.l === me.id) || e.k === 'z'));
      if (up && me.alive) this.evolved(me, name);
      else {
        this.nameEl.textContent = name;
        if (down && me.alive) this.lostStage();
      }
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

    // XP e pontos: os orbes voam do bicho até a barra; ela e os chips esperam a chegada
    this.latest = me;
    const gain = this.gain(me, mine);
    if (gain && !reduced() && !this.held) this.launchOrbs(me, gain);
    if (!this.held) this.applyXp(me, false);

    toggle(this.st.crown, 'hidden', !me.crown);
    toggle(this.st.trophies, 'hidden', !me.trophies);
    if (me.trophies) setText(this.st.trophies, `🏆×${me.trophies}`);
    toggle(this.st.shield, 'hidden', !(me.shieldMs > 0));
    if (me.shieldMs > 0) setText(this.st.shield, `Escudo ${Math.ceil(me.shieldMs / 1000)}s`);
    toggle(this.st.hunger, 'hidden', !(me.hungerMs > 0));
    if (me.hungerMs > 0) setText(this.st.hunger, `Fome ${Math.ceil(me.hungerMs / 1000)}s`);
  }

  /** Ganho de XP ou de pontos desde o último snapshot (ou evento 'c' seu). */
  private gain(me: SelfSnap, mine: FxEvent[]): Gain | null {
    const p = this.prev;
    this.prev = { pts: { ...me.points }, xp: me.xp, stage: me.look.stage };
    if (!p || !me.alive) return null;
    const eat = mine.find((e) => e.k === 'c');
    let sum = 0;
    let fruit: Elem | null = null;
    for (const e of ELEMS) {
      const d = me.points[e] - p.pts[e];
      if (d > 0) sum += d;
      if (d === BALANCE.fruitPoints) fruit = e;
    }
    const up = sum > 0 || me.look.stage > p.stage || (me.look.stage === p.stage && me.xp > p.xp) || !!eat;
    if (!up) return null;
    if (!eat && fruit && sum === BALANCE.fruitPoints) return { n: 3, color: ELEM_TONE[fruit].body };
    return { n: me.hungerMs > 0 || (eat?.k === 'c' && eat.x2) ? 5 : 3, color: '#ffcf3f' };
  }

  private launchOrbs(me: SelfSnap, g: Gain): void {
    // Origem: onde o mundo mantém o seu bicho (centro da área acima do painel de batalha)
    const panel = document.querySelector('.battle');
    const from = { x: innerWidth / 2, y: (panel ? panel.getBoundingClientRect().top : innerHeight) / 2 };
    const r = this.xpBar.getBoundingClientRect();
    const frac = me.xpNeed ? Math.min(1, me.xp / me.xpNeed) : 1;
    const to = { x: r.left + Math.max(3, r.width * frac - 3), y: r.top + r.height / 2 };
    this.held = true;
    let end = 0;
    for (let i = 0; i < g.n; i++) {
      const orb = this.orbs[i];
      orb.style.setProperty('--oc', g.color);
      // Curva quadrática com um ponto de controle deslocado para o lado
      const bend = (i % 2 ? -1 : 1) * (60 + Math.random() * 80);
      const cx = (from.x + to.x) / 2 + bend;
      const cy = Math.min(from.y, to.y) - 40 - Math.random() * 60;
      const kf: Keyframe[] = [];
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * cx + t * t * to.x;
        const y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * cy + t * t * to.y;
        kf.push({ transform: `translate(${Math.round(x - 3)}px, ${Math.round(y - 3)}px)`, opacity: 1 });
      }
      const dur = 500 + Math.random() * 200;
      const delay = i * 60;
      play(orb, kf, { duration: dur, delay, easing: 'ease-in' }, this.fx);
      end = Math.max(end, delay + dur);
      later(delay + dur, () => this.orbArrive(i === 0), this.fx);
    }
    later(end + 10, () => {
      this.held = false;
      if (this.latest) this.applyXp(this.latest, true);
    }, this.fx);
  }

  /** Cada orbe que chega: a barra engole e avança com uma ponta branca. */
  private orbArrive(first: boolean): void {
    if (first && this.latest) this.applyXp(this.latest, true);
    play(this.xpBar, [{ scale: '1 1.4' }, { scale: '1 1' }], { duration: 120, easing: 'steps(2)' }, this.fx);
    this.xpTip.style.left = `calc(${(this.last.xpFrac * 100).toFixed(1)}% - 2px)`;
    play(this.xpTip, [{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: 200 }, this.fx);
  }

  private applyXp(me: SelfSnap, arrived: boolean): void {
    const frac = me.xpNeed ? Math.min(1, me.xp / me.xpNeed) : 1;
    const xp = `scaleX(${frac})`;
    if (xp !== this.last.xp) this.xpFill.style.transform = this.last.xp = xp;
    this.last.xpFrac = frac;

    const total = me.points.brasa + me.points.mare + me.points.broto || 1;
    for (const e of ELEMS) {
      const c = this.chips[e];
      const n = me.points[e];
      const k = `${n}|${total}`;
      if (k === c.key) continue;
      c.key = k;
      const old = c.n;
      c.n = n;
      countTo(c.el, old < 0 ? n : old, n, arrived ? 300 : 0, (v) => `${ELEM_ICON[e]}${v}`);
      c.el.style.opacity = String(0.35 + (0.65 * n) / total);
      if (old >= 0 && n > old) this.chipPop(c.el, e);
    }
  }

  /** Chip que ganhou ponto: pulo, lampejo branco e 4 quadradinhos saltando. */
  private chipPop(el: HTMLElement, e: Elem): void {
    play(el, [{ scale: '1' }, { scale: '1.3' }, { scale: '1' }], { duration: 250, easing: 'steps(3)' }, this.fx);
    if (reduced()) return;
    play(el, [{ boxShadow: 'inset 0 0 0 20px #ffffff' }, { boxShadow: 'inset 0 0 0 20px #ffffff' }], { duration: 150 }, this.fx);
    const r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top, 4, [ELEM_TONE[e].light, ELEM_TONE[e].body], { angle: [-130, -50], speed: [60, 110], gravity: 400, life: [300, 420], step: true });
  }

  /** Evolução: anel de runas no retrato, borda piscando, faixa EVOLUIU! e nome novo digitado. */
  private evolved(me: SelfSnap, name: string): void {
    const e = me.look.order[0];
    this.creatureSlot.style.setProperty('--ec', e ? ELEM_TONE[e].body : FORM_COLOR[me.look.form]);
    if (reduced()) {
      this.nameEl.textContent = name;
      return;
    }
    this.creatureSlot.classList.add('evo');
    later(1200, () => this.creatureSlot.classList.remove('evo'), this.fx);
    play(this.meEl, [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }], { duration: 200, iterations: 3, pseudoElement: '::after' }, this.fx);
    this.evoBand.style.setProperty('--fc', FORM_COLOR[me.look.form]);
    play(this.evoBand, [{ translate: '0 -10px', opacity: 0 }, { translate: '0 0', opacity: 1, offset: 0.12 }, { translate: '0 0', opacity: 1, offset: 0.85 }, { translate: '0 0', opacity: 0 }], { duration: 1200, easing: 'steps(12)' }, this.fx);
    typeText(this.nameEl, name, 40);
  }

  /** Perda de estágio: o retrato racha, treme e pisca vermelho. */
  private lostStage(): void {
    const el = this.creatureSlot;
    if (reduced()) {
      play(el, [{ background: '#ff4f6d' }, { background: '#ff4f6d' }], { duration: 300 }, this.fx);
      return;
    }
    play(
      el,
      [
        { clipPath: 'polygon(0 0, 100% 0, 100% 100%, 0 100%)' },
        { clipPath: 'polygon(0 0, 45% 0, 60% 30%, 40% 55%, 58% 100%, 0 100%, 0 0, 100% 0, 100% 100%, 64% 100%, 46% 55%, 66% 30%, 51% 0)' },
      ],
      { duration: 200, easing: 'steps(2)' },
      this.fx,
    );
    play(el, [{ translate: '3px 0' }, { translate: '-3px 0' }, { translate: '2px 0' }, { translate: '-2px 0' }, { translate: '0 0' }], { duration: 240, easing: 'steps(4)' }, this.fx);
    play(el, [{ background: '#ff4f6d' }, { background: '#ff4f6d', offset: 0.25 }, { background: 'transparent', offset: 0.25 }, { background: 'transparent', offset: 0.5 }, { background: '#ff4f6d', offset: 0.5 }, { background: '#ff4f6d', offset: 0.75 }, { background: 'transparent', offset: 0.75 }], { duration: 400 }, this.fx);
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
