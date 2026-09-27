import { FORMS, FORM_LABEL, STAGE_LABEL, speciesName, type Form, type Look, type Stage } from '@vb/shared';
import { creatureImg } from '../render/creature';
import { h, modal } from './dom';

const KEY = 'vb.bestiario';

function load(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

const seen = load();

/** Registra uma forma vista. Retorna true se for nova. */
export function recordLook(look: Look): boolean {
  const key = `${look.form}:${look.stage}`;
  if (look.stage === 0 || seen.has(key)) return false;
  seen.add(key);
  try {
    localStorage.setItem(KEY, JSON.stringify([...seen]));
  } catch {
    // armazenamento indisponível: segue sem salvar
  }
  return true;
}

const sampleOrder: Record<Form, Look['order']> = {
  neutro: [],
  brasa: ['brasa'],
  mare: ['mare'],
  broto: ['broto'],
  vapor: ['brasa', 'mare'],
  cinza: ['brasa', 'broto'],
  mangue: ['mare', 'broto'],
  quimera: ['brasa', 'mare', 'broto'],
};

export function showBestiary(): void {
  const total = FORMS.length * 3;
  const found = [...seen].length;
  const grid = h(
    'div',
    { class: 'bestiary', style: 'grid-template-columns:auto repeat(3, 1fr)' },
    h('div'),
    ...[1, 2, 3].map((s) => h('div', { class: 'small muted', style: 'text-align:center' }, STAGE_LABEL[s])),
  );
  for (const form of FORMS) {
    grid.append(h('div', { class: 'fl' }, FORM_LABEL[form]));
    for (const s of [1, 2, 3] as Stage[]) {
      const has = seen.has(`${form}:${s}`);
      const look: Look = { form, stage: s, order: sampleOrder[form] };
      const cell = h('div', { style: 'text-align:center', title: has ? speciesName(form, s) : '???' }, creatureImg(look, 3, { silhouette: !has }), h('div', { class: 'small' }, has ? speciesName(form, s) : '???'));
      grid.append(cell);
    }
  }
  modal(`Bestiário ${found}/${total}`, h('div', {}, h('p', { class: 'muted small' }, 'Cada forma que você alcança fica registrada aqui. Misture tipos para descobrir os híbridos e a rara Quimera.'), grid));
}
