import { ELEMS, formOf, type Look, type ServerMsg, type Stage } from '@vb/shared';
import { creatureImg } from '../render/creature';
import { showBestiary } from './bestiary';
import { clearUi, fmtTime, h, mount } from './dom';
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

export function showMenu(onPlay: (req: PlayRequest) => void, error = ''): void {
  clearUi();
  window.clearInterval(previewTimer);
  const params = new URLSearchParams(location.search);
  const invite = (params.get('sala') ?? '').toUpperCase().slice(0, 4);
  const nameInput = h('input', { class: 'field', maxlength: 14, placeholder: 'Seu apelido', value: localStorage.getItem('vb.name') ?? '' }) as HTMLInputElement;
  const codeInput = h('input', { class: 'field', maxlength: 4, placeholder: 'CÓDIGO', value: invite, style: 'text-transform:uppercase;text-align:center;letter-spacing:4px' }) as HTMLInputElement;
  const err = h('div', { class: 'error' }, error);
  const preview = h('div', { class: 'preview' });
  const refresh = () => preview.replaceChildren(creatureImg(randomLook(), 3), creatureImg(randomLook(), 3), creatureImg(randomLook(), 3));
  refresh();
  previewTimer = window.setInterval(refresh, 2200);

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
      h(
        'div',
        { class: 'stack' },
        h('h1', { class: 'logo' }, 'VIRA-BICHO'),
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
                    if (navigator.share) await navigator.share({ title: 'VIRA-BICHO', text: 'Bora uma partida de VIRA-BICHO?', url: link });
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
      h('div', { class: 'players' }, ...msg.players.map((n) => h('span', { class: 'chip' }, n)), ...Array.from({ length: bots }, () => h('span', { class: 'chip bot' }, '🤖 bot'))),
      h('div', { class: 'big-count' }, msg.startsIn === null ? '...' : `Começa em ${fmtTime(msg.startsIn)}`),
      h('p', { class: 'muted small', style: 'margin:0;text-align:center' }, bots ? `Se ninguém mais entrar, ${bots} bots completam a arena.` : 'Arena cheia de gente de verdade!'),
      h('button', { class: 'btn primary', onclick: handlers.onStartNow }, '⚡ Começar agora'),
      h('button', { class: 'btn ghost', onclick: handlers.onLeave }, 'Sair'),
    ),
    h('p', { class: 'tagline small' }, 'Dica: toque no chão para andar e toque num bicho para batalhar.'),
  );
  if (!lobbyEl || !lobbyEl.isConnected) {
    clearUi();
    lobbyEl = mount(h('section', { class: 'screen' }));
  }
  lobbyEl.replaceChildren(body);
}
