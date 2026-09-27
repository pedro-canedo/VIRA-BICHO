import { FORM_LABEL, speciesName, type ServerMsg } from '@vb/shared';
import { creatureImg } from '../render/creature';
import { fmtTime, h, mount } from './dom';
import { buildShareCard } from './sharecard';

type EndMsg = Extract<ServerMsg, { t: 'end' }>;

export function showEliminated(by: string | null, place: number, reason: 'batalha' | 'zona' | 'duelo', onMenu: () => void): HTMLElement {
  const why = reason === 'duelo' ? 'Você ficou fora do Duelo Final: só os 2 mais evoluídos seguem.' : by ? `${by} te eliminou.` : 'A zona te consumiu.';
  const el = mount(
    h(
      'div',
      { class: 'card dead stack' },
      h('div', { class: 'place' }, `#${place}`),
      h('div', { style: 'text-align:center;font-weight:900;font-size:18px' }, why),
      h('p', { class: 'muted', style: 'text-align:center;margin:0' }, reason === 'duelo' ? 'O duelo vai começar...' : by ? `Assistindo ${by}...` : 'Assistindo a partida...'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => el.remove() }, '👀 Assistir'), h('button', { class: 'btn primary', onclick: onMenu }, 'Menu')),
    ),
  );
  return el;
}

export function showEnd(msg: EndMsg, onAgain: () => void, onMenu: () => void): void {
  const card = buildShareCard({ name: msg.you.name, look: msg.you.look, place: msg.place, total: msg.total, history: msg.history, wins: msg.you.wins, steals: msg.you.steals });
  card.className = 'sharecard';
  const won = msg.place === 1;
  const steps = msg.history.filter((it, i, arr) => i === 0 || arr[i - 1].look.form !== it.look.form || arr[i - 1].look.stage !== it.look.stage || it.ev.startsWith('Roubou') || it.ev.startsWith('Perdeu'));
  mount(
    h(
      'section',
      { class: 'screen' },
      h(
        'div',
        { class: 'stack' },
        h('div', { class: 'place' }, won ? '🏆 VOCÊ VENCEU!' : `#${msg.place} de ${msg.total}`),
        msg.winner && !won
          ? h('div', { class: 'card', style: 'display:flex;align-items:center;gap:12px' }, creatureImg(msg.winner.look, 2), h('div', {}, h('div', { class: 'label' }, 'Vencedor'), h('b', {}, msg.winner.name), h('div', { class: 'muted small' }, `${speciesName(msg.winner.look.form, msg.winner.look.stage)} · ${FORM_LABEL[msg.winner.look.form]}`)))
          : null,
        h('div', { class: 'card stats' }, h('div', {}, h('b', {}, msg.you.wins), 'vitórias'), h('div', {}, h('b', {}, msg.you.steals), 'roubos'), h('div', {}, h('b', {}, msg.you.wilds), 'bichos comidos')),
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'label' }, 'Sua evolução'),
          h('div', { class: 'timeline' }, ...steps.slice(-12).map((it) => h('div', { class: 'step' }, creatureImg(it.look, 2), h('div', {}, fmtTime(it.el)), h('div', {}, it.ev)))),
        ),
        card,
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                const a = document.createElement('a');
                a.href = card.toDataURL('image/png');
                a.download = 'batlle-bicho.png';
                a.click();
              },
            },
            '📸 Baixar cartão',
          ),
          h('button', { class: 'btn primary', onclick: onAgain }, '▶ Jogar de novo'),
        ),
        h('button', { class: 'btn ghost', onclick: onMenu }, 'Voltar ao menu'),
      ),
    ),
  );
}
