import { describe, expect, it } from 'vitest';
import { decodeTiles, encodeTiles, findPath, floodFill, generateMap, isWalkable, ROCK } from '@vb/shared';

describe('gerador de mapa', () => {
  it('é determinístico pela semente', () => {
    const a = generateMap(1234, 16);
    const b = generateMap(1234, 16);
    const c = generateMap(999, 16);
    expect(encodeTiles(a.tiles)).toBe(encodeTiles(b.tiles));
    expect(encodeTiles(a.tiles)).not.toBe(encodeTiles(c.tiles));
  });

  it('tamanho depende do número de jogadores', () => {
    expect(generateMap(1, 8).w).toBe(48);
    expect(generateMap(1, 16).w).toBe(64);
  });

  it('todo tile caminhável é alcançável e tem os três biomas', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const m = generateMap(seed * 7919, seed % 2 ? 8 : 16);
      const start = m.spawns[0];
      const reach = floodFill(m, start.x, start.y);
      let walkable = 0;
      const biomes = new Set<number>();
      for (let i = 0; i < m.tiles.length; i++) {
        if (m.tiles[i] === ROCK) continue;
        walkable++;
        biomes.add(m.tiles[i]);
        expect(reach[i]).toBe(1);
      }
      expect(walkable / m.tiles.length).toBeGreaterThan(0.8);
      expect(biomes.size).toBe(3);
      for (const p of [...m.spawns, ...m.fruits]) expect(isWalkable(m, p.x, p.y)).toBe(true);
    }
  });

  it('codifica e decodifica os tiles', () => {
    const m = generateMap(42, 8);
    expect(decodeTiles(encodeTiles(m.tiles))).toEqual(m.tiles);
  });
});

describe('A*', () => {
  it('encontra caminho válido entre nascimentos opostos', () => {
    const m = generateMap(77, 16);
    const a = m.spawns[0];
    const b = m.spawns[8];
    const path = findPath(m, a, b)!;
    expect(path).not.toBeNull();
    expect(path.at(-1)).toEqual(b);
    let prev = a;
    for (const p of path) {
      expect(Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y)).toBe(1);
      expect(isWalkable(m, p.x, p.y)).toBe(true);
      prev = p;
    }
  });

  it('retorna null para destino bloqueado', () => {
    const m = generateMap(77, 16);
    const rock = m.tiles.indexOf(ROCK);
    expect(findPath(m, m.spawns[0], { x: rock % m.w, y: Math.floor(rock / m.w) })).toBeNull();
  });
});
