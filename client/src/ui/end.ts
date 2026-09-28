import { FORM_LABEL, LINE_INFO, levelOf, SKILLS, speciesName, titleOf, type Look, type RankRow, type ServerMsg } from '@vb/shared';
import { creatureImg } from '../render/creature';
import { FORM_COLOR } from '../render/palette';
import { play, reduced, stampIn } from './anim';
import { titleBadge } from './build';
import { fmtTime, h, mount } from './dom';
import { confetti, runeCanvas } from './fxcanvas';
import { buildShareCard } from './sharecard';

type EndMsg = Extract<ServerMsg, { t: 'end' }>;
type DeathMsg = Extract<ServerMsg, { t: 'death' }>;

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
  const why = reason === 'duelo' ? 'Você ficou fora do Duelo Final: só os 2 mais fortes seguem.' : by ? `${by} te eliminou.` : 'A zona te consumiu.';
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

/**
 * Aviso de morte (a partida continua): quem ou o que derrubou, o que foi perdido e a contagem até
 * renascer do ovo. Não captura toques e some sozinho quando o ovo começa a chocar.
 */
export function showDeath(msg: DeathMsg, respawnAt: number): HTMLElement {
  const why = msg.reason === 'zona' ? 'A zona te consumiu.' : msg.by ? `${msg.by} te derrotou.` : 'Você foi derrotado.';
  const lost: string[] = [];
  if (msg.lost.essence > 0) lost.push(`−${msg.lost.essence} ✨ Essência`);
  if (msg.lost.points > 0) lost.push(`−${msg.lost.points} pontos de tipo`);
  lost.push('XP do nível zerado');
  const count = h('b', { class: 'dcount' });
  const reborn = h('div', { class: 'dreborn' }, '🥚 Renascendo em ', count);
  const el = mount(
    h(
      'div',
      { class: `card death stack${msg.reason === 'zona' ? ' zona' : ''}`, role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'dtitle' }, '💀 VOCÊ MORREU'),
      h('div', { class: 'why' }, why),
      h('div', { class: 'dlost' }, ...lost.map((t) => h('span', {}, t))),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Suas habilidades e troféus continuam com você.'),
      reborn,
    ),
  );
  stampIn(el, undefined, { from: 1.6, ms: 220 });
  let last = -1;
  const tick = () => {
    if (!el.isConnected) return;
    const left = Math.max(0, respawnAt - performance.now());
    const sec = Math.ceil(left / 1000);
    if (sec !== last) {
      last = sec;
      count.textContent = `${sec}s`;
      if (sec > 0 && !reduced()) play(count, [{ scale: '1.4' }, { scale: '1' }], { duration: 200, easing: 'steps(2)' });
    }
    if (left > 0) {
      window.setTimeout(tick, 100);
      return;
    }
    reborn.textContent = '🥚 Renascendo…';
    play(el, [{ opacity: 1 }, { opacity: 0 }], { delay: 700, duration: 250, fill: 'forwards' });
    window.setTimeout(() => el.remove(), 980);
  };
  tick();
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

/** Uma linha do ranking: posição, bicho, nome, título, Força, mortes e as marcas do duelo e do "você". */
function rankRow(r: RankRow): HTMLElement {
  const t = titleOf(r.skills);
  const duel = r.duel === 1 ? h('span', { class: 'rduel win', title: 'Venceu o Duelo Final' }, '⚔️🏆') : r.duel === 2 ? h('span', { class: 'rduel', title: 'Finalista do Duelo Final' }, '⚔️') : null;
  return h(
    'li',
    { class: `rrow${r.you ? ' you' : ''}${r.place <= 3 ? ` p${r.place}` : ''}` },
    h('span', { class: 'rpos' }, String(r.place)),
    creatureImg(r.look, 1),
    h(
      'span',
      { class: 'rwho' },
      h('b', {}, r.name, r.you ? h('i', { class: 'ryou' }, 'você') : null, duel),
      h('small', { style: t ? `color:${LINE_INFO[t.line].color}` : undefined }, t ? `${LINE_INFO[t.line].icon} ${t.name}` : `${speciesName(r.look.form, r.look.stage)} · Nv ${levelOf(r.look.stage)}`),
    ),
    h('span', { class: 'rpw', title: 'Força' }, `💪${r.power}`),
    h('span', { class: 'rdeaths', title: 'Mortes' }, `💀${r.deaths}`),
  );
}

export function showEnd(msg: EndMsg, onAgain: () => void, onMenu: () => void): void {
  const you = msg.you;
  const t = titleOf(you.skills ?? []);
  const card = buildShareCard({
    name: you.name,
    look: you.look,
    place: msg.place,
    total: msg.total,
    history: msg.history,
    wins: you.wins,
    steals: you.steals,
    deaths: you.deaths ?? 0,
    power: you.power ?? 0,
    skills: you.skills ?? [],
    title: t ? { icon: LINE_INFO[t.line].icon, text: t.name, color: LINE_INFO[t.line].color } : null,
  });
  card.className = 'sharecard';
  const won = msg.place === 1;
  const rm = reduced();
  const steps = msg.history.filter((it, i, arr) => i === 0 || arr[i - 1].look.form !== it.look.form || arr[i - 1].look.stage !== it.look.stage || it.ev.startsWith('Roubou') || it.ev.startsWith('Perdeu'));
  const placeEl = h('div', { class: `place${won ? ' won' : ''}` }, won ? '🏆 VOCÊ VENCEU!' : `#${msg.place} de ${msg.total}`);
  const statDefs: [number, string][] = [
    [you.wins, 'vitórias'],
    [you.steals, 'roubos'],
    [you.wilds, 'bichos comidos'],
    [you.deaths ?? 0, 'mortes'],
    [you.power ?? 0, 'Força'],
  ];
  const statEls = statDefs.map(([v]) => h('b', {}, String(v)));
  const stepEls = steps.slice(-12).map((it) => h('div', { class: 'step' }, creatureImg(it.look, 2), h('div', {}, fmtTime(it.el)), h('div', {}, it.ev)));
  const ranking = msg.ranking ?? [];
  const rowEls = ranking.map(rankRow);
  const build = you.skills ?? [];
  const screen = mount(
    h(
      'section',
      { class: 'screen' },
      h(
        'div',
        { class: 'stack' },
        placeEl,
        won ? h('div', { class: 'hero' }, withRunes(you.look, 3)) : null,
        msg.winner && !won
          ? h('div', { class: 'card', style: 'display:flex;align-items:center;gap:12px' }, withRunes(msg.winner.look, 2), h('div', {}, h('div', { class: 'label' }, 'Vencedor'), h('b', {}, msg.winner.name), h('div', { class: 'muted small' }, `${speciesName(msg.winner.look.form, msg.winner.look.stage)} · ${FORM_LABEL[msg.winner.look.form]}`)))
          : null,
        h('div', { class: 'card stats' }, ...statDefs.map(([, label], i) => h('div', {}, statEls[i], label))),
        h(
          'div',
          { class: 'card endbuild' },
          h('div', { class: 'label' }, 'Sua build'),
          titleBadge(build),
          build.length
            ? h(
                'div',
                { class: 'bskills' },
                ...build.map((id) => {
                  const d = SKILLS[id];
                  return h('span', { class: `bskill${d.special ? ' sp' : ''}`, style: `--lc:${LINE_INFO[d.line].color}`, title: d.desc }, h('i', {}, d.icon), d.name);
                }),
              )
            : h('p', { class: 'muted small', style: 'margin:0' }, 'Nenhuma habilidade comprada nesta partida.'),
        ),
        rowEls.length ? h('div', { class: 'card' }, h('div', { class: 'label' }, `Ranking (${ranking.length})`), h('ol', { class: 'ranklist' }, ...rowEls)) : null,
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
  statEls.forEach((el, i) => countUp(el, Number(el.textContent), roll + i * 150, i === 4 ? 700 : 500));
  // O ranking entra de baixo para cima (do último ao 1º), terminando na sua linha em destaque
  rowEls.forEach((el, i) => play(el, [{ translate: '-12px 0', opacity: 0 }, { translate: '0 0', opacity: 1 }], { delay: roll + 200 + (rowEls.length - 1 - i) * 50, duration: 160, easing: 'steps(3)', fill: 'backwards' }));
  stepEls.forEach((el, i) => play(el, [{ scale: '0.6', opacity: 0 }, { scale: '1', opacity: 1 }], { delay: roll + 300 + i * 70, duration: 180, easing: 'steps(3)', fill: 'backwards' }));
  popButtons(screen, roll + 400);
}
