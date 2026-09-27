import { FORM_LABEL, speciesName, type Action, type FighterInfo, type ServerMsg } from '@vb/shared';
import { creatureImg } from '../render/creature';
import { h, mount } from './dom';

const ICON: Record<Action, string> = { ataque: '⚔️', defesa: '🛡️', carga: '⚡' };
const NAME: Record<Action, string> = { ataque: 'Ataque', defesa: 'Defesa', carga: 'Carga' };
const BEATS: Record<Action, string> = { ataque: 'vence Carga', defesa: 'vence Ataque', carga: 'vence Defesa' };

type Start = Extract<ServerMsg, { t: 'b_start' }>;
type Reveal = Extract<ServerMsg, { t: 'b_reveal' }>;
type End = Extract<ServerMsg, { t: 'b_end' }>;

interface FighterView {
  root: HTMLElement;
  bar: HTMLElement;
  hp: HTMLElement;
  charged: HTMLElement;
  info: FighterInfo;
}

function fighterView(info: FighterInfo, side: 'you' | 'opp'): FighterView {
  const bar = h('i', { style: `width:${(100 * info.hp) / info.mhp}%` });
  const hp = h('div', { class: 'hpnum' }, `${info.hp}/${info.mhp}`);
  const charged = h('div', { class: 'charged' });
  const species = info.wild ? FORM_LABEL[info.look.form] : `${speciesName(info.look.form, info.look.stage)} · ${FORM_LABEL[info.look.form]}`;
  const root = h(
    'div',
    { class: `fighter ${side}` },
    creatureImg(info.look, 3),
    h('div', { class: 'fname' }, side === 'you' ? 'Você' : info.name),
    h('div', { class: 'ftype' }, species + (info.trophies ? ` · 🏆${info.trophies}` : '')),
    h('div', { class: 'bar' }, bar),
    hp,
    charged,
  );
  return { root, bar, hp, charged, info };
}

/** Painel da batalha: escolha secreta, revelação simultânea e resultado. */
export class BattleUi {
  private root: HTMLElement;
  private you: FighterView;
  private opp: FighterView;
  private revealEl = h('div', { class: 'reveal' });
  private textEl = h('div', { class: 'btext' });
  private timerBar = h('i');
  private turnEl = h('div', { class: 'vs' });
  private buttons: HTMLButtonElement[] = [];
  private raf = 0;
  private deadline = 0;
  private windowMs = 1;
  readonly id: number;

  constructor(
    msg: Start,
    private onAct: (a: Action) => void,
  ) {
    this.id = msg.id;
    this.you = fighterView(msg.you, 'you');
    this.opp = fighterView(msg.opp, 'opp');
    this.buttons = (['ataque', 'defesa', 'carga'] as const).map(
      (a) => h('button', { class: `btn act ${a}`, onclick: () => this.choose(a) }, h('span', { class: 'ico' }, ICON[a]), NAME[a], h('small', {}, BEATS[a])) as HTMLButtonElement,
    );
    this.root = mount(
      h(
        'div',
        { class: 'battle' },
        h('div', { class: 'duel' }, this.you.root, h('div', {}, this.turnEl), this.opp.root),
        this.revealEl,
        this.textEl,
        h('div', { class: 'timer' }, this.timerBar),
        h('div', { class: 'actions' }, ...this.buttons),
      ),
    );
    this.textEl.textContent = msg.kind === 'wild' ? 'Um bicho selvagem! Escolha sua ação.' : 'Duelo! Escolha em segredo.';
    this.startTurn(msg.turn, msg.ms);
    window.addEventListener('keydown', this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    const map: Record<string, Action> = { '1': 'ataque', '2': 'defesa', '3': 'carga', a: 'ataque', s: 'defesa', d: 'carga' };
    const a = map[e.key.toLowerCase()];
    if (a) this.choose(a);
  };

  startTurn(turn: number, ms: number): void {
    this.turnEl.textContent = `TURNO ${turn}`;
    this.revealEl.replaceChildren();
    this.buttons.forEach((b) => {
      b.disabled = false;
      b.classList.remove('chosen');
    });
    if (turn > 1) this.textEl.textContent = 'Escolha sua próxima ação.';
    this.deadline = performance.now() + ms;
    this.windowMs = ms;
    cancelAnimationFrame(this.raf);
    const tick = () => {
      const left = Math.max(0, this.deadline - performance.now());
      this.timerBar.style.width = `${(100 * left) / this.windowMs}%`;
      if (left > 0) this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  private choose(a: Action): void {
    if (this.buttons[0].disabled) return;
    this.onAct(a);
    this.buttons.forEach((b) => {
      b.disabled = true;
      if (b.classList.contains(a)) b.classList.add('chosen');
    });
    this.textEl.textContent = `Você escolheu ${NAME[a]}. Esperando o oponente...`;
  }

  reveal(msg: Reveal): void {
    cancelAnimationFrame(this.raf);
    this.timerBar.style.width = '0%';
    this.buttons.forEach((b) => (b.disabled = true));
    this.revealEl.replaceChildren(h('span', {}, ICON[msg.you]), h('span', { class: 'muted', style: 'font-size:18px;align-self:center' }, 'vs'), h('span', {}, ICON[msg.opp]));
    const lead = msg.winner === 'you' ? '✅ ' : msg.winner === 'opp' ? '❌ ' : '🤝 ';
    this.textEl.textContent = lead + msg.text;
    const set = (v: FighterView, hp: number, dmg: number, ch: boolean) => {
      v.bar.style.width = `${Math.max(0, (100 * hp) / v.info.mhp)}%`;
      v.hp.textContent = `${hp}/${v.info.mhp}${dmg ? `  (-${dmg})` : ''}`;
      v.charged.textContent = ch ? '⚡ Carregado: próximo golpe ×2' : '';
      if (dmg) {
        v.root.classList.remove('hit');
        void v.root.offsetWidth;
        v.root.classList.add('hit');
      }
    };
    set(this.you, msg.hpYou, msg.dmgYou, msg.chYou);
    set(this.opp, msg.hpOpp, msg.dmgOpp, msg.chOpp);
  }

  end(msg: End, onClosed: () => void): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    const cls = msg.result === 'win' ? 'win' : msg.result === 'lose' ? 'lose' : '';
    const title = msg.result === 'win' ? 'VITÓRIA!' : msg.result === 'lose' ? 'DERROTA' : msg.result === 'draw' ? 'EMPATE' : 'FUGIU';
    this.root.querySelector('.actions')?.remove();
    this.root.querySelector('.timer')?.remove();
    this.root.append(h('div', { class: `result ${cls}` }, title), h('div', { class: 'btext' }, msg.text));
    window.setTimeout(() => {
      this.root.remove();
      onClosed();
    }, 1800);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }
}
