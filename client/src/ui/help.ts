import { BALANCE, GAME_MODES, LINE_INFO, LINES, MODES, MOVE_LABEL, SPECIAL_INFO, STAGE_LABEL, type BasicAction, type SpecialKind } from '@vb/shared';
import { fmtTime, h, modal } from './dom';

const E = BALANCE.essence;
const pct = (f: number) => `${Math.round(f * 100)}%`;

/** Tabela simples (cabeçalho + linhas). */
function table(head: string[], rows: (string | Node)[][], cls = ''): HTMLElement {
  return h('table', { class: `htable ${cls}`.trim() }, h('thead', {}, h('tr', {}, ...head.map((c) => h('th', {}, c)))), h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c))))));
}

const SPECIALS: SpecialKind[] = ['brutal', 'arcana', 'armadilha'];
const SP_LINE: Record<SpecialKind, keyof typeof LINE_INFO> = { brutal: 'guerreiro', arcana: 'mago', armadilha: 'cacador' };

export function showHelp(): void {
  const s = (t: string) => h('div', { class: 'label hsec' }, t);
  modal(
    'Como jogar',
    h(
      'div',
      { class: 'help' },
      h('p', {}, 'O seu bicho ', h('b', {}, 'nasce de um ovo'), ' como um bebê. ', h('b', {}, 'Toque no chão para andar'), ' e ', h('b', {}, 'toque num bicho para batalhar'), '. Você vira o que você come: comer bichos de fogo, água ou planta muda a sua evolução.'),

      s('Níveis'),
      h('div', { class: 'levels' }, ...STAGE_LABEL.map((l, i) => h('div', {}, h('b', {}, `Nível ${i + 1}`), h('br'), h('small', { class: 'muted' }, l)))),
      h('p', { class: 'small muted' }, 'Comer bichos e frutas dá XP. Quem perde uma batalha entrega um nível ao vencedor.'),

      s('Batalha: escolha ao mesmo tempo que o oponente'),
      h('div', { class: 'tri' }, h('div', {}, '⚔️ Ataque', h('br'), h('small', { class: 'muted' }, 'vence Carga')), h('div', {}, '🛡️ Defesa', h('br'), h('small', { class: 'muted' }, 'vence Ataque')), h('div', {}, '⚡ Carga', h('br'), h('small', { class: 'muted' }, 'vence Defesa e dobra o próximo golpe'))),

      s('Tipos'),
      h('p', {}, '🔥 Brasa vence 🌿 Broto, que vence 🌊 Maré, que vence 🔥 Brasa (dano ×1,5). Misture tipos para virar Vapor, Cinza, Mangue ou até a rara Quimera.'),

      s('✨ Essência e 🛒 loja'),
      h(
        'p',
        {},
        `Você começa com ${E.start} de Essência e ganha mais comendo selvagens (+${E.wild}), pegando frutas raras (+${E.fruit}) e vencendo jogadores (+${E.pvpWin}; +${E.crown} se ele tinha a Coroa e +${E.kill} se ele voltou ao ovo). `,
        'Abra a ',
        h('b', {}, 'loja'),
        ' pelo botão no canto (ou a tecla L) para comprar habilidades. A partida continua enquanto ela está aberta, e só dá para comprar fora de batalha.',
      ),

      s('Linhas, títulos e conjuntos'),
      h('p', { class: 'small' }, 'A classe surge das compras. Com 2 habilidades da mesma linha você ganha um título e um bônus; com 4, o título de mestre e um bônus maior.'),
      table(
        ['Linha', '2 habilidades', '4 habilidades'],
        LINES.map((l) => {
          const i = LINE_INFO[l];
          return [h('b', { style: `color:${i.color}` }, `${i.icon} ${i.name}`), h('span', {}, h('b', {}, i.titles[0]), h('br'), i.bonus[0]), h('span', {}, h('b', {}, i.titles[1]), h('br'), i.bonus[1])];
        }),
      ),

      s('Especiais: o 4º botão'),
      h('p', { class: 'small' }, 'Cada linha tem um Especial. Ele vence duas jogadas e perde para uma, e pode ser usado uma vez por batalha (duas com a Tempestade). Só dá para ter um: comprar outro substitui o atual.'),
      table(
        ['Especial', 'Vence', 'Perde para'],
        SPECIALS.map((k) => {
          const i = SPECIAL_INFO[k];
          const beats = i.beats.replace(/^vence /, '');
          return [h('b', { style: `color:${LINE_INFO[SP_LINE[k]].color}` }, `${i.icon} ${i.name}`), `${beats} (×${String(i.mult).replace('.', ',')})`, MOVE_LABEL[i.losesTo as BasicAction]];
        }),
        'sp',
      ),

      s('Morte e renascimento'),
      h(
        'p',
        {},
        'Perder no Nível 1 (ou ser pego pela zona no Nível 1) é morte, mas ninguém sai da partida: você ',
        h('b', {}, 'renasce do ovo'),
        ` longe dos outros, perde ${pct(1 - BALANCE.respawn.essenceKeep)} da Essência e ${pct(1 - BALANCE.respawn.pointsKeep)} dos pontos de tipo e zera o XP. As habilidades e os troféus ficam com você.`,
      ),

      s('💪 Força e Duelo Final'),
      h('p', {}, 'A Força soma o nível, os troféus, as habilidades compradas, a Essência e o HP. Ela ordena o placar. No fim do tempo, os ', h('b', {}, '2 mais fortes'), ' vão ao Duelo Final e os outros assistem. Quem vencer leva a partida; o resto do ranking sai pela Força.'),

      s('Mais regras'),
      h(
        'ul',
        {},
        h('li', {}, h('b', {}, '👑 Coroa: '), 'o líder fica marcado no mapa e vale mais para quem o derrubar.'),
        h('li', {}, h('b', {}, 'Fome: '), `quem perde ganha ${BALANCE.hungerShieldMs / 1000} s de proteção e XP em dobro.`),
        h('li', {}, h('b', {}, 'Troféus: '), `vitórias na forma final dão +${pct(BALANCE.trophyBonus)} de dano cada.`),
        h('li', {}, h('b', {}, 'Fase Final: '), `os selvagens somem e cada derrota custa ${BALANCE.finalLossStages} níveis.`),
      ),

      s('Modos'),
      h(
        'ul',
        { class: 'modes' },
        ...GAME_MODES.map((id) => {
          const m = MODES[id];
          const p = m.phases;
          return h(
            'li',
            {},
            h('b', {}, `${m.icon} ${m.name} (${m.minutes} min): `),
            `Coleta até ${fmtTime(p.coletaEnd)}, Caçada até ${fmtTime(p.cacadaEnd)}, Final até ${fmtTime(p.finalEnd)} e então o Duelo Final. ${m.slots} vagas de habilidade${m.mastery ? ', com maestrias' : ', sem maestrias'}.`,
          );
        }),
      ),
    ),
  );
}
