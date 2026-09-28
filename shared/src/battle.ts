import { BALANCE } from './balance';
import { typeMult } from './evolution';
import { NEUTRAL_MODS, SPECIAL_INFO, type SkillMods, type SpecialKind } from './skills';
import type { Action, BasicAction, Look } from './types';

export interface Combatant {
  look: Look;
  baseDmg: number;
  trophies: number;
  charged: boolean;
  /** Build do lutador (selvagens usam o neutro). */
  mods?: SkillMods;
  special?: SpecialKind | null;
  specialLeft?: number;
  /** Estado das passivas de uma vez por batalha. */
  shieldUsed?: boolean;
  dodgeUsed?: boolean;
  maxHp?: number;
}

/** O que cada um fez de fato no turno (o 'especial' vira o Especial da build). */
export type Move = BasicAction | SpecialKind;

export interface TurnResult {
  winner: 'a' | 'b' | 'tie';
  dmgToA: number;
  dmgToB: number;
  /** Estado de "Carregado" depois do turno. */
  chargedA: boolean;
  chargedB: boolean;
  text: string;
  moveA: Move;
  moveB: Move;
  healA: number;
  healB: number;
  /** Esquivou / o escudo absorveu metade, neste turno. */
  dodgedA: boolean;
  dodgedB: boolean;
  shieldedA: boolean;
  shieldedB: boolean;
  specialLeftA: number;
  specialLeftB: number;
  shieldUsedA: boolean;
  shieldUsedB: boolean;
  dodgeUsedA: boolean;
  dodgeUsedB: boolean;
}

const ACTION_LABEL: Record<Action, string> = { ataque: 'Ataque', defesa: 'Defesa', carga: 'Carga', especial: 'Especial' };

export const MOVE_LABEL: Record<Move, string> = {
  ataque: 'Ataque',
  defesa: 'Defesa',
  carga: 'Carga',
  brutal: SPECIAL_INFO.brutal.name,
  arcana: SPECIAL_INFO.arcana.name,
  armadilha: SPECIAL_INFO.armadilha.name,
};

const SPECIAL_BEATS: Record<SpecialKind, readonly BasicAction[]> = {
  brutal: ['ataque', 'carga'],
  arcana: ['defesa', 'carga'],
  armadilha: ['ataque', 'defesa'],
};

const isSpecial = (m: Move): m is SpecialKind => m === 'brutal' || m === 'arcana' || m === 'armadilha';

/** Ataque vence Carga, Defesa vence Ataque, Carga vence Defesa. Cada Especial vence duas e perde para uma. */
export function beatsAction(x: Move, y: Move): boolean {
  if (isSpecial(x)) return !isSpecial(y) && SPECIAL_BEATS[x].includes(y);
  if (isSpecial(y)) return !SPECIAL_BEATS[y].includes(x);
  return (x === 'ataque' && y === 'carga') || (x === 'defesa' && y === 'ataque') || (x === 'carga' && y === 'defesa');
}

/** Converte a escolha em jogada: sem Especial disponível, 'especial' vira Defesa. */
export function moveOf(c: Combatant, act: Action): Move {
  if (act !== 'especial') return act;
  return c.special && (c.specialLeft ?? 0) > 0 ? c.special : 'defesa';
}

const modsOfC = (c: Combatant): SkillMods => c.mods ?? NEUTRAL_MODS;

/** Multiplicador de tipo, com o Foco Elemental ampliando a vantagem. */
function typeMultFor(att: Combatant, def: Combatant): number {
  const tm = typeMult(att.look, def.look);
  const strong = modsOfC(att).typeStrong;
  return tm > 1 ? tm * (strong / BALANCE.typeStrong) : tm;
}

export function damage(att: Combatant, def: Combatant, mult: number): number {
  const m = modsOfC(att);
  const trophy = 1 + BALANCE.trophyBonus * att.trophies;
  const charge = att.charged ? m.chargedMult : 1;
  return Math.max(1, Math.round(att.baseDmg * mult * typeMultFor(att, def) * trophy * charge * m.dmgMult));
}

/** Multiplicador de quem venceu o turno com a jogada `move`. */
function winMult(c: Combatant, move: Move): number {
  const B = BALANCE.battle;
  const m = modsOfC(c);
  if (move === 'ataque') return B.attackHit * m.attackWinMult;
  if (move === 'defesa') return B.defenseCounter * m.counterMult;
  if (move === 'carga') return B.chargeHit * m.chargeWinMult;
  return SPECIAL_INFO[move].mult;
}

/** Resolve um turno com as duas ações reveladas ao mesmo tempo. Função pura. */
export function resolveTurn(a: Combatant, b: Combatant, actA: Action, actB: Action): TurnResult {
  const B = BALANCE.battle;
  const moveA = moveOf(a, actA);
  const moveB = moveOf(b, actB);
  let rawToA = 0;
  let rawToB = 0;
  let newChargeA = false;
  let newChargeB = false;
  let winner: TurnResult['winner'] = 'tie';
  let text: string;

  if (moveA === moveB || (isSpecial(moveA) && isSpecial(moveB))) {
    if (isSpecial(moveA)) {
      rawToB = damage(a, b, B.tieAttack * SPECIAL_INFO[moveA].mult);
      rawToA = damage(b, a, B.tieAttack * SPECIAL_INFO[moveB as SpecialKind].mult);
      text = 'Os Especiais se chocaram!';
    } else if (moveA === 'ataque') {
      rawToB = damage(a, b, B.tieAttack);
      rawToA = damage(b, a, B.tieAttack);
      text = 'Ataques se chocaram!';
    } else if (moveA === 'defesa') {
      text = 'Os dois se defenderam.';
    } else {
      newChargeA = newChargeB = true;
      text = 'Os dois carregaram energia!';
    }
  } else {
    const aWins = beatsAction(moveA, moveB);
    winner = aWins ? 'a' : 'b';
    const [w, l] = aWins ? [a, b] : [b, a];
    const wMove = aWins ? moveA : moveB;
    const lMove = aWins ? moveB : moveA;
    const dealt = damage(w, l, winMult(w, wMove));
    if (aWins) rawToB = dealt;
    else rawToA = dealt;
    if (wMove === 'carga') {
      if (aWins) newChargeA = true;
      else newChargeB = true;
    }
    text = `${MOVE_LABEL[wMove]} venceu ${MOVE_LABEL[lMove]}!`;
  }

  // Passivas de defesa de uma vez por batalha: Esquiva (só no turno perdido) e Escudo Arcano.
  const defend = (c: Combatant, raw: number, lost: boolean) => {
    const m = modsOfC(c);
    let dmg = raw;
    let dodged = false;
    let shielded = false;
    let dodgeUsed = !!c.dodgeUsed;
    let shieldUsed = !!c.shieldUsed;
    if (dmg > 0 && lost && m.dodge && !dodgeUsed) {
      dmg = 0;
      dodged = dodgeUsed = true;
    }
    if (dmg > 0 && m.arcaneShield && !shieldUsed) {
      dmg = Math.ceil(dmg / 2);
      shielded = shieldUsed = true;
    }
    return { dmg, dodged, shielded, dodgeUsed, shieldUsed };
  };
  const da = defend(a, rawToA, winner === 'b');
  const db = defend(b, rawToB, winner === 'a');

  // Sede de Batalha: quem vence o turno se cura.
  const heal = (c: Combatant, won: boolean) => (won && modsOfC(c).healOnWin > 0 && c.maxHp ? Math.round(modsOfC(c).healOnWin * c.maxHp) : 0);
  const healA = heal(a, winner === 'a');
  const healB = heal(b, winner === 'b');

  if (da.dodged) text += ' Esquivou!';
  if (db.dodged) text += ' Esquivou!';
  if (da.shielded || db.shielded) text += ' O escudo arcano absorveu metade.';

  // Quem tentou causar dano gasta a carga; quem não tentou continua carregado.
  const chargedA = newChargeA || (a.charged && rawToB === 0);
  const chargedB = newChargeB || (b.charged && rawToA === 0);
  return {
    winner,
    dmgToA: da.dmg,
    dmgToB: db.dmg,
    chargedA,
    chargedB,
    text,
    moveA,
    moveB,
    healA,
    healB,
    dodgedA: da.dodged,
    dodgedB: db.dodged,
    shieldedA: da.shielded,
    shieldedB: db.shielded,
    specialLeftA: (a.specialLeft ?? 0) - (isSpecial(moveA) ? 1 : 0),
    specialLeftB: (b.specialLeft ?? 0) - (isSpecial(moveB) ? 1 : 0),
    shieldUsedA: da.shieldUsed,
    shieldUsedB: db.shieldUsed,
    dodgeUsedA: da.dodgeUsed,
    dodgeUsedB: db.dodgeUsed,
  };
}

export { ACTION_LABEL, isSpecial };
