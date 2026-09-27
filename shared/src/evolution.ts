import { BALANCE } from './balance';
import { ELEMS, MAX_STAGE, type Elem, type Form, type Hybrid, type Look, type Stage, type TypePoints } from './types';

const HYBRIDS: Record<string, Hybrid> = {
  'brasa+mare': 'vapor',
  'brasa+broto': 'cinza',
  'broto+mare': 'mangue',
};

export function hybridOf(a: Elem, b: Elem): Hybrid {
  const key = [a, b].sort().join('+');
  return HYBRIDS[key];
}

/** Elementos com pontos, do mais comido para o menos (empate segue a ordem de ELEMS). */
export function elemOrder(points: TypePoints): Elem[] {
  return ELEMS.filter((e) => points[e] > 0).sort((a, b) => points[b] - points[a] || ELEMS.indexOf(a) - ELEMS.indexOf(b));
}

/** "Você vira o que você come": decide a forma a partir dos pontos de tipo. */
export function formOf(points: TypePoints): Form {
  const order = elemOrder(points);
  if (order.length === 0) return 'neutro';
  const [a, b, c] = order.map((e) => points[e]);
  if (order.length === 3 && c >= BALANCE.quimeraMinPoints && c >= BALANCE.quimeraRatio * a) return 'quimera';
  if (order.length >= 2 && b >= BALANCE.hybridRatio * a) return hybridOf(order[0], order[1]);
  return order[0];
}

export function lookOf(points: TypePoints, stage: Stage): Look {
  return { form: formOf(points), stage, order: elemOrder(points) };
}

/** Elementos que definem a defesa de uma forma. */
export function defenseElems(look: Look): Elem[] {
  switch (look.form) {
    case 'neutro':
    case 'quimera':
      return [];
    case 'brasa':
    case 'mare':
    case 'broto':
      return [look.form];
    default:
      return look.order.slice(0, 2);
  }
}

/** Elemento usado no ataque (o dominante). Neutro e Quimera atacam sem tipo. */
export function attackElem(look: Look): Elem | null {
  if (look.form === 'neutro' || look.form === 'quimera') return null;
  return look.order[0] ?? null;
}

/** Brasa > Broto > Maré > Brasa. */
export function beatsElem(a: Elem, b: Elem): boolean {
  return (a === 'brasa' && b === 'broto') || (a === 'broto' && b === 'mare') || (a === 'mare' && b === 'brasa');
}

export function elemMult(atk: Elem, def: Elem): number {
  if (beatsElem(atk, def)) return BALANCE.typeStrong;
  if (beatsElem(def, atk)) return BALANCE.typeWeak;
  return 1;
}

/** Multiplicador de tipo do atacante contra o defensor (híbridos defendem com a média dos dois tipos). */
export function typeMult(attacker: Look, defender: Look): number {
  const atk = attackElem(attacker);
  const defs = defenseElems(defender);
  if (!atk || defs.length === 0) return 1;
  return defs.reduce((sum, d) => sum + elemMult(atk, d), 0) / defs.length;
}

export function maxHp(stage: Stage): number {
  return BALANCE.hp[stage];
}

/** Aplica XP e sobe de estágio quantas vezes for preciso. Retorna quantos estágios subiu. */
export function applyXp(state: { stage: Stage; xp: number }, amount: number): number {
  let gained = 0;
  state.xp += amount;
  while (state.stage < MAX_STAGE && state.xp >= BALANCE.xpToEvolve[state.stage]) {
    state.xp -= BALANCE.xpToEvolve[state.stage];
    state.stage = (state.stage + 1) as Stage;
    gained++;
  }
  if (state.stage === MAX_STAGE) state.xp = 0;
  return gained;
}

const NAMES: Record<Form, [string, string, string, string]> = {
  neutro: ['Ovo', 'Bolinha', 'Bolão', 'Bolota Suprema'],
  brasa: ['Ovo morno', 'Fagulhinho', 'Chamurro', 'Infernaldo'],
  mare: ['Ovo úmido', 'Gotinha', 'Marolo', 'Tsunamor'],
  broto: ['Ovo verde', 'Brotinho', 'Folhudo', 'Florestão'],
  vapor: ['Ovo quente', 'Fumacinha', 'Nevoão', 'Vaporzilla'],
  cinza: ['Ovo tostado', 'Tiçãozinho', 'Carvolho', 'Cinzarrão'],
  mangue: ['Ovo lodoso', 'Lodinho', 'Manguelo', 'Pantanoso'],
  quimera: ['Ovo esquisito', 'Coisinha', 'Treco', 'Quimerão'],
};

export const FORM_LABEL: Record<Form, string> = {
  neutro: 'Neutro',
  brasa: 'Brasa',
  mare: 'Maré',
  broto: 'Broto',
  vapor: 'Vapor',
  cinza: 'Cinza',
  mangue: 'Mangue',
  quimera: 'Quimera',
};

export const STAGE_LABEL = ['Ovo', 'Filhote', 'Adulto', 'Forma final'] as const;

export function speciesName(form: Form, stage: Stage): string {
  return NAMES[form][stage];
}
