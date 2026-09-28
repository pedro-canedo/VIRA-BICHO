import { describe, expect, it } from 'vitest';
import {
  BALANCE,
  applyXp,
  beatsAction,
  formOf,
  lookOf,
  resolveTurn,
  typeMult,
  xpForStage,
  type Combatant,
  type Look,
  type Stage,
  type TypePoints,
} from '@vb/shared';

const pts = (brasa: number, mare: number, broto: number): TypePoints => ({ brasa, mare, broto });
const fighter = (look: Look, extra: Partial<Combatant> = {}): Combatant => ({
  look,
  baseDmg: BALANCE.dmg[look.stage],
  trophies: 0,
  charged: false,
  ...extra,
});
const neutral = (stage: Stage = 1) => lookOf(pts(0, 0, 0), stage);

describe('triângulo de ações', () => {
  it('Ataque vence Carga, Defesa vence Ataque, Carga vence Defesa', () => {
    expect(beatsAction('ataque', 'carga')).toBe(true);
    expect(beatsAction('defesa', 'ataque')).toBe(true);
    expect(beatsAction('carga', 'defesa')).toBe(true);
    expect(beatsAction('carga', 'ataque')).toBe(false);
    expect(beatsAction('ataque', 'defesa')).toBe(false);
    expect(beatsAction('defesa', 'carga')).toBe(false);
  });

  it('Ataque vencendo causa dano cheio', () => {
    const r = resolveTurn(fighter(neutral()), fighter(neutral()), 'ataque', 'carga');
    expect(r.winner).toBe('a');
    expect(r.dmgToB).toBe(BALANCE.dmg[1]);
    expect(r.dmgToA).toBe(0);
  });

  it('Defesa vencendo contra-ataca com metade do dano', () => {
    const r = resolveTurn(fighter(neutral()), fighter(neutral()), 'ataque', 'defesa');
    expect(r.winner).toBe('b');
    expect(r.dmgToA).toBe(Math.round(BALANCE.dmg[1] * BALANCE.battle.defenseCounter));
  });

  it('Carga vencendo causa metade e deixa carregado; o próximo dano sai dobrado', () => {
    const a = fighter(neutral());
    const b = fighter(neutral());
    const r1 = resolveTurn(a, b, 'carga', 'defesa');
    expect(r1.winner).toBe('a');
    expect(r1.dmgToB).toBe(Math.round(BALANCE.dmg[1] * BALANCE.battle.chargeHit));
    expect(r1.chargedA).toBe(true);
    const r2 = resolveTurn({ ...a, charged: r1.chargedA }, b, 'ataque', 'carga');
    expect(r2.dmgToB).toBe(BALANCE.dmg[1] * 2);
    expect(r2.chargedA).toBe(false);
  });

  it('carga não é gasta enquanto não causar dano', () => {
    const r = resolveTurn(fighter(neutral(), { charged: true }), fighter(neutral()), 'defesa', 'defesa');
    expect(r.chargedA).toBe(true);
  });

  it('empates: A×A metade para os dois, D×D nada, C×C ambos carregados', () => {
    const aa = resolveTurn(fighter(neutral()), fighter(neutral()), 'ataque', 'ataque');
    expect(aa.dmgToA).toBe(aa.dmgToB);
    expect(aa.dmgToA).toBe(Math.round(BALANCE.dmg[1] * 0.5));
    const dd = resolveTurn(fighter(neutral()), fighter(neutral()), 'defesa', 'defesa');
    expect(dd.dmgToA + dd.dmgToB).toBe(0);
    const cc = resolveTurn(fighter(neutral()), fighter(neutral()), 'carga', 'carga');
    expect(cc.chargedA && cc.chargedB).toBe(true);
  });

  it('troféus aumentam o dano em 10% cada (o teto depende do modo e é aplicado pelo servidor)', () => {
    const r = resolveTurn(fighter(neutral(3), { trophies: 3 }), fighter(neutral()), 'ataque', 'carga');
    expect(r.dmgToB).toBe(Math.round(BALANCE.dmg[3] * 1.3));
  });
});

describe('tipos e formas', () => {
  it('forma pura, híbrida e quimera', () => {
    expect(formOf(pts(0, 0, 0))).toBe('neutro');
    expect(formOf(pts(5, 1, 0))).toBe('brasa');
    expect(formOf(pts(5, 2, 0))).toBe('vapor');
    expect(formOf(pts(5, 0, 3))).toBe('cinza');
    expect(formOf(pts(0, 4, 4))).toBe('mangue');
    expect(formOf(pts(5, 4, 4))).toBe('quimera');
    expect(formOf(pts(2, 2, 2))).toBe('vapor'); // quimera exige pontos mínimos; empate segue Brasa, Maré, Broto
  });

  it('Brasa > Broto > Maré > Brasa', () => {
    const brasa = lookOf(pts(3, 0, 0), 1);
    const mare = lookOf(pts(0, 3, 0), 1);
    const broto = lookOf(pts(0, 0, 3), 1);
    expect(typeMult(brasa, broto)).toBe(BALANCE.typeStrong);
    expect(typeMult(broto, mare)).toBe(BALANCE.typeStrong);
    expect(typeMult(mare, brasa)).toBe(BALANCE.typeStrong);
    expect(typeMult(broto, brasa)).toBe(BALANCE.typeWeak);
    expect(typeMult(brasa, brasa)).toBe(1);
  });

  it('híbrido defende com a média dos dois tipos; quimera e neutro são neutros', () => {
    const vapor = lookOf(pts(5, 3, 0), 2); // brasa + maré
    const mare = lookOf(pts(0, 5, 0), 2);
    expect(typeMult(mare, vapor)).toBeCloseTo((BALANCE.typeStrong + 1) / 2);
    const quimera = lookOf(pts(5, 4, 4), 2);
    expect(typeMult(quimera, mare)).toBe(1);
    expect(typeMult(mare, quimera)).toBe(1);
  });
});

describe('evolução por XP', () => {
  it('limiares cumulativos 3 / 7 / 12', () => {
    expect(xpForStage(1)).toBe(3);
    expect(xpForStage(2)).toBe(7);
    expect(xpForStage(3)).toBe(12);
  });

  it('sobe vários estágios de uma vez e para na forma final', () => {
    const s = { stage: 0 as Stage, xp: 0 };
    expect(applyXp(s, 7)).toBe(2);
    expect(s).toEqual({ stage: 2, xp: 0 });
    expect(applyXp(s, 50)).toBe(1);
    expect(s.stage).toBe(3);
    expect(s.xp).toBe(0);
  });
});
