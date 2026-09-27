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
