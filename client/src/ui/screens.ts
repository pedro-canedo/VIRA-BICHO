import { ELEMS, formOf, type Look, type ServerMsg, type Stage } from '@vb/shared';
import { creatureImg } from '../render/creature';
import { showBestiary } from './bestiary';
import { clearUi, fmtTime, h, mount } from './dom';
import { ELEM_TONE } from '../render/palette';
import { reduced } from './anim';
import { burst, RAMP, refreshFxTier, runeCanvas } from './fxcanvas';
import { showHelp } from './help';

export interface PlayRequest {
  mode: 'quick' | 'create' | 'join';
  name: string;
  code?: string;
}

function randomLook(): Look {
  const stage = (1 + Math.floor(Math.random() * 3)) as Stage;
  const points = { brasa: 0, mare: 0, broto: 0 };
  const n = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) points[ELEMS[Math.floor(Math.random() * 3)]] += 2 + Math.floor(Math.random() * 4);
  const order = ELEMS.filter((e) => points[e] > 0).sort((a, b) => points[b] - points[a]);
  return { form: formOf(points), stage, order };
}

let previewTimer = 0;

const FX_TIERS = [
  ['auto', 'Auto'],
  ['alto', 'Alto'],
  ['medio', 'Médio'],
  ['baixo', 'Baixo'],
] as const;

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    // sem armazenamento: vale só nesta sessão
  }
}

/** Seletor de qualidade dos efeitos ('vb.fx', lido pelo mundo) e chave da vibração ('vb.vibe'). */
function optionsCard(): HTMLElement {
  let fx = readPref('vb.fx', 'auto');
  const tierBtns = FX_TIERS.map(([v, label]) =>
    h(
      'button',
      {
        class: `btn${fx === v ? ' on' : ''}`,
        onclick: () => {
          fx = v;
          writePref('vb.fx', v);
          refreshFxTier();
          tierBtns.forEach((b, i) => b.classList.toggle('on', FX_TIERS[i][0] === v));
        },
      },
      label,
    ),
  );
  const vibeLabel = () => `📳 Vibração: ${readPref('vb.vibe', '1') === '0' ? 'não' : 'sim'}`;
  const vibe: HTMLButtonElement = h(
    'button',
    {
      class: 'btn',
      onclick: () => {
        writePref('vb.vibe', readPref('vb.vibe', '1') === '0' ? '1' : '0');
        vibe.textContent = vibeLabel();
      },
    },
    vibeLabel(),
  );
  return h('div', { class: 'card opts' }, h('div', { class: 'label', style: 'margin:0;width:100%' }, 'Efeitos'), h('div', { class: 'seg' }, ...tierBtns), vibe);
}

/** Título com as letras balançando em onda (cada letra com a sua cor da rampa). */
function logo(): HTMLElement {
  const ramp = ['#ff7a3d', '#ffa23e', '#ffcf3f', '#a9cd4f', '#52c95f', '#4eb6af', '#4aa3ff'];
  const text = 'BATLLE-BICHO';
  return h('h1', { class: 'logo wave', 'aria-label': text }, ...[...text].map((ch, i) => h('span', { style: `color:${ramp[Math.round((i / (text.length - 1)) * (ramp.length - 1))]};animation-delay:${i * 0.1}s`, 'aria-hidden': 'true' }, ch)));
}

/** 12 partículas de elemento flutuando no fundo (somem com reduced-motion via CSS). */
function motes(): HTMLElement {
  const box = h('div', { class: 'motes', 'aria-hidden': 'true' });
  for (let i = 0; i < 12; i++) {
    const e = ELEMS[i % 3];
    box.append(h('i', { style: `left:${4 + ((i * 37) % 92)}%;background:${ELEM_TONE[e].body};animation-duration:${7 + (i % 5)}s;animation-delay:${-((i * 1.7) % 9).toFixed(1)}s` }));
  }
  return box;
}

export function showMenu(onPlay: (req: PlayRequest) => void, error = ''): void {
  clearUi();
  window.clearInterval(previewTimer);
  const params = new URLSearchParams(location.search);
  const invite = (params.get('sala') ?? '').toUpperCase().slice(0, 4);
  const nameInput = h('input', { class: 'field', maxlength: 14, placeholder: 'Seu apelido', value: localStorage.getItem('vb.name') ?? '' }) as HTMLInputElement;
  const codeInput = h('input', { class: 'field', maxlength: 4, placeholder: 'CÓDIGO', value: invite, style: 'text-transform:uppercase;text-align:center;letter-spacing:4px' }) as HTMLInputElement;
  const err = h('div', { class: 'error' }, error);
  // Círculo de runas girando devagar atrás das prévias
  const ring = runeCanvas('#b98cff', 48);
  ring.classList.add('menurune');
  const pets = h('div', { class: 'pets' });
  const preview = h('div', { class: 'preview' }, ring, pets);
  const refresh = (poof: boolean) => {
    const looks = [randomLook(), randomLook(), randomLook()];
    pets.replaceChildren(...looks.map((l) => creatureImg(l, 3)));
    if (!poof || !pets.isConnected || reduced()) return;
    // Poof de 8 quadradinhos na cor do elemento de cada prévia
    pets.querySelectorAll('canvas').forEach((c, i) => {
      const r = c.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2 + 8, 8, RAMP[looks[i].form], { speed: [70, 130], life: [220, 320], even: true, step: true });
    });
  };
  refresh(false);
  previewTimer = window.setInterval(() => refresh(true), 2200);

  const go = (mode: PlayRequest['mode']) => {
    const name = nameInput.value.trim();
    if (!name) {
      err.textContent = 'Escolha um apelido primeiro.';
      nameInput.focus();
      return;
    }
    const code = codeInput.value.trim().toUpperCase();
    if (mode === 'join' && code.length !== 4) {
      err.textContent = 'O código da sala tem 4 letras.';
      codeInput.focus();
      return;
    }
    localStorage.setItem('vb.name', name);
    window.clearInterval(previewTimer);
    onPlay({ mode, name, code });
  };

  mount(
    h(
      'section',
      { class: 'screen' },
      motes(),
      h(
        'div',
        { class: 'stack' },
        logo(),
        h('p', { class: 'tagline' }, 'Você vira o que você come. Quem perde entrega a evolução.'),
        preview,
        h(
          'div',
          { class: 'card stack' },
          h('div', {}, h('div', { class: 'label' }, 'Apelido'), nameInput),
          invite
            ? h('button', { class: 'btn primary', onclick: () => go('join') }, `Entrar na sala ${invite}`)
            : h('button', { class: 'btn primary', onclick: () => go('quick') }, '▶ Jogar agora'),
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => go('create') }, 'Criar sala'), h('div', { style: 'display:flex;gap:6px' }, codeInput, h('button', { class: 'btn', onclick: () => go('join') }, 'Entrar'))),
          err,
        ),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: showHelp }, 'Como jogar'), h('button', { class: 'btn', onclick: showBestiary }, 'Bestiário')),
        optionsCard(),
        h('p', { class: 'tagline small' }, 'Partidas de ~5 min com 8 a 16 bichos. Faltou gente? Bots completam a arena.'),
        h('p', { class: 'tagline small' }, '📱 Este servidor roda num celular reaproveitado.'),
      ),
    ),
  );
  if (!nameInput.value) nameInput.focus();
}

export interface LobbyHandlers {
  onStartNow(): void;
  onLeave(): void;
}

let lobbyEl: HTMLElement | null = null;
let lobbyBody: HTMLElement | null = null;
/** Quem já apareceu na sala (os chips novos entram com pop). */
const lobbySeen = new Set<string>();

export function showLobby(msg: Extract<ServerMsg, { t: 'lobby' }>, handlers: LobbyHandlers): void {
  const link = `${location.origin}/?sala=${msg.code}`;
  const bots = Math.max(0, msg.min - msg.players.length);
  const body = h(
    'div',
    { class: 'stack' },
    h('h1', { class: 'logo', style: 'font-size:24px' }, msg.private ? 'Sala privada' : 'Arena'),
    h(
      'div',
      { class: 'card stack' },
      msg.private
        ? h(
            'div',
            {},
            h('div', { class: 'label' }, 'Código da sala'),
            h('div', { class: 'code' }, msg.code),
            h(
              'button',
              {
                class: 'btn',
                style: 'width:100%',
                onclick: async (e: Event) => {
                  const btn = e.currentTarget as HTMLButtonElement;
                  try {
                    if (navigator.share) await navigator.share({ title: 'BATLLE-BICHO', text: 'Bora uma partida de BATLLE-BICHO?', url: link });
                    else await navigator.clipboard.writeText(link);
                    btn.textContent = 'Link copiado!';
                  } catch {
                    btn.textContent = link;
                  }
                },
              },
              '🔗 Convidar amigos',
            ),
          )
        : null,
      h('div', { class: 'label' }, `Jogadores (${msg.players.length}/${msg.max})`),
      h('div', { class: 'players' }, ...msg.players.map((n) => h('span', { class: `chip${lobbySeen.has(n) ? '' : ' new'}` }, n)), ...Array.from({ length: bots }, () => h('span', { class: 'chip bot' }, '🤖 bot'))),
      h('div', { class: `big-count${msg.startsIn !== null && msg.startsIn <= 5000 ? ' hot' : ''}` }, msg.startsIn === null ? '...' : `Começa em ${fmtTime(msg.startsIn)}`),
      h('p', { class: 'muted small', style: 'margin:0;text-align:center' }, bots ? `Se ninguém mais entrar, ${bots} bots completam a arena.` : 'Arena cheia de gente de verdade!'),
      h('button', { class: 'btn primary', onclick: handlers.onStartNow }, '⚡ Começar agora'),
      h('button', { class: 'btn ghost', onclick: handlers.onLeave }, 'Sair'),
    ),
    h('p', { class: 'tagline small' }, 'Dica: toque no chão para andar e toque num bicho para batalhar.'),
  );
  if (!lobbyEl || !lobbyEl.isConnected) {
    clearUi();
    lobbySeen.clear();
    lobbyBody = h('div', { class: 'stack' });
    lobbyEl = mount(h('section', { class: 'screen' }, motes(), lobbyBody));
  }
  lobbyBody!.replaceChildren(...body.childNodes);
  for (const n of msg.players) lobbySeen.add(n);
}
