import { FORMS, FORM_LABEL, levelOf, STAGE_LABEL, speciesName, type Form, type Look, type Stage } from '@vb/shared';
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
  if (seen.has(key)) return false;
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

const STAGES: Stage[] = [0, 1, 2, 3];

export function showBestiary(): void {
  // 8 formas × 4 níveis (o bebê que sai do ovo é o Nível 1)
  const total = FORMS.length * STAGES.length;
  let found = 0;
  for (const s of STAGES) for (const f of FORMS) if (seen.has(`${f}:${s}`)) found++;
  const grid = h(
    'div',
    { class: 'bestiary' },
    h('div'),
    ...STAGES.map((s) => h('div', { class: 'bhead' }, h('b', {}, `Nv ${levelOf(s)}`), h('span', {}, STAGE_LABEL[s]))),
  );
  for (const form of FORMS) {
    grid.append(h('div', { class: 'fl' }, FORM_LABEL[form]));
    for (const s of STAGES) {
      const has = seen.has(`${form}:${s}`);
      const look: Look = { form, stage: s, order: sampleOrder[form] };
      const cell = h('div', { class: `bcell${has ? '' : ' unk'}`, title: has ? `${speciesName(form, s)} · Nível ${levelOf(s)}` : '???' }, creatureImg(look, 3, { silhouette: !has }), h('div', { class: 'small' }, has ? speciesName(form, s) : '???'));
      grid.append(cell);
    }
  }
  modal(`Bestiário ${found}/${total}`, h('div', {}, h('p', { class: 'muted small' }, 'Cada forma que você alcança fica registrada aqui, do bebê que sai do ovo até a forma final. Misture tipos para descobrir os híbridos e a rara Quimera.'), grid));
}
