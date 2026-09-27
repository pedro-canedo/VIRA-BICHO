import { describe, expect, it } from 'vitest';
import { clearBottom, crownOwnerOf } from '../client/src/render/fxrules';

describe('Coroa', () => {
  it('o dono vem do placar, mesmo fora da vista', () => {
    expect(crownOwnerOf([{ id: 3 }, { id: 7, cr: 1 }])).toBe(7);
    expect(crownOwnerOf([{ id: 3 }])).toBe(-1);
  });
});

describe('números de dano', () => {
  // Nome em [x-10, y-24, x+10, y-13] e barra de HP em [x-9, y+7, x+9, y+13]
  const boxes = [-10, -24, 10, -13, 21, 23, 39, 29];

  it('nasce acima do nome do alvo', () => {
    const b = clearBottom(0, 12, -20, 16, boxes, 2);
    expect(b).toBe(-26);
    expect(b - 16).toBeLessThan(-24);
  });

  it('não desce quando nada encosta', () => {
    expect(clearBottom(0, 6, -40, 8, boxes, 2)).toBe(-40);
    expect(clearBottom(100, 6, -20, 16, boxes, 2)).toBe(-20);
  });

  it('empilha pela altura real e não fica sobre a barra de um vizinho', () => {
    // Número anterior ocupando [−18, −42, 18, −26]
    const bx = [...boxes, -18, -42, 18, -26];
    const b = clearBottom(0, 12, -20, 16, bx, 3);
    expect(b).toBe(-44);
    // Vizinho acima: a base sobe até ficar 2 px acima da barra dele.
    expect(clearBottom(30, 6, 30, 8, boxes, 2)).toBe(21);
  });
});
