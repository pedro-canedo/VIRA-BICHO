import { BALANCE } from './balance';
import { MODES, type GameMode } from './modes';
import type { Stage } from './types';

/**
 * Builds: a "classe" surge das compras. Cada linha tem passivas, um Especial e uma maestria;
 * ter 2 ou 4 habilidades da mesma linha dá um título e um bônus de conjunto.
 */
export type Line = 'guerreiro' | 'mago' | 'cacador';
export const LINES: readonly Line[] = ['guerreiro', 'mago', 'cacador'];

export type SpecialKind = 'brutal' | 'arcana' | 'armadilha';

export type SkillId =
  | 'g_couro'
  | 'g_pesado'
  | 'g_contra'
  | 'g_brutal'
  | 'g_sede'
  | 'm_foco'
  | 'm_canal'
  | 'm_escudo'
  | 'm_arcana'
  | 'm_tempestade'
  | 'c_passos'
  | 'c_faro'
  | 'c_esquiva'
  | 'c_armadilha'
  | 'c_rastro';

export interface SkillDef {
  id: SkillId;
  line: Line;
  /** 1 e 2: sempre; 3: maestria (só nos modos com mastery). */
  tier: 1 | 2 | 3;
  cost: number;
  name: string;
  icon: string;
  desc: string;
  special?: SpecialKind;
}

export interface LineInfo {
  name: string;
  icon: string;
  color: string;
  /** Títulos com 2 e com 4 habilidades da linha. */
  titles: [string, string];
  bonus: [string, string];
}

export const LINE_INFO: Record<Line, LineInfo> = {
  guerreiro: {
    name: 'Guerreiro',
    icon: '🗡️',
    color: '#ff6b5e',
    titles: ['Aprendiz de Guerreiro', 'Campeão'],
    bonus: ['+5% de dano', '+10% de HP e +10% de dano'],
  },
  mago: {
    name: 'Mago',
    icon: '🔮',
    color: '#b98cff',
    titles: ['Aprendiz de Mago', 'Arquimago'],
    bonus: ['Carregado dá ×2,25 (em vez de ×2)', 'Começa toda batalha Carregado'],
  },
  cacador: {
    name: 'Caçador',
    icon: '🏹',
    color: '#58e07a',
    titles: ['Rastreador', 'Predador'],
    bonus: ['Anda 15% mais rápido', 'Vencer um jogador rouba 3 de Essência dele'],
  },
};

const COST = { 1: 3, 2: 6, 3: 10 } as const;

export const SKILLS: Record<SkillId, SkillDef> = {
  g_couro: { id: 'g_couro', line: 'guerreiro', tier: 1, cost: COST[1], name: 'Couro Grosso', icon: '🛡️', desc: '+15% de HP máximo.' },
  g_pesado: { id: 'g_pesado', line: 'guerreiro', tier: 1, cost: COST[1], name: 'Golpe Pesado', icon: '🔨', desc: 'Ataque vencedor causa +30% de dano.' },
  g_contra: { id: 'g_contra', line: 'guerreiro', tier: 2, cost: COST[2], name: 'Contra-ataque', icon: '↩️', desc: 'Defesa vencedora devolve 100% do dano (em vez de 50%).' },
  g_brutal: {
    id: 'g_brutal',
    line: 'guerreiro',
    tier: 2,
    cost: COST[2],
    name: 'Golpe Brutal',
    icon: '💥',
    desc: 'Especial: vence Ataque e Carga com dano ×1,6. Perde para Defesa.',
    special: 'brutal',
  },
  g_sede: { id: 'g_sede', line: 'guerreiro', tier: 3, cost: COST[3], name: 'Sede de Batalha', icon: '🩸', desc: 'Cada turno vencido cura 10% do HP máximo.' },
  m_foco: { id: 'm_foco', line: 'mago', tier: 1, cost: COST[1], name: 'Foco Elemental', icon: '🌀', desc: 'Vantagem de tipo vira ×1,75 (em vez de ×1,5).' },
  m_canal: { id: 'm_canal', line: 'mago', tier: 1, cost: COST[1], name: 'Canalizar', icon: '⚡', desc: 'Carga vencedora causa 100% do dano (em vez de 50%).' },
  m_escudo: { id: 'm_escudo', line: 'mago', tier: 2, cost: COST[2], name: 'Escudo Arcano', icon: '🔷', desc: 'O primeiro golpe recebido em cada batalha causa só metade.' },
  m_arcana: {
    id: 'm_arcana',
    line: 'mago',
    tier: 2,
    cost: COST[2],
    name: 'Explosão Arcana',
    icon: '🔮',
    desc: 'Especial: vence Defesa e Carga com dano ×1,4 (e a vantagem de tipo). Perde para Ataque.',
    special: 'arcana',
  },
  m_tempestade: { id: 'm_tempestade', line: 'mago', tier: 3, cost: COST[3], name: 'Tempestade', icon: '🌩️', desc: 'O Especial pode ser usado 2 vezes por batalha.' },
  c_passos: { id: 'c_passos', line: 'cacador', tier: 1, cost: COST[1], name: 'Passos Leves', icon: '👣', desc: 'Anda 25% mais rápido pelo mapa.' },
  c_faro: { id: 'c_faro', line: 'cacador', tier: 1, cost: COST[1], name: 'Faro', icon: '👃', desc: 'Comer bichos dá +1 de Essência e cura 50% a mais. Frutas raras sempre no minimapa.' },
  c_esquiva: { id: 'c_esquiva', line: 'cacador', tier: 2, cost: COST[2], name: 'Esquiva', icon: '💨', desc: 'O primeiro turno perdido em cada batalha não causa dano.' },
  c_armadilha: {
    id: 'c_armadilha',
    line: 'cacador',
    tier: 2,
    cost: COST[2],
    name: 'Armadilha',
    icon: '🪤',
    desc: 'Especial: vence Ataque e Defesa com dano ×1,3. Perde para Carga.',
    special: 'armadilha',
  },
  c_rastro: { id: 'c_rastro', line: 'cacador', tier: 3, cost: COST[3], name: 'Rastro', icon: '🐾', desc: 'Cada bicho comido dá +1 de XP.' },
};

export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];

export const SPECIAL_INFO: Record<SpecialKind, { name: string; icon: string; beats: string; losesTo: string; mult: number }> = {
  brutal: { name: 'Golpe Brutal', icon: '💥', beats: 'vence Ataque e Carga', losesTo: 'defesa', mult: 1.6 },
  arcana: { name: 'Explosão Arcana', icon: '🔮', beats: 'vence Defesa e Carga', losesTo: 'ataque', mult: 1.4 },
  armadilha: { name: 'Armadilha', icon: '🪤', beats: 'vence Ataque e Defesa', losesTo: 'carga', mult: 1.3 },
};

export function isSkillId(v: unknown): v is SkillId {
  return typeof v === 'string' && Object.hasOwn(SKILLS, v);
}

/** Efeitos numéricos de um conjunto de habilidades (passivas + bônus de conjunto). */
export interface SkillMods {
  hpMult: number;
  dmgMult: number;
  attackWinMult: number;
  counterMult: number;
  chargeWinMult: number;
  typeStrong: number;
  chargedMult: number;
  startCharged: boolean;
  arcaneShield: boolean;
  dodge: boolean;
  healOnWin: number;
  specialUses: number;
  speedMult: number;
  wildEssence: number;
  wildHealMult: number;
  wildXp: number;
  seeFruits: boolean;
  stealEssence: number;
}

export const NEUTRAL_MODS: SkillMods = Object.freeze({
  hpMult: 1,
  dmgMult: 1,
  attackWinMult: 1,
  counterMult: 1,
  chargeWinMult: 1,
  typeStrong: BALANCE.typeStrong,
  chargedMult: BALANCE.battle.chargedMult,
  startCharged: false,
  arcaneShield: false,
  dodge: false,
  healOnWin: 0,
  specialUses: 1,
  speedMult: 1,
  wildEssence: 0,
  wildHealMult: 1,
  wildXp: 0,
  seeFruits: false,
  stealEssence: 0,
}) as SkillMods;

export function lineCounts(skills: readonly SkillId[]): Record<Line, number> {
  const c: Record<Line, number> = { guerreiro: 0, mago: 0, cacador: 0 };
  for (const s of skills) c[SKILLS[s].line]++;
  return c;
}

export function modsOf(skills: readonly SkillId[]): SkillMods {
  const m: SkillMods = { ...NEUTRAL_MODS };
  const has = (id: SkillId) => skills.includes(id);
  if (has('g_couro')) m.hpMult += 0.15;
  if (has('g_pesado')) m.attackWinMult = 1.3;
  if (has('g_contra')) m.counterMult = 2;
  if (has('g_sede')) m.healOnWin = 0.1;
  if (has('m_foco')) m.typeStrong = 1.75;
  if (has('m_canal')) m.chargeWinMult = 2;
  if (has('m_escudo')) m.arcaneShield = true;
  if (has('m_tempestade')) m.specialUses = 2;
  if (has('c_passos')) m.speedMult += 0.25;
  if (has('c_faro')) {
    m.wildEssence += 1;
    m.wildHealMult = 1.5;
    m.seeFruits = true;
  }
  if (has('c_esquiva')) m.dodge = true;
  if (has('c_rastro')) m.wildXp += 1;

  const c = lineCounts(skills);
  if (c.guerreiro >= 2) m.dmgMult += 0.05;
  if (c.guerreiro >= 4) {
    m.dmgMult += 0.1;
    m.hpMult += 0.1;
  }
  if (c.mago >= 2) m.chargedMult = 2.25;
  if (c.mago >= 4) m.startCharged = true;
  if (c.cacador >= 2) m.speedMult += 0.15;
  if (c.cacador >= 4) m.stealEssence = 3;
  return m;
}

/** O Especial equipado (só pode haver um: comprar outro substitui). */
export function specialOf(skills: readonly SkillId[]): SpecialKind | null {
  for (let i = skills.length - 1; i >= 0; i--) {
    const sp = SKILLS[skills[i]].special;
    if (sp) return sp;
  }
  return null;
}

export interface Title {
  line: Line;
  /** 1 = aprendiz (2 habilidades), 2 = mestre (4 habilidades). */
  level: 1 | 2;
  name: string;
}

/** Título principal: a linha com mais habilidades (mínimo 2); empate fica com a linha comprada primeiro. */
export function titleOf(skills: readonly SkillId[]): Title | null {
  const c = lineCounts(skills);
  let best: Line | null = null;
  for (const s of skills) {
    const l = SKILLS[s].line;
    if (c[l] >= 2 && (best === null || c[l] > c[best])) best = l;
  }
  if (!best) return null;
  const level = c[best] >= 4 ? 2 : 1;
  return { line: best, level, name: LINE_INFO[best].titles[level - 1] };
}

export type BuyError = 'owned' | 'essence' | 'slots' | 'mastery' | 'unknown';

/** Diz se dá para comprar; um Especial novo substitui o antigo (não ocupa vaga extra). */
export function canBuy(skills: readonly SkillId[], essence: number, id: SkillId, mode: GameMode): BuyError | null {
  const def = SKILLS[id];
  if (!def) return 'unknown';
  if (skills.includes(id)) return 'owned';
  if (def.tier === 3 && !MODES[mode].mastery) return 'mastery';
  if (essence < def.cost) return 'essence';
  const replacesSpecial = def.special !== undefined && specialOf(skills) !== null;
  if (!replacesSpecial && skills.length >= MODES[mode].slots) return 'slots';
  return null;
}

/** Lista resultante de uma compra (troca o Especial se for o caso). */
export function withSkill(skills: readonly SkillId[], id: SkillId): SkillId[] {
  const out = SKILLS[id].special ? skills.filter((s) => !SKILLS[s].special) : [...skills];
  out.push(id);
  return out;
}

/**
 * Força: decide quem vai ao Duelo Final e ordena o ranking.
 * Estágio pesa mais; troféus, build e Essência desempatam de verdade.
 */
export function powerOf(p: { stage: Stage; trophies: number; skills: readonly SkillId[]; essence: number; hpPct: number }): number {
  const skillValue = p.skills.reduce((s, id) => s + SKILLS[id].cost, 0);
  return Math.round(p.stage * 100 + p.trophies * 30 + skillValue * 3 + p.essence + Math.max(0, Math.min(1, p.hpPct)) * 10);
}
