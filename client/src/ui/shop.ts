import { canBuy, LINE_INFO, LINES, lineCounts, MODES, SKILL_IDS, SKILLS, SPECIAL_INFO, specialOf, type BuyError, type GameMode, type Line, type SelfSnap, type SkillId } from '@vb/shared';
import { Anims, countTo, later, play, reduced, stampIn, vibrate } from './anim';
import { skillIcons, titleBadge, TIER_LABEL } from './build';
import { h } from './dom';
import { burst } from './fxcanvas';

/** O que a loja precisa saber do jogador (vem de cada snapshot). */
export type ShopState = Pick<SelfSnap, 'essence' | 'skills' | 'alive' | 'battle'>;

type CardState = 'ok' | BuyError | 'busy';

interface CardView {
  id: SkillId;
  el: HTMLButtonElement;
  cost: HTMLElement;
  warn: HTMLElement;
  key: string;
  state: CardState;
}

interface ColView {
  el: HTMLElement;
  tab: HTMLButtonElement;
  count: HTMLElement;
  tabCount: HTMLElement;
  sets: [HTMLElement, HTMLElement];
}

/** Quanto tempo a compra fica "enviando" esperando o snapshot confirmar. */
const BUSY_MS = 1500;

/** Diz quantas habilidades dá para comprar agora (para o aviso no botão da loja). */
export function buyableCount(s: ShopState, gm: GameMode): number {
  if (!s.alive || s.battle !== null) return 0;
  let n = 0;
  for (const id of SKILL_IDS) if (canBuy(s.skills, s.essence, id, gm) === null) n++;
  return n;
}

/**
 * Loja de habilidades: painel sobreposto que não pausa a partida. Os cartões são montados uma vez
 * e cada snapshot só troca classes e textos (recriar botões fazia toques se perderem no celular).
 */
export class Shop {
  readonly el: HTMLElement;
  private fx = new Anims();
  private cards = new Map<SkillId, CardView>();
  private cols = {} as Record<Line, ColView>;
  private essEl = h('b', { class: 'shess-n' }, '0');
  private slotsEl = h('span', { class: 'shslots' });
  private buildEl = h('div', { class: 'shbuild' });
  private isOpen = false;
  private tab: Line = 'guerreiro';
  private state: ShopState | null = null;
  private ess = -1;
  private buildKey = '';
  private busy: { id: SkillId; at: number } | null = null;

  constructor(
    private gm: GameMode,
    private onBuy: (id: SkillId) => void,
    private onToggle: (open: boolean) => void = () => {},
  ) {
    const mode = MODES[gm];
    const tabs = h('div', { class: 'shtabs', role: 'tablist' });
    const colsEl = h('div', { class: 'shcols' });
    for (const line of LINES) {
      const info = LINE_INFO[line];
      const count = h('span', { class: 'shcount' });
      const tabCount = h('small');
      const tab = h('button', { class: 'shtab', role: 'tab', style: `--lc:${info.color}`, onclick: () => this.setTab(line) }, h('span', {}, info.icon), h('b', {}, info.name), tabCount) as HTMLButtonElement;
      tabs.append(tab);
      // Títulos e bônus de conjunto com 2 e com 4 habilidades da linha
      const set = (i: 0 | 1) => h('div', { class: 'shset' }, h('i', { class: 'shpip' }, i === 0 ? '2' : '4'), h('span', {}, h('b', {}, info.titles[i]), ` · ${info.bonus[i]}`));
      const sets: [HTMLElement, HTMLElement] = [set(0), set(1)];
      const col = h(
        'section',
        { class: 'shcol', style: `--lc:${info.color}`, 'aria-label': info.name },
        h('div', { class: 'shhead' }, h('span', { class: 'shic' }, info.icon), h('b', {}, info.name), count),
        h('div', { class: 'shsets' }, ...sets),
      );
      for (const id of SKILL_IDS.filter((s) => SKILLS[s].line === line).sort((a, b) => SKILLS[a].tier - SKILLS[b].tier)) {
        const card = this.card(id);
        this.cards.set(id, card);
        col.append(card.el);
      }
      colsEl.append(col);
      this.cols[line] = { el: col, tab, count, tabCount, sets };
    }
    this.el = h(
      'div',
      { class: 'shop hidden', role: 'dialog', 'aria-label': 'Loja de habilidades' },
      h(
        'header',
        { class: 'shtop' },
        h('b', { class: 'shtitle' }, 'LOJA'),
        h('span', { class: 'shess', title: 'Essência' }, '✨ ', this.essEl),
        this.slotsEl,
        h('span', { class: 'shmode' }, `${mode.icon} ${mode.name}`),
        h('button', { class: 'shx', 'aria-label': 'Fechar a loja', title: 'Fechar (Esc)', onclick: () => this.close() }, '✕'),
      ),
      this.buildEl,
      tabs,
      colsEl,
      h('p', { class: 'shfoot' }, 'A partida continua com a loja aberta. Compras só fora de batalha. Um Especial novo substitui o antigo.'),
    );
    this.setTab(this.tab);
  }

  private card(id: SkillId): CardView {
    const d = SKILLS[id];
    const cost = h('span', { class: 'skcost' });
    const warn = h('span', { class: 'skwarn hidden' });
    const el = h(
      'button',
      { class: `skc t${d.tier}`, style: `--lc:${LINE_INFO[d.line].color}`, onclick: () => this.tryBuy(id) },
      h('span', { class: 'skic' }, d.icon),
      h(
        'span',
        { class: 'skmain' },
        h('span', { class: 'sktop' }, h('b', { class: 'skname' }, d.name), h('span', { class: 'sktier' }, TIER_LABEL[d.tier]), d.special ? h('span', { class: 'sksp' }, 'ESPECIAL') : null),
        h('span', { class: 'skdesc' }, d.desc),
        warn,
      ),
      cost,
    ) as HTMLButtonElement;
    return { id, el, cost, warn, key: '', state: 'ok' };
  }

  get opened(): boolean {
    return this.isOpen;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.show();
  }

  show(): void {
    if (this.isOpen) return;
    const s = this.state;
    if (s && (!s.alive || s.battle !== null)) return;
    this.isOpen = true;
    this.el.classList.remove('hidden');
    this.render(true);
    play(this.el, reduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ translate: '0 24px', opacity: 0 }, { translate: '0 0', opacity: 1 }], { duration: reduced() ? 150 : 200, easing: 'steps(4)' }, this.fx);
    window.addEventListener('keydown', this.onKey);
    this.onToggle(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.fx.cancel();
    this.el.classList.add('hidden');
    window.removeEventListener('keydown', this.onKey);
    this.onToggle(false);
  }

  destroy(): void {
    this.close();
    this.el.remove();
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.close();
  };

  private setTab(line: Line): void {
    this.tab = line;
    for (const l of LINES) {
      const on = l === line;
      this.cols[l].el.classList.toggle('on', on);
      this.cols[l].tab.classList.toggle('on', on);
      this.cols[l].tab.setAttribute('aria-selected', String(on));
    }
  }

  /** Estado novo do jogador. Fecha sozinha ao entrar em batalha ou morrer. */
  update(s: ShopState): void {
    const prev = this.state;
    this.state = s;
    if (this.busy && (s.skills.includes(this.busy.id) || performance.now() - this.busy.at > BUSY_MS)) {
      const got = s.skills.includes(this.busy.id) && !prev?.skills.includes(this.busy.id);
      const id = this.busy.id;
      this.busy = null;
      if (got && this.isOpen) later(0, () => this.bought(id), this.fx);
    }
    if (this.isOpen && (!s.alive || s.battle !== null)) this.close();
    if (this.isOpen) this.render(false);
  }

  private render(first: boolean): void {
    const s = this.state;
    if (!s) return;
    const mode = MODES[this.gm];
    if (s.essence !== this.ess) {
      countTo(this.essEl, first || this.ess < 0 ? s.essence : this.ess, s.essence, 300);
      this.ess = s.essence;
    }
    const slotsTxt = `Vagas ${s.skills.length}/${mode.slots}`;
    if (this.slotsEl.textContent !== slotsTxt) this.slotsEl.textContent = slotsTxt;
    this.slotsEl.classList.toggle('full', s.skills.length >= mode.slots);

    const bk = s.skills.join(',');
    if (bk !== this.buildKey) {
      this.buildKey = bk;
      const badge = titleBadge(s.skills);
      this.buildEl.replaceChildren(
        h('span', { class: 'label' }, 'Sua build'),
        s.skills.length ? skillIcons(s.skills) : h('span', { class: 'muted small' }, 'Nenhuma habilidade ainda: a classe surge das compras.'),
        ...(badge ? [badge] : []),
      );
    }

    const counts = lineCounts(s.skills);
    const sp = specialOf(s.skills);
    const can: Record<Line, number> = { guerreiro: 0, mago: 0, cacador: 0 };
    for (const c of this.cards.values()) {
      const d = SKILLS[c.id];
      const err = canBuy(s.skills, s.essence, c.id, this.gm);
      const st: CardState = this.busy?.id === c.id ? 'busy' : (err ?? 'ok');
      if (st === 'ok') can[d.line]++;
      const swap = !!d.special && sp !== null && sp !== d.special && st !== 'owned' && st !== 'mastery';
      const key = `${st}|${swap ? sp : ''}|${st === 'essence' ? d.cost - s.essence : ''}`;
      if (key === c.key) continue;
      c.key = key;
      c.state = st;
      c.el.className = `skc t${d.tier} ${st}`;
      c.el.setAttribute('aria-disabled', String(st !== 'ok'));
      // Preço num selo escuro (o ✨ amarelo some sobre o botão amarelo)
      const price = h('b', { class: 'skprice' }, `✨ ${d.cost}`);
      if (st === 'owned') c.cost.replaceChildren('✓ Comprado');
      else if (st === 'busy') c.cost.replaceChildren('Comprando…');
      else if (st === 'mastery') c.cost.replaceChildren('🔒 Clássico e Avançado');
      else if (st === 'slots') c.cost.replaceChildren('Sem vaga ', price);
      else if (st === 'essence') c.cost.replaceChildren(price, ` faltam ${d.cost - s.essence}`);
      else c.cost.replaceChildren('Comprar ', price);
      c.warn.classList.toggle('hidden', !swap);
      if (swap && sp) c.warn.textContent = `⚠ Substitui seu Especial atual (${SPECIAL_INFO[sp].icon} ${SPECIAL_INFO[sp].name})`;
    }
    for (const l of LINES) {
      const col = this.cols[l];
      const n = counts[l];
      const total = SKILL_IDS.filter((id) => SKILLS[id].line === l && (mode.mastery || SKILLS[id].tier < 3)).length;
      const txt = `${n}/${total}`;
      if (col.count.textContent !== txt) col.count.textContent = txt;
      if (col.tabCount.textContent !== txt) col.tabCount.textContent = txt;
      col.tab.classList.toggle('can', can[l] > 0);
      col.sets[0].classList.toggle('on', n >= 2);
      col.sets[1].classList.toggle('on', n >= 4);
    }
  }

  private tryBuy(id: SkillId): void {
    const c = this.cards.get(id)!;
    const s = this.state;
    if (!s || this.busy) return;
    if (c.state !== 'ok') {
      // Recusa: o cartão treme e o custo pisca
      if (!reduced()) play(c.el, [{ translate: '3px 0' }, { translate: '-3px 0' }, { translate: '2px 0' }, { translate: '0 0' }], { duration: 160, easing: 'steps(4)' }, this.fx);
      play(c.cost, [{ color: '#ff4f6d' }, { color: '#ff4f6d' }], { duration: 300 }, this.fx);
      return;
    }
    this.busy = { id, at: performance.now() };
    this.onBuy(id);
    vibrate(12);
    this.render(false);
    // Sem resposta do servidor: o cartão volta ao normal
    later(BUSY_MS + 50, () => {
      if (this.busy?.id === id) {
        this.busy = null;
        this.render(false);
      }
    }, this.fx);
  }

  /** Compra confirmada: carimbo, estouro na cor da linha e contador descendo. */
  private bought(id: SkillId): void {
    const c = this.cards.get(id);
    if (!c || !this.isOpen) return;
    const color = LINE_INFO[SKILLS[id].line].color;
    stampIn(c.el, this.fx, { from: 1.15, ms: 200 });
    if (!reduced()) {
      const r = c.el.getBoundingClientRect();
      burst(r.left + 24, r.top + r.height / 2, 12, [color, '#ffffff', '#ffcf3f'], { speed: [60, 140], life: [260, 420], step: true });
    }
  }
}
