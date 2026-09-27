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
  const codeInput = h('input', { class: 'field', maxlength: 4, placeholder: 'CÓDIGO', value: invite, style: 'text-transform:uppercase;text-align:center;letter-spacing:2px;min-width:7.5em' }) as HTMLInputElement;
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
        h('h1', { class: 'logo' }, 'BATLLE-BICHO'),
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

interface LobbyView {
  code: string;
  root: HTMLElement;
  label: HTMLElement;
  players: HTMLElement;
  count: HTMLElement;
  hint: HTMLElement;
}

let lobbyView: LobbyView | null = null;

/**
 * Sala de espera. A estrutura (e os botões) é montada uma vez por sala e depois só os textos
 * mudam: recriar os botões a cada segundo fazia toques se perderem no celular.
 */
export function showLobby(msg: Extract<ServerMsg, { t: 'lobby' }>, handlers: LobbyHandlers): void {
  if (!lobbyView || lobbyView.code !== msg.code || !lobbyView.root.isConnected) lobbyView = buildLobby(msg, handlers);
  const v = lobbyView;
  const bots = Math.max(0, msg.min - msg.players.length);
  v.label.textContent = `Jogadores (${msg.players.length}/${msg.max})`;
  const chips = [...msg.players.map((n) => ['chip', n]), ...Array.from({ length: bots }, () => ['chip bot', '🤖 bot'])];
  // Chips não são clicáveis: podem ser trocados sem risco para o toque.
  if (v.players.dataset.sig !== JSON.stringify(chips)) {
    v.players.dataset.sig = JSON.stringify(chips);
    v.players.replaceChildren(...chips.map(([cls, text]) => h('span', { class: cls }, text)));
  }
  v.count.textContent = msg.startsIn === null ? '...' : `Começa em ${fmtTime(msg.startsIn)}`;
  v.hint.textContent = bots ? `Se ninguém mais entrar, ${bots} bots completam a arena.` : 'Arena cheia de gente de verdade!';
}

function buildLobby(msg: Extract<ServerMsg, { t: 'lobby' }>, handlers: LobbyHandlers): LobbyView {
  const link = `${location.origin}/?sala=${msg.code}`;
  const label = h('div', { class: 'label' });
  const players = h('div', { class: 'players' });
  const count = h('div', { class: 'big-count' });
  const hint = h('p', { class: 'muted small', style: 'margin:0;text-align:center' });
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
      label,
      players,
      count,
      hint,
      h('button', { class: 'btn primary', onclick: handlers.onStartNow }, '⚡ Começar agora'),
      h('button', { class: 'btn ghost', onclick: handlers.onLeave }, 'Sair'),
    ),
    h('p', { class: 'tagline small' }, 'Dica: toque no chão para andar e toque num bicho para batalhar.'),
  );
  clearUi();
  const root = mount(h('section', { class: 'screen' }, body));
  return { code: msg.code, root, label, players, count, hint };
}
