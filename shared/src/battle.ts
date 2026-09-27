import { BALANCE } from './balance';
import { typeMult } from './evolution';
import type { Action, Look } from './types';

export interface Combatant {
  look: Look;
  baseDmg: number;
  trophies: number;
  charged: boolean;
}

export interface TurnResult {
  winner: 'a' | 'b' | 'tie';
  dmgToA: number;
  dmgToB: number;
  /** Estado de "Carregado" depois do turno. */
  chargedA: boolean;
  chargedB: boolean;
  text: string;
}

const ACTION_LABEL: Record<Action, string> = { ataque: 'Ataque', defesa: 'Defesa', carga: 'Carga' };

/** Ataque vence Carga, Defesa vence Ataque, Carga vence Defesa. */
export function beatsAction(x: Action, y: Action): boolean {
  return (x === 'ataque' && y === 'carga') || (x === 'defesa' && y === 'ataque') || (x === 'carga' && y === 'defesa');
}

export function damage(att: Combatant, def: Combatant, mult: number): number {
  const trophy = 1 + BALANCE.trophyBonus * Math.min(att.trophies, BALANCE.trophyMax);
  const charge = att.charged ? BALANCE.battle.chargedMult : 1;
  return Math.max(1, Math.round(att.baseDmg * mult * typeMult(att.look, def.look) * trophy * charge));
}

/** Resolve um turno com as duas ações reveladas ao mesmo tempo. Função pura. */
export function resolveTurn(a: Combatant, b: Combatant, actA: Action, actB: Action): TurnResult {
  const B = BALANCE.battle;
  let dmgToA = 0;
  let dmgToB = 0;
  let newChargeA = false;
  let newChargeB = false;
  let winner: TurnResult['winner'] = 'tie';
  let text: string;

  if (actA === actB) {
    if (actA === 'ataque') {
      dmgToB = damage(a, b, B.tieAttack);
      dmgToA = damage(b, a, B.tieAttack);
      text = 'Ataques se chocaram!';
    } else if (actA === 'defesa') {
      text = 'Os dois se defenderam.';
    } else {
      newChargeA = newChargeB = true;
      text = 'Os dois carregaram energia!';
    }
  } else {
    const aWins = beatsAction(actA, actB);
    winner = aWins ? 'a' : 'b';
    const [w, l] = aWins ? [a, b] : [b, a];
    const wAct = aWins ? actA : actB;
    const lAct = aWins ? actB : actA;
    const mult = wAct === 'ataque' ? B.attackHit : wAct === 'defesa' ? B.defenseCounter : B.chargeHit;
    const dealt = damage(w, l, mult);
    if (aWins) dmgToB = dealt;
    else dmgToA = dealt;
    if (wAct === 'carga') {
      if (aWins) newChargeA = true;
      else newChargeB = true;
    }
    text = `${ACTION_LABEL[wAct]} venceu ${ACTION_LABEL[lAct]}!`;
  }

  // Quem causou dano gasta a carga; quem não causou continua carregado.
  const chargedA = newChargeA || (a.charged && dmgToB === 0);
  const chargedB = newChargeB || (b.charged && dmgToA === 0);
  return { winner, dmgToA, dmgToB, chargedA, chargedB, text };
}

export { ACTION_LABEL };
