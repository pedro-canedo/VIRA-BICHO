import { describe, expect, it } from 'vitest';
import {
  BALANCE,
  MODES,
  SKILLS,
  SKILL_IDS,
  beatsAction,
  canBuy,
  lookOf,
  modsOf,
  moveOf,
  powerOf,
  resolveTurn,
  specialOf,
  titleOf,
  withSkill,
  type Combatant,
  type Look,
  type SkillId,
  type Stage,
} from '@vb/shared';

const neutral = (stage: Stage = 1): Look => lookOf({ brasa: 0, mare: 0, broto: 0 }, stage);
const fighter = (skills: SkillId[] = [], extra: Partial<Combatant> = {}): Combatant => {
  const mods = modsOf(skills);
  const sp = specialOf(skills);
  return { look: neutral(), baseDmg: BALANCE.dmg[1], trophies: 0, charged: false, mods, special: sp, specialLeft: sp ? mods.specialUses : 0, maxHp: 100, ...extra };
};

describe('catálogo', () => {
  it('cada linha tem 3 passivas, 1 Especial e 1 maestria', () => {
    for (const line of ['guerreiro', 'mago', 'cacador'] as const) {
      const defs = SKILL_IDS.map((id) => SKILLS[id]).filter((d) => d.line === line);
      expect(defs).toHaveLength(5);
      expect(defs.filter((d) => d.special)).toHaveLength(1);
      expect(defs.filter((d) => d.tier === 3)).toHaveLength(1);
    }
  });
});

describe('Especiais no triângulo', () => {
  it('cada Especial vence duas ações básicas e perde para uma', () => {
    expect(beatsAction('brutal', 'ataque') && beatsAction('brutal', 'carga') && beatsAction('defesa', 'brutal')).toBe(true);
    expect(beatsAction('arcana', 'defesa') && beatsAction('arcana', 'carga') && beatsAction('ataque', 'arcana')).toBe(true);
    expect(beatsAction('armadilha', 'ataque') && beatsAction('armadilha', 'defesa') && beatsAction('carga', 'armadilha')).toBe(true);
    expect(beatsAction('brutal', 'arcana') || beatsAction('arcana', 'brutal')).toBe(false);
  });

  it('sem Especial, escolher "especial" vira Defesa', () => {
    expect(moveOf(fighter([]), 'especial')).toBe('defesa');
    expect(moveOf(fighter(['g_brutal']), 'especial')).toBe('brutal');
    expect(moveOf(fighter(['g_brutal'], { specialLeft: 0 }), 'especial')).toBe('defesa');
  });

  it('Golpe Brutal vencendo causa ×1,6 e gasta o uso', () => {
    const r = resolveTurn(fighter(['g_brutal']), fighter(), 'especial', 'ataque');
    expect(r.winner).toBe('a');
    expect(r.moveA).toBe('brutal');
    expect(r.dmgToB).toBe(Math.round(BALANCE.dmg[1] * 1.6));
    expect(r.specialLeftA).toBe(0);
  });

  it('Especial que perde também é gasto; Tempestade dá 2 usos', () => {
    const r = resolveTurn(fighter(['m_arcana']), fighter(), 'especial', 'ataque');
    expect(r.winner).toBe('b');
    expect(r.specialLeftA).toBe(0);
    expect(fighter(['m_arcana', 'm_tempestade']).specialLeft).toBe(2);
  });

  it('Especiais contra Especiais se chocam', () => {
    const r = resolveTurn(fighter(['g_brutal']), fighter(['c_armadilha']), 'especial', 'especial');
    expect(r.winner).toBe('tie');
    expect(r.dmgToA).toBeGreaterThan(0);
    expect(r.dmgToB).toBeGreaterThan(0);
  });
});

describe('passivas', () => {
  it('Golpe Pesado, Contra-ataque e Canalizar mudam o dano de quem vence', () => {
    const d = BALANCE.dmg[1];
    expect(resolveTurn(fighter(['g_pesado']), fighter(), 'ataque', 'carga').dmgToB).toBe(Math.round(d * 1.3));
    expect(resolveTurn(fighter(['g_contra']), fighter(), 'defesa', 'ataque').dmgToB).toBe(d);
    expect(resolveTurn(fighter(['m_canal']), fighter(), 'carga', 'defesa').dmgToB).toBe(d);
  });

  it('Esquiva zera o primeiro turno perdido; depois não protege mais', () => {
    const def = fighter(['c_esquiva']);
    const r1 = resolveTurn(fighter(), def, 'ataque', 'carga');
    expect(r1.dmgToB).toBe(0);
    expect(r1.dodgedB).toBe(true);
    const r2 = resolveTurn(fighter(), { ...def, dodgeUsed: r1.dodgeUsedB }, 'ataque', 'carga');
    expect(r2.dmgToB).toBeGreaterThan(0);
  });

  it('Escudo Arcano corta pela metade o primeiro golpe recebido', () => {
    const r = resolveTurn(fighter(), fighter(['m_escudo']), 'ataque', 'carga');
    expect(r.dmgToB).toBe(Math.ceil(BALANCE.dmg[1] / 2));
    expect(r.shieldUsedB).toBe(true);
  });

  it('Sede de Batalha cura quem vence o turno', () => {
    const r = resolveTurn(fighter(['g_sede']), fighter(), 'ataque', 'carga');
    expect(r.healA).toBe(10);
  });

  it('Foco Elemental amplia a vantagem de tipo', () => {
    const brasa = lookOf({ brasa: 3, mare: 0, broto: 0 }, 1);
    const broto = lookOf({ brasa: 0, mare: 0, broto: 3 }, 1);
    const plain = resolveTurn(fighter([], { look: brasa }), fighter([], { look: broto }), 'ataque', 'carga').dmgToB;
    const focus = resolveTurn(fighter(['m_foco'], { look: brasa }), fighter([], { look: broto }), 'ataque', 'carga').dmgToB;
    expect(focus).toBeGreaterThan(plain);
    expect(focus).toBe(Math.round(BALANCE.dmg[1] * 1.75));
  });
});

describe('conjuntos, títulos e compras', () => {
  it('2 e 4 habilidades da linha dão título e bônus', () => {
    expect(titleOf(['g_couro'])).toBeNull();
    expect(titleOf(['g_couro', 'g_pesado'])?.name).toBe('Aprendiz de Guerreiro');
    expect(titleOf(['m_foco', 'm_canal', 'm_escudo', 'm_arcana'])?.name).toBe('Arquimago');
    expect(modsOf(['m_foco', 'm_canal', 'm_escudo', 'm_arcana']).startCharged).toBe(true);
    expect(modsOf(['c_passos', 'c_faro']).speedMult).toBeCloseTo(1.4);
  });

  it('respeita Essência, vagas por modo e maestria', () => {
    expect(canBuy([], 2, 'g_couro', 'rapido')).toBe('essence');
    expect(canBuy([], 3, 'g_couro', 'rapido')).toBeNull();
    expect(canBuy(['g_couro'], 99, 'g_couro', 'rapido')).toBe('owned');
    expect(canBuy([], 99, 'g_sede', 'rapido')).toBe('mastery');
    expect(canBuy([], 99, 'g_sede', 'classico')).toBeNull();
    const four: SkillId[] = ['g_couro', 'g_pesado', 'm_foco', 'c_passos'];
    expect(four.length).toBe(MODES.rapido.slots);
    expect(canBuy(four, 99, 'c_faro', 'rapido')).toBe('slots');
  });

  it('comprar outro Especial troca o anterior sem ocupar vaga', () => {
    const full: SkillId[] = ['g_couro', 'g_pesado', 'g_brutal', 'm_foco'];
    expect(canBuy(full, 99, 'm_arcana', 'rapido')).toBeNull();
    const next = withSkill(full, 'm_arcana');
    expect(next).toHaveLength(4);
    expect(specialOf(next)).toBe('arcana');
  });

  it('Força cresce com estágio, troféus, build e Essência', () => {
    const base = { stage: 1 as Stage, trophies: 0, skills: [] as SkillId[], essence: 0, hpPct: 1 };
    expect(powerOf({ ...base, stage: 2 })).toBeGreaterThan(powerOf(base));
    expect(powerOf({ ...base, skills: ['g_couro'] })).toBeGreaterThan(powerOf(base));
    expect(powerOf({ ...base, trophies: 1 })).toBeGreaterThan(powerOf(base));
  });
});
