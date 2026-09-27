import { h, modal } from './dom';

export function showHelp(): void {
  modal(
    'Como jogar',
    h(
      'div',
      {},
      h('p', {}, 'Você nasce como um ovo. ', h('b', {}, 'Toque no chão para andar'), ' e ', h('b', {}, 'toque num bicho para batalhar'), '. Você vira o que você come: comer bichos de fogo, água ou planta muda a sua evolução.'),
      h('div', { class: 'label' }, 'Batalha: escolha ao mesmo tempo que o oponente'),
      h('div', { class: 'tri' }, h('div', {}, '⚔️ Ataque', h('br'), h('small', { class: 'muted' }, 'vence Carga')), h('div', {}, '🛡️ Defesa', h('br'), h('small', { class: 'muted' }, 'vence Ataque')), h('div', {}, '⚡ Carga', h('br'), h('small', { class: 'muted' }, 'vence Defesa e dobra o próximo golpe'))),
      h('div', { class: 'label', style: 'margin-top:12px' }, 'Tipos'),
      h('p', {}, '🔥 Brasa vence 🌿 Broto, que vence 🌊 Maré, que vence 🔥 Brasa (dano ×1,5). Misture tipos para virar Vapor, Cinza, Mangue ou até a rara Quimera.'),
      h('div', { class: 'label' }, 'A partida (~5 min)'),
      h(
        'ul',
        {},
        h('li', {}, h('b', {}, 'Coleta (0:00–2:00): '), 'só bichos selvagens. Evolua de ovo até a forma final.'),
        h('li', {}, h('b', {}, 'Caçada (2:00–4:00): '), 'toque em outros jogadores para desafiá-los. A zona começa a fechar.'),
        h('li', {}, h('b', {}, 'Final (4:00+): '), 'os selvagens somem e cada derrota custa 2 estágios. Depois vem a Morte súbita.'),
      ),
      h('div', { class: 'label' }, 'O twist'),
      h('p', {}, 'Quem perde entrega um estágio para o vencedor. Você só é eliminado se perder quando ainda é ovo. Quem tem a 👑 Coroa vale XP extra. Depois de perder, você ganha a Fome: 5s de proteção e XP em dobro.'),
    ),
  );
}
