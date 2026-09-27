import { FORM_LABEL, speciesName, type Look, type ServerMsg } from '@vb/shared';
import { creatureImg } from '../render/creature';
import { FORM_COLOR } from '../render/palette';
import { play, reduced, stampIn } from './anim';
import { fmtTime, h, mount } from './dom';
import { confetti, runeCanvas } from './fxcanvas';
import { buildShareCard } from './sharecard';

type EndMsg = Extract<ServerMsg, { t: 'end' }>;

const CONFETTI = ['#ff7a3d', '#4aa3ff', '#52c95f', '#ffcf3f', '#ff5fd2'];

/** Bicho com um anel de runas girando atrás (em degraus de 90°). */
function withRunes(look: Look, scale: number): HTMLElement {
  const ring = runeCanvas(FORM_COLOR[look.form], 48);
  ring.classList.add('endrune');
  return h('div', { class: 'runewrap' }, ring, creatureImg(look, scale));
}

/** Botões entram com pop, um depois do outro. */
function popButtons(root: HTMLElement, delay: number): void {
  root.querySelectorAll('.btn').forEach((b, i) => stampIn(b, undefined, { from: 0.6, ms: 200, delay: delay + i * 80 }));
}

export function showEliminated(by: string | null, place: number, reason: 'batalha' | 'zona' | 'duelo', onMenu: () => void): HTMLElement {
  const why = reason === 'duelo' ? 'Você ficou fora do Duelo Final: só os 2 mais evoluídos seguem.' : by ? `${by} te eliminou.` : 'A zona te consumiu.';
  const el = mount(
    h(
      'div',
      { class: `card dead stack${reason === 'zona' ? ' zona' : ''}` },
      h('div', { class: 'place bad' }, `#${place}`),
      h('div', { class: 'why', style: 'text-align:center;font-weight:900;font-size:18px' }, why),
      h('p', { class: 'muted', style: 'text-align:center;margin:0' }, reason === 'duelo' ? 'O duelo vai começar...' : by ? `Assistindo ${by}...` : 'Assistindo a partida...'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => el.remove() }, '👀 Assistir'), h('button', { class: 'btn primary', onclick: onMenu }, 'Menu')),
    ),
  );
  // Entra como carimbo 700 ms depois, dando tempo para a explosão no mundo
  stampIn(el, undefined, { from: 2, ms: 220, delay: 700 });
  popButtons(el, 900);
  return el;
}

/** Conta de 0 até o valor com um pulinho a cada inteiro. */
function countUp(el: HTMLElement, to: number, delay: number, ms = 500): void {
  if (reduced() || to <= 0) {
    el.textContent = String(to);
    return;
  }
  el.textContent = '0';
  const t0 = performance.now() + delay;
  let shown = 0;
  const step = (now: number) => {
    if (!el.isConnected) return;
    const n = Math.min(to, Math.floor((Math.max(0, now - t0) / ms) * to));
    if (n !== shown) {
      shown = n;
      el.textContent = String(n);
      play(el, [{ translate: '0 0' }, { translate: '0 -3px' }, { translate: '0 0' }], { duration: 90, easing: 'steps(2)' });
    }
    if (n < to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Confete da tela final: chuva por 1,5 s e, no 1º lugar, dois canhões laterais. */
function celebrate(place: number): void {
  if (reduced()) return;
  const W = innerWidth;
  const rain = (n: number, cs: string[]) => confetti(W / 2, -6, n, cs, { angle: [70, 110], speed: [30, 120], gravity: 180, life: 2600, spread: W / 2 });
  if (place === 1) {
    for (let i = 0; i < 6; i++) window.setTimeout(() => rain(20, CONFETTI), i * 250);
    for (const t of [600, 1200])
      window.setTimeout(() => {
        confetti(0, innerHeight * 0.75, 18, CONFETTI, { angle: [-75, -45], speed: [380, 620], gravity: 900, life: 1600 });
        confetti(W, innerHeight * 0.75, 18, CONFETTI, { angle: [-135, -105], speed: [380, 620], gravity: 900, life: 1600 });
      }, t);
  } else if (place <= 3) {
    const c = place === 2 ? '#e9e1cc' : '#a8845c';
    for (let i = 0; i < 4; i++) window.setTimeout(() => rain(10, [c, '#ffffff']), i * 350);
  }
}

export function showEnd(msg: EndMsg, onAgain: () => void, onMenu: () => void): void {
  const card = buildShareCard({ name: msg.you.name, look: msg.you.look, place: msg.place, total: msg.total, history: msg.history, wins: msg.you.wins, steals: msg.you.steals });
  card.className = 'sharecard';
  const won = msg.place === 1;
  const rm = reduced();
  const steps = msg.history.filter((it, i, arr) => i === 0 || arr[i - 1].look.form !== it.look.form || arr[i - 1].look.stage !== it.look.stage || it.ev.startsWith('Roubou') || it.ev.startsWith('Perdeu'));
  const placeEl = h('div', { class: `place${won ? ' won' : ''}` }, won ? '🏆 VOCÊ VENCEU!' : `#${msg.place} de ${msg.total}`);
  const statEls = [msg.you.wins, msg.you.steals, msg.you.wilds].map((v) => h('b', {}, String(v)));
  const stepEls = steps.slice(-12).map((it) => h('div', { class: 'step' }, creatureImg(it.look, 2), h('div', {}, fmtTime(it.el)), h('div', {}, it.ev)));
  const screen = mount(
    h(
      'section',
      { class: 'screen' },
      h(
        'div',
        { class: 'stack' },
        placeEl,
        won ? h('div', { class: 'hero' }, withRunes(msg.you.look, 3)) : null,
        msg.winner && !won
          ? h('div', { class: 'card', style: 'display:flex;align-items:center;gap:12px' }, withRunes(msg.winner.look, 2), h('div', {}, h('div', { class: 'label' }, 'Vencedor'), h('b', {}, msg.winner.name), h('div', { class: 'muted small' }, `${speciesName(msg.winner.look.form, msg.winner.look.stage)} · ${FORM_LABEL[msg.winner.look.form]}`)))
          : null,
        h('div', { class: 'card stats' }, h('div', {}, statEls[0], 'vitórias'), h('div', {}, statEls[1], 'roubos'), h('div', {}, statEls[2], 'bichos comidos')),
        h('div', { class: 'card' }, h('div', { class: 'label' }, 'Sua evolução'), h('div', { class: 'timeline' }, ...stepEls)),
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

  if (rm) {
    play(screen.firstElementChild!, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    return;
  }
  // Colocação: caça-níquel do total até a sua posição e carimbo
  let roll = 0;
  if (won) stampIn(placeEl, undefined, { from: 3, ms: 240 });
  else {
    roll = 600;
    const frames = 12;
    for (let i = 1; i <= frames; i++) {
      window.setTimeout(() => {
        const n = i === frames ? msg.place : Math.round(msg.total - ((msg.total - msg.place) * i) / frames) || msg.place;
        placeEl.textContent = `#${n} de ${msg.total}`;
        if (i === frames) stampIn(placeEl, undefined, { from: 2, ms: 200 });
      }, i * (roll / frames));
    }
  }
  celebrate(msg.place);
  statEls.forEach((el, i) => countUp(el, Number(el.textContent), roll + i * 150));
  stepEls.forEach((el, i) => play(el, [{ scale: '0.6', opacity: 0 }, { scale: '1', opacity: 1 }], { delay: roll + 300 + i * 70, duration: 180, easing: 'steps(3)', fill: 'backwards' }));
  popButtons(screen, roll + 400);
}
