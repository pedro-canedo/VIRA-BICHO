/** Regras puras dos efeitos do mundo (sem Phaser), cobertas por tests/fx-world.test.ts. */

/**
 * Dono da Coroa pelo placar. O lb vem inteiro em todo snapshot, então o dono não
 * "some" quando sai do raio de visão (s.ents só traz quem está perto).
 */
export function crownOwnerOf(lb: readonly { id: number; cr?: 1 }[]): number {
  for (const r of lb) if (r.cr) return r.id;
  return -1;
}

/**
 * Sobe a base de uma caixa (centro x, meia-largura hw, altura h) até ela não encostar,
 * com folga m, em nenhuma das n caixas de boxes ([esq, topo, dir, base] em sequência).
 * Devolve a nova base (só sobe, nunca desce).
 */
export function clearBottom(x: number, hw: number, bottom: number, h: number, boxes: ArrayLike<number>, n: number, m = 2): number {
  for (let guard = 0; guard < 16; guard++) {
    let hit = false;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const l = boxes[o];
      const t = boxes[o + 1];
      const r = boxes[o + 2];
      const b = boxes[o + 3];
      if (l - m < x + hw && r + m > x - hw && t - m < bottom && b + m > bottom - h) {
        bottom = t - m;
        hit = true;
      }
    }
    if (!hit) break;
  }
  return bottom;
}

// Balanço do ovo: [início, fim] em fração do tempo chocando e o passo (ms) de cada inclinação.
const WOBBLE: readonly [number, number, number][] = [
  [0.18, 0.26, 70],
  [0.42, 0.52, 65],
  [0.64, 0.76, 55],
  [0.84, Infinity, 45],
];
const TILT: readonly (-1 | 0 | 1)[] = [-1, 0, 1, 0];

/** Estágio da rachadura (0-3) pelo tempo chocando: cada rachadura vem logo depois de um balanço. */
export function eggCrackAt(el: number, hatchMs: number): number {
  const k = el / hatchMs;
  return k < 0.28 ? 0 : k < 0.53 ? 1 : k < 0.77 ? 2 : 3;
}

/** Inclinação do ovo (-1, 0, 1) pelo tempo chocando: surtos cada vez mais rápidos, contínuo no fim. */
export function eggTiltAt(el: number, hatchMs: number): -1 | 0 | 1 {
  const k = el / hatchMs;
  for (const [a, b, step] of WOBBLE) if (k >= a && k < b) return TILT[Math.floor(((k - a) * hatchMs) / step) % 4];
  return 0;
}
