import { describe, expect, it } from 'vitest';
import { BALANCE } from '@vb/shared';
import { eggCrackAt, eggTiltAt } from '../client/src/render/fxrules';

const H = BALANCE.respawn.hatchMs;

describe('eclosão do ovo', () => {
  it('racha em 3 estágios crescentes antes de o servidor liberar o bebê', () => {
    let last = 0;
    for (let t = 0; t <= H; t += 10) {
      const c = eggCrackAt(t, H);
      expect(c).toBeGreaterThanOrEqual(last);
      last = c;
    }
    expect(eggCrackAt(0, H)).toBe(0);
    expect(eggCrackAt(H * 0.8, H)).toBe(3);
    // Atraso de rede: continua todo rachado até o hx cair.
    expect(eggCrackAt(H * 2, H)).toBe(3);
  });

  it('cada rachadura vem logo depois de um balanço', () => {
    for (let t = 10; t <= H; t += 10) {
      if (eggCrackAt(t, H) === eggCrackAt(t - 10, H)) continue;
      let wobbled = false;
      for (let u = t - 400; u < t; u += 5) if (u >= 0 && eggTiltAt(u, H) !== 0) wobbled = true;
      expect(wobbled).toBe(true);
    }
  });

  it('fica parado no começo e balança sem parar no fim', () => {
    for (let t = 0; t < H * 0.15; t += 10) expect(eggTiltAt(t, H)).toBe(0);
    const tail = new Set<number>();
    for (let t = H * 0.86; t < H * 1.2; t += 10) tail.add(eggTiltAt(t, H));
    expect([...tail].sort()).toEqual([-1, 0, 1]);
  });
});
