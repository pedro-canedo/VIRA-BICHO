import { attackElem, BALANCE, FORM_LABEL, FX_IMPACT_MS, speciesName, typeMult, type Action, type FighterInfo, type ServerMsg } from '@vb/shared';
import { creatureImg } from '../render/creature';
import { ELEM_TONE } from '../render/palette';
import { Anims, countTo, GhostBar, later, play, reduced, vibrate } from './anim';
import { h, mount } from './dom';
import { bolt, burst, confetti, RAMP, spell, type Pt } from './fxcanvas';

const ICON: Record<Action, string> = { ataque: '⚔️', defesa: '🛡️', carga: '⚡' };
const NAME: Record<Action, string> = { ataque: 'Ataque', defesa: 'Defesa', carga: 'Carga' };
const BEATS: Record<Action, string> = { ataque: 'vence Carga', defesa: 'vence Ataque', carga: 'vence Defesa' };
const ACT_COLOR: Record<Action, string> = { ataque: '#ff4f6d', defesa: '#7cc4ff', carga: '#ffcf3f' };

type Start = Extract<ServerMsg, { t: 'b_start' }>;
type Reveal = Extract<ServerMsg, { t: 'b_reveal' }>;
type End = Extract<ServerMsg, { t: 'b_end' }>;
type Side = 'you' | 'opp';

interface FighterView {
  root: HTMLElement;
  /** Envolve o canvas: recebe investida, silhueta e tremida (o canvas do oponente já tem scaleX(-1)). */
  body: HTMLElement;
  bar: GhostBar;
  hp: HTMLElement;
  charged: HTMLElement;
  info: FighterInfo;
  hpNow: number;
  side: Side;
}

interface Card {
  root: HTMLElement;
  inner: HTMLElement;
  back: HTMLElement;
  front: HTMLElement;
}

function fighterView(info: FighterInfo, side: Side, spectate: boolean): FighterView {
  const bar = new GhostBar();
  bar.set(info.hp / info.mhp);
  const hp = h('div', { class: 'hpnum' }, `${info.hp}/${info.mhp}`);
  const charged = h('div', { class: 'charged' }, info.charged ? '⚡ Carregado: próximo golpe ×2' : '');
  const body = h('div', { class: 'fbody' }, creatureImg(info.look, 3));
  const species = info.wild ? FORM_LABEL[info.look.form] : `${speciesName(info.look.form, info.look.stage)} · ${FORM_LABEL[info.look.form]}`;
  const root = h(
    'div',
    { class: `fighter ${side}` },
    body,
    h('div', { class: 'fname' }, side === 'you' && !spectate ? 'Você' : info.name),
    h('div', { class: 'ftype' }, species + (info.trophies ? ` · 🏆${info.trophies}` : '')),
    bar.el,
    hp,
    charged,
  );
  return { root, body, bar, hp, charged, info, hpNow: info.hp, side };
}

function makeCard(side: Side): Card {
  const back = h('div', { class: 'face back' }, h('i', { class: 'q' }, '?'));
  const front = h('div', { class: 'face front' });
  const inner = h('div', { class: 'pin' }, back, front);
  return { root: h('div', { class: `pcard ${side}` }, inner), inner, back, front };
}

function center(el: Element): Pt {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

const fmtMult = (m: number) => `×${m.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}`;

/** Painel da batalha: escolha secreta, revelação simultânea e resultado. */
export class BattleUi {
  private root: HTMLElement;
  private you: FighterView;
  private opp: FighterView;
  private revealEl = h('div', { class: 'reveal' });
  private midEl = h('div', { class: 'rmid' });
  private cards: Record<Side, Card> = { you: makeCard('you'), opp: makeCard('opp') };
  private readyEl: HTMLElement | null = null;
  private textEl = h('div', { class: 'btext' });
  private timerEl = h('div', { class: 'timer' });
  private timerBar = h('i');
  private turnEl = h('div', { class: 'vs' });
  private actionsEl = h('div', { class: 'actions' });
  private buttons: HTMLButtonElement[] = [];
  private raf = 0;
  private deadline = 0;
  private windowMs = 1;
  private timerCls = '';
  private chosen: Action | null = null;
  private revealed = false;
  /** Estado de Carga no início do turno (o golpe carregado usa o valor anterior ao reveal). */
  private ch: Record<Side, boolean>;
  /** Aplica na hora o que a revelação em curso ainda não aplicou (HP e texto). */
  private pending: (() => void) | null = null;
  private fx = new Anims();
  private kind: Start['kind'];
  readonly id: number;
  readonly spectate: boolean;

  constructor(
    msg: Start,
    private onAct: (a: Action) => void,
  ) {
    this.id = msg.id;
    this.kind = msg.kind;
    this.spectate = !!msg.spectate;
    this.you = fighterView(msg.you, 'you', this.spectate);
    this.opp = fighterView(msg.opp, 'opp', this.spectate);
    this.ch = { you: msg.you.charged, opp: msg.opp.charged };
    this.timerEl.append(this.timerBar);
    this.buttons = (['ataque', 'defesa', 'carga'] as const).map((a) => {
      const b = h('button', { class: `btn act ${a}`, onclick: () => this.choose(a) }, h('span', { class: 'ico' }, ICON[a]), NAME[a], h('small', {}, BEATS[a])) as HTMLButtonElement;
      // Afunda na hora do toque, antes de o servidor responder
      b.addEventListener('pointerdown', () => b.classList.add('press'));
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, () => b.classList.remove('press'));
      return b;
    });
    this.actionsEl.append(...this.buttons);
    if (this.spectate) this.revealEl.classList.add('named');
    this.root = mount(
      h(
        'div',
        { class: 'battle' },
        h('div', { class: 'duel' }, this.you.root, h('div', {}, this.turnEl), this.opp.root),
        this.revealEl,
        this.textEl,
        this.timerEl,
        this.spectate ? h('div', { class: 'muted small', style: 'text-align:center' }, '👀 Você está assistindo') : this.actionsEl,
      ),
    );
    if (msg.kind === 'final') this.root.classList.add('final');
    this.textEl.textContent = this.spectate
      ? `DUELO FINAL: ${msg.you.name} contra ${msg.opp.name}!`
      : msg.kind === 'final'
        ? 'DUELO FINAL! Quem vencer leva a partida.'
        : msg.kind === 'wild'
          ? 'Um bicho selvagem! Escolha sua ação.'
          : 'Duelo! Escolha em segredo.';
    this.startTurn(msg.turn, msg.ms);
    window.addEventListener('keydown', this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    const map: Record<string, Action> = { '1': 'ataque', '2': 'defesa', '3': 'carga', a: 'ataque', s: 'defesa', d: 'carga' };
    const a = map[e.key.toLowerCase()];
    if (a) this.choose(a);
  };

  private flush(): void {
    const p = this.pending;
    this.pending = null;
    p?.();
  }

  startTurn(turn: number, ms: number): void {
    this.flush();
    this.fx.cancel();
    this.turnEl.textContent = `TURNO ${turn}`;
    this.chosen = null;
    this.revealed = false;
    this.actionsEl.classList.remove('picked');
    this.buttons.forEach((b) => {
      b.disabled = false;
      b.classList.remove('chosen', 'press');
    });
    // Cartas de costas: a sua espera a escolha; a do oponente balança enquanto ele pensa
    this.cards = { you: makeCard('you'), opp: makeCard('opp') };
    this.cards.opp.root.classList.add('wobble');
    if (this.spectate) this.cards.you.root.classList.add('wobble');
    else this.cards.you.root.classList.add('empty');
    this.readyEl = null;
    this.midEl.replaceChildren();
    const slot = (s: Side) => h('div', { class: `cslot ${s}` }, this.cards[s].root, this.spectate ? h('div', { class: 'cname' }, (s === 'you' ? this.you : this.opp).info.name) : null);
    this.revealEl.replaceChildren(slot('you'), this.midEl, slot('opp'));

    if (turn > 1) this.textEl.textContent = this.spectate ? 'Os dois escolhem em segredo...' : 'Escolha sua próxima ação.';
    this.deadline = performance.now() + ms;
    this.windowMs = ms;
    cancelAnimationFrame(this.raf);
    const tick = () => {
      const left = Math.max(0, this.deadline - performance.now());
      this.timerBar.style.transform = `scaleX(${left / this.windowMs})`;
      const cls = left <= 1000 ? 't-crit' : left <= this.windowMs / 2 ? 't-warn' : '';
      if (cls !== this.timerCls) {
        this.timerEl.className = `timer ${cls}`;
        this.timerCls = cls;
      }
      if (left > 0) this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  private choose(a: Action): void {
    if (this.spectate || this.chosen || this.buttons[0].disabled) return;
    this.chosen = a;
    this.onAct(a);
    this.actionsEl.classList.add('picked');
    const btn = this.buttons.find((b) => b.classList.contains(a))!;
    this.buttons.forEach((b) => {
      b.disabled = true;
      if (b === btn) b.classList.add('chosen');
    });
    this.textEl.textContent = `Você escolheu ${NAME[a]}. Esperando o oponente...`;
    vibrate(12);

    const card = this.cards.you;
    card.root.classList.remove('empty');
    const rm = reduced();
    if (!rm) {
      const from = center(btn);
      play(btn, [{ scale: '1' }, { scale: '1.08', offset: 0.43 }, { scale: '1' }], { duration: 210 }, this.fx);
      burst(from.x, from.y, 8, [ACT_COLOR[a]], { speed: [60, 113], life: [300, 300], step: true, size: 1 });
      // Carta de costas voa do botão até o slot (FLIP) e assenta com um quique
      const to = center(card.root);
      play(card.root, [{ transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(.6)` }, { transform: 'translate(0, 0) scale(1)' }], { duration: 240, easing: 'cubic-bezier(.2,.9,.3,1.2)' }, this.fx);
      play(card.root, [{ transform: 'translateY(0)' }, { transform: 'translateY(-2px)' }, { transform: 'translateY(0)' }], { delay: 240, duration: 100 }, this.fx);
    }
    later(
      rm ? 0 : 300,
      () => {
        if (this.cards.you !== card || this.readyEl || this.revealed) return;
        this.readyEl = h('b', { class: 'ready' }, 'PRONTO');
        card.root.parentElement?.append(this.readyEl);
      },
      this.fx,
    );
  }

  reveal(msg: Reveal): void {
    cancelAnimationFrame(this.raf);
    this.timerBar.style.transform = 'scaleX(0)';
    this.buttons.forEach((b) => (b.disabled = true));
    this.flush();
    this.revealed = true;
    const rm = reduced();
    const { you: yc, opp: oc } = this.cards;
    this.readyEl?.remove();
    this.readyEl = null;
    for (const c of [yc, oc]) c.root.classList.remove('empty', 'wobble');
    yc.front.className = `face front ${msg.you}`;
    yc.front.textContent = ICON[msg.you];
    oc.front.className = `face front ${msg.opp}`;
    oc.front.textContent = ICON[msg.opp];

    const role = (s: Side): 'win' | 'lose' | 'tie' => (msg.winner === 'tie' ? 'tie' : msg.winner === s ? 'win' : 'lose');
    const T = 600;
    const o = (ms: number) => ms / T;
    if (!rm) {
      for (const [c, dir, r] of [
        [yc, 1, role('you')],
        [oc, -1, role('opp')],
      ] as const) {
        const up = 'translate(0px, -6px) scale(1.08)';
        const kf: Keyframe[] = [
          { transform: 'translate(0px, 0px) scale(1)', offset: 0 },
          { transform: up, offset: o(120) },
          { transform: 'translate(2px, -6px) scale(1.08)', offset: o(137) },
          { transform: 'translate(-2px, -6px) scale(1.08)', offset: o(153) },
          { transform: 'translate(2px, -6px) scale(1.08)', offset: o(170) },
          { transform: 'translate(-2px, -6px) scale(1.08)', offset: o(187) },
          { transform: up, offset: o(200) },
          { transform: up, offset: o(380) },
          { transform: `translate(${dir * 8}px, -6px) scale(1.08)`, offset: o(440) },
        ];
        if (r === 'win') kf.push({ transform: `translate(${dir * 4}px, -6px) scale(1.25)`, offset: o(500) }, { transform: `translate(${dir * 4}px, -6px) scale(1.25)`, offset: 1 });
        else if (r === 'lose') kf.push({ transform: `translate(${-dir * 10}px, -2px) rotate(${-dir * 12}deg) scale(1)`, offset: o(500) }, { transform: `translate(${-dir * 10}px, -2px) rotate(${-dir * 12}deg) scale(1)`, offset: 1 });
        else kf.push({ transform: `translate(${-dir * 6}px, -6px) scale(1.08)`, offset: o(500) }, { transform: 'translate(0px, -3px) scale(1.04)', offset: 1 });
        // os segmentos seguintes usam o easing do keyframe de origem
        kf[8].easing = r === 'tie' ? 'ease-out' : 'steps(3)';
        play(c.root, kf, { duration: T, fill: 'forwards' }, this.fx);
        play(c.inner, [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }], { delay: 200, duration: 180, easing: 'cubic-bezier(.3,1.6,.5,1)', fill: 'both' }, this.fx);
      }
    } else {
      // Sem subir nem tremer: o flip vira um crossfade de 120 ms
      for (const c of [yc, oc]) {
        c.root.classList.add('rm');
        play(c.back, [{ opacity: 1 }, { opacity: 0 }], { delay: 200, duration: 120, fill: 'both' }, this.fx);
        play(c.front, [{ opacity: 0 }, { opacity: 1 }], { delay: 200, duration: 120, fill: 'both' }, this.fx);
      }
    }

    // Choque (380 ms): faísca no meio, vencedora dourada, perdedora rachada
    later(
      380,
      () => {
        if (msg.winner !== 'tie') {
          this.midEl.append(h('i', { class: 'spark' }));
          (msg.winner === 'you' ? yc : oc).root.classList.add('won');
          (msg.winner === 'you' ? oc : yc).root.classList.add('lost');
        } else if (msg.you === 'carga') {
          yc.root.classList.add('glowc');
          oc.root.classList.add('glowc');
          this.midEl.append(h('b', { class: 'eq' }, '='));
        } else if (msg.you === 'defesa') {
          this.midEl.append(h('i', { class: 'midshield' }));
        } else {
          this.midEl.append(h('i', { class: 'spark' }), h('b', { class: 'eq' }, '='));
        }
      },
      this.fx,
    );

    // Dano de base (sem a fúria da arena) e estado de Carga no início do turno
    const fury = this.kind === 'final' && msg.turn >= BALANCE.duel.furyFromTurn;
    const furyOf = (v: FighterView) => (fury ? Math.round(BALANCE.duel.furyPct * v.info.mhp) : 0);
    const baseYou = Math.max(0, msg.dmgYou - furyOf(this.you));
    const baseOpp = Math.max(0, msg.dmgOpp - furyOf(this.opp));
    const chAtStart = { ...this.ch };
    this.ch = { you: msg.chYou, opp: msg.chOpp };
    const t0 = performance.now();
    later(440, () => this.castSpells(msg, baseYou, baseOpp, chAtStart, t0 + 440), this.fx);

    // Estado final (HP, carga e texto), aplicado no impacto ou na hora se o turno seguinte chegar antes
    let barsDone = false;
    let textDone = false;
    const applyBars = () => {
      if (barsDone) return;
      barsDone = true;
      this.setHp(this.you, msg.hpYou, msg.chYou);
      this.setHp(this.opp, msg.hpOpp, msg.chOpp);
    };
    const lead = this.spectate ? '' : msg.winner === 'you' ? '✅ ' : msg.winner === 'opp' ? '❌ ' : '🤝 ';
    const applyText = () => {
      if (textDone) return;
      textDone = true;
      this.textEl.textContent = lead + msg.text;
    };
    this.pending = () => {
      applyBars();
      applyText();
    };
    later(
      FX_IMPACT_MS,
      () => {
        applyBars();
        this.impact(msg, baseYou, baseOpp, chAtStart, fury);
      },
      this.fx,
    );
    later(
      700,
      () => {
        applyText();
        this.pending = null;
        play(this.textEl, rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 150 }, this.fx);
      },
      this.fx,
    );
  }

  private setHp(v: FighterView, hp: number, ch: boolean): void {
    v.bar.set(hp / v.info.mhp, this.fx);
    const mhp = v.info.mhp;
    countTo(v.hp, v.hpNow, hp, 300, (n) => `${n}/${mhp}`);
    v.hpNow = hp;
    v.charged.textContent = ch ? '⚡ Carregado: próximo golpe ×2' : '';
  }

  private view(s: Side): FighterView {
    return s === 'you' ? this.you : this.opp;
  }

  /** Feitiços de T0+440 a T0+600, na linguagem do mundo (fxcanvas). */
  private castSpells(msg: Reveal, baseYou: number, baseOpp: number, ch: Record<Side, boolean>, t0: number): void {
    const pts = { you: center(this.you.body), opp: center(this.opp.body) };
    const mid = { x: (pts.you.x + pts.opp.x) / 2, y: (pts.you.y + pts.opp.y) / 2 };
    const form = (s: Side) => this.view(s).info.look.form;
    if (msg.you === 'ataque' && msg.opp === 'ataque' && baseYou > 0 && baseOpp > 0) {
      spell(form('you'), pts.you, mid, t0, 160, { size: ch.you ? 2 : 1, charged: ch.you });
      spell(form('opp'), pts.opp, mid, t0, 160, { size: ch.opp ? 2 : 1, charged: ch.opp });
      return;
    }
    if (msg.winner === 'tie') return;
    const w: Side = msg.winner;
    const l: Side = w === 'you' ? 'opp' : 'you';
    const base = w === 'you' ? baseOpp : baseYou;
    if (base <= 0) return;
    const wAct = w === 'you' ? msg.you : msg.opp;
    const size = ch[w] ? 2 : 1;
    if (wAct === 'defesa') {
      // O escudo acende na frente de quem defendeu; o ataque se desfaz nele e o contra-ataque volta menor
      const sh = this.shield(w);
      const sp = center(sh);
      spell(form(l), pts[l], sp, t0, 80, { size: 0.6 });
      later(80, () => burst(sp.x, sp.y, 6, RAMP[form(l)], { speed: [30, 70], life: [180, 260] }), this.fx);
      spell(form(w), sp, pts[l], t0 + 80, 80, { size: size * 0.7, charged: ch[w] });
      later(260, () => sh.remove(), this.fx);
    } else if (wAct === 'carga') {
      // Escudo na frente de quem defendeu, que estilhaça no impacto
      const sh = this.shield(l);
      spell(form(w), pts[w], pts[l], t0, 160, { size, charged: ch[w] });
      later(
        FX_IMPACT_MS - 440,
        () => {
          const sp = center(sh);
          sh.remove();
          burst(sp.x, sp.y, 6, ['#7cc4ff', '#c4e6ff'], { speed: [60, 140], life: [260, 380], gravity: 300, size: 2 });
        },
        this.fx,
      );
    } else {
      spell(form(w), pts[w], pts[l], t0, 160, { size, charged: ch[w] });
    }
  }

  private shield(s: Side): HTMLElement {
    const el = h('i', { class: `pshield ${s}` });
    this.view(s).root.append(el);
    return el;
  }

  /** Impacto em T0+FX_IMPACT_MS: investida, silhueta, tremida, número e selos. */
  private impact(msg: Reveal, baseYou: number, baseOpp: number, ch: Record<Side, boolean>, fury: boolean): void {
    const clash = msg.you === 'ataque' && msg.opp === 'ataque' && baseYou > 0 && baseOpp > 0;
    const rm = reduced();
    if (clash) {
      const a = center(this.you.body);
      const b = center(this.opp.body);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      burst(m.x, m.y, 12, ['#ffcf3f'], { even: true, speed: [110, 110], life: [260, 260], add: true });
      burst(m.x, m.y, 4, ['#ffffff'], { even: true, angle: [0, 360], speed: [50, 50], life: [200, 200], size: 2 });
    }
    // dmgOpp foi causado por você; dmgYou, pelo oponente
    if (msg.dmgOpp > 0) this.strike(this.you, this.opp, msg.dmgOpp, baseOpp, msg.hpOpp, ch.you, clash);
    if (msg.dmgYou > 0) this.strike(this.opp, this.you, msg.dmgYou, baseYou, msg.hpYou, ch.opp, clash);
    if (fury) {
      for (const v of [this.you, this.opp]) {
        const r = v.body.getBoundingClientRect();
        burst(r.left + r.width / 2, r.bottom - 4, 14, ['#ff4f6d', '#ffd27a'], { angle: [-100, -80], speed: [50, 110], life: [300, 520], gravity: -80, add: true, shrink: true, spread: r.width / 2 - 6, spreadY: 0 });
      }
    }
    if (!this.spectate && msg.dmgYou > 0) {
      if (!rm) play(this.root, [{ translate: '0 0' }, { translate: '2px 0' }, { translate: '-2px 0' }, { translate: '2px 0' }, { translate: '0 0' }], { duration: 160, easing: 'steps(4)' }, this.fx);
      vibrate(msg.dmgYou >= 0.3 * this.you.info.mhp ? [40, 30, 40] : 25);
    }
  }

  private strike(att: FighterView, tgt: FighterView, dmg: number, base: number, hpAfter: number, charged: boolean, clash: boolean): void {
    const rm = reduced();
    const hit = base > 0;
    const mult = hit ? typeMult(att.info.look, tgt.info.look) : 1;
    const sup = mult > 1;
    const weak = mult < 1;
    const ko = hpAfter <= 0;
    const dir = att.side === 'you' ? 1 : -1;
    if (hit && !rm) {
      // Investida (80 ms) e volta com Back.easeOut (180 ms); no choque os dois avançam juntos
      play(att.body, [{ translate: '0 0', easing: 'ease-in' }, { translate: `${dir * 14}px 0`, offset: 80 / 260, easing: 'cubic-bezier(.34,1.56,.64,1)' }, { translate: '0 0' }], { duration: 260 }, this.fx);
    }
    // Silhueta branca e tremida proporcional depois do hitstop
    play(tgt.body, [{ filter: 'brightness(0) invert(1)' }, { filter: 'brightness(0) invert(1)' }], { duration: 60 }, this.fx);
    if (!rm) {
      const stop = ko ? 150 : charged || sup ? 100 : 70;
      const A = Math.round(3 + (9 * dmg) / tgt.info.mhp);
      const kf: Keyframe[] = [];
      for (let i = 0; i < 12; i++) kf.push({ transform: `translateX(${(i % 2 ? -1 : 1) * Math.max(1, Math.round(A * (1 - i / 12)))}px)`, easing: 'steps(1)' });
      kf.push({ transform: 'translateX(0)' });
      play(tgt.body, kf, { delay: stop, duration: 280 }, this.fx);
    }
    const c = center(tgt.body);
    const form = att.info.look.form;
    if (hit) {
      if (form === 'neutro') burst(c.x, c.y + 20, 8, RAMP.neutro, { angle: [-170, -10], speed: [30, 80], gravity: 120, life: [260, 400] });
      else burst(c.x, c.y, 10, RAMP[form], { speed: [50, 130], life: [200, 360], add: form === 'brasa' || form === 'vapor' || form === 'cinza' || form === 'quimera' });
      if (charged) bolt({ x: c.x - dir * 10, y: c.y - 60 }, c, 140);
    }
    if (clash) burst(c.x - dir * 30, c.y, 5, ['#ffcf3f'], { speed: [40, 80], life: [200, 260], add: true });

    // Número voador
    const elemBody = (() => {
      const e = attackElem(att.info.look);
      return e ? ELEM_TONE[e].body : '#ffffff';
    })();
    const big = hit && (charged || sup);
    const num = h('span', { class: `dmgnum${big ? ' big' : ''}${hit && weak && !charged ? ' weak' : ''}${hit && charged ? ' ch' : ''}${!hit ? ' fury' : ''}` }, `-${dmg}${hit && charged ? ' ×2' : hit && sup ? '!' : hit && weak ? '…' : ''}`);
    if (hit && sup && !charged) num.style.color = elemBody;
    tgt.root.append(num);
    if (rm) play(num, [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 700, fill: 'forwards' }, this.fx);
    else
      play(
        num,
        [
          { transform: 'translate(-50%, 0) scale(.4)', opacity: 1 },
          { transform: 'translate(-50%, -3px) scale(1.4)', opacity: 1, offset: 90 / 700 },
          { transform: 'translate(-50%, -5px) scale(1)', opacity: 1, offset: 170 / 700 },
          { transform: 'translate(-50%, -24px) scale(1)', opacity: 1, offset: 500 / 700 },
          { transform: 'translate(-50%, -30px) scale(1)', opacity: 0 },
        ],
        { duration: 700, fill: 'forwards' },
        this.fx,
      );
    later(720, () => num.remove(), this.fx);

    // Selos de eficácia e de carga
    const seals: HTMLElement[] = [];
    if (hit && sup) seals.push(h('b', { class: 'seal sup', style: `background:${elemBody}` }, `SUPER EFICAZ! ${fmtMult(mult)}`));
    if (hit && weak) seals.push(h('b', { class: 'seal weak' }, `pouco eficaz… ${fmtMult(mult)}`));
    if (hit && charged) seals.push(h('b', { class: 'seal ch' }, '×2 CARREGADO!'));
    if (!seals.length) return;
    const box = h('div', { class: 'seals' }, ...seals);
    tgt.root.append(box);
    for (const s of seals) {
      const rot = s.classList.contains('weak') ? '' : 'rotate(-4deg) ';
      if (rm) play(s, [{ opacity: 0 }, { opacity: 1 }], { duration: 150 }, this.fx);
      else {
        play(s, [{ transform: `${rot}scale(.6)` }, { transform: `${rot}scale(1.15)`, offset: 0.6 }, { transform: `${rot}scale(1)` }], { duration: 280, easing: 'steps(3)' }, this.fx);
        if (!rot) play(s, [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(4px)', opacity: 0.7 }], { delay: 280, duration: 400, fill: 'forwards' }, this.fx);
      }
    }
    later(1280, () => play(box, [{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: 'forwards' }), this.fx);
    later(1440, () => box.remove(), this.fx);
  }

  end(msg: End, onClosed: () => void): void {
    this.flush();
    this.fx.cancel();
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    const cls = msg.result === 'win' ? 'win' : msg.result === 'lose' ? 'lose' : msg.result === 'over' ? 'over' : '';
    const title = { win: 'VITÓRIA!', lose: 'DERROTA', draw: 'EMPATE', flee: 'FUGIU', over: 'FIM' }[msg.result];
    this.actionsEl.remove();
    this.timerEl.remove();
    const res = h('div', { class: `result ${cls}` }, title);
    this.root.append(res, h('div', { class: 'btext' }, msg.text));
    if (msg.result === 'win' && !this.spectate) {
      const r = res.getBoundingClientRect();
      const wild = this.opp.info.wild;
      const f = this.opp.info.look.form;
      confetti(r.left + r.width / 2, r.top, wild ? 12 : 36, wild ? [RAMP[f][1], '#ffffff'] : ['#ff7a3d', '#4aa3ff', '#52c95f', '#ffcf3f', '#ff5fd2'], { spread: 40 });
    }
    later(1600, () => play(this.root, [{ opacity: 1 }, { opacity: 0, translate: '0 8px' }], { duration: 200, fill: 'forwards' }), this.fx);
    window.setTimeout(() => {
      this.root.remove();
      onClosed();
    }, 1800);
  }

  destroy(): void {
    this.fx.cancel();
    this.pending = null;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }
}
