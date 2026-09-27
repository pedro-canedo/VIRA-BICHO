import { DIRS, isWalkable, type GameMap } from './mapgen';
import type { Vec } from './types';

/** Heap binário mínimo por prioridade. */
class MinHeap {
  private items: number[] = [];
  private prio: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, p: number): void {
    this.items.push(item);
    this.prio.push(p);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastPrio = this.prio.pop()!;
    if (this.items.length) {
      this.items[0] = lastItem;
      this.prio[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.prio[l] < this.prio[m]) m = l;
        if (r < this.items.length && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
  }
}

/**
 * A* em 4 direções. Retorna os passos a partir do vizinho do início até o destino
 * (vazio se já estiver no destino) ou null se não houver caminho.
 */
export function findPath(m: GameMap, from: Vec, to: Vec, maxNodes = 6000): Vec[] | null {
  if (!isWalkable(m, to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [];
  const w = m.w;
  const start = from.y * w + from.x;
  const goal = to.y * w + to.x;
  const g = new Map<number, number>([[start, 0]]);
  const came = new Map<number, number>();
  const open = new MinHeap();
  const h = (i: number) => Math.abs((i % w) - to.x) + Math.abs(Math.floor(i / w) - to.y);
  open.push(start, h(start));
  let expanded = 0;
  while (open.size) {
    const cur = open.pop();
    if (cur === goal) {
      const path: Vec[] = [];
      let c = cur;
      while (c !== start) {
        path.push({ x: c % w, y: Math.floor(c / w) });
        c = came.get(c)!;
      }
      return path.reverse();
    }
    if (++expanded > maxNodes) return null;
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    const cg = g.get(cur)!;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(m, nx, ny)) continue;
      const ni = ny * w + nx;
      const ng = cg + 1;
      if (ng < (g.get(ni) ?? Infinity)) {
        g.set(ni, ng);
        came.set(ni, cur);
        open.push(ni, ng + h(ni));
      }
    }
  }
  return null;
}

export const chebyshev = (a: Vec, b: Vec): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
