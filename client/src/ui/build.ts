import { LINE_INFO, SKILLS, SPECIAL_INFO, specialOf, titleOf, type Line, type SkillId, type SpecialKind } from '@vb/shared';
import { h } from './dom';

// Peças visuais da build (título, ícones das habilidades, Especial), usadas no HUD, na loja, na batalha e no fim.

/** Linha dona de cada Especial (dá a cor e o ícone da linha). */
export const SPECIAL_LINE: Record<SpecialKind, Line> = { brutal: 'guerreiro', arcana: 'mago', armadilha: 'cacador' };

export const specialColor = (sp: SpecialKind): string => LINE_INFO[SPECIAL_LINE[sp]].color;

/** Rótulo curto do nível da habilidade na loja. */
export const TIER_LABEL: Record<1 | 2 | 3, string> = { 1: 'Nv 1', 2: 'Nv 2', 3: 'Maestria' };

/** Título da build ("🗡️ Campeão") na cor da linha; null sem título. */
export function titleBadge(skills: readonly SkillId[], cls = 'tbadge'): HTMLElement | null {
  const t = titleOf(skills);
  if (!t) return null;
  const line = LINE_INFO[t.line];
  return h('span', { class: `${cls}${t.level === 2 ? ' master' : ''}`, style: `--lc:${line.color}`, title: `${line.name}: ${line.bonus[t.level - 1]}` }, `${line.icon} ${t.name}`);
}

/** Texto do título ("🗡️ Campeão") ou vazio. */
export function titleText(skills: readonly SkillId[]): string {
  const t = titleOf(skills);
  return t ? `${LINE_INFO[t.line].icon} ${t.name}` : '';
}

/** Fileira de ícones das habilidades (o Especial fica destacado). */
export function skillIcons(skills: readonly SkillId[], cls = 'sicons'): HTMLElement {
  const sp = specialOf(skills);
  return h(
    'span',
    { class: cls },
    ...skills.map((id) => {
      const d = SKILLS[id];
      const isSp = !!d.special && d.special === sp;
      return h('i', { class: isSp ? 'sp' : '', style: `--lc:${LINE_INFO[d.line].color}`, title: `${d.name}: ${d.desc}` }, d.icon);
    }),
  );
}

/** "💥 Golpe Brutal · vence Ataque e Carga". */
export function specialLine(sp: SpecialKind): string {
  const i = SPECIAL_INFO[sp];
  return `${i.icon} ${i.name} · ${i.beats}`;
}
