import Phaser from 'phaser';

/**
 * Atlas branco 'fx' (128×32) para tingir na hora, as animações de anel
 * e as fontes de dano pixeladas. Tudo gerado em canvas uma única vez.
 */

// Legenda: x branco | g cinza claro | h cinza
type Sprite = string[];

const SPRITES: Record<string, Sprite> = {
  p1: ['x'],
  p2: ['xx', 'xx'],
  p21: ['xx'],
  plus: ['.x.', 'xxx', '.x.'],
  diamond: ['.x.', 'x.x', '.x.'],
  star: ['..x..', '..x..', 'xxxxx', '..x..', '..x..'],
  flame: ['.x.', '.xx', 'xxx', 'xgx', '.g.'],
  drop: ['.x.', 'xxx', 'xxg', '.g.'],
  bubble: ['.ggg.', 'gx..g', 'g...g', 'g...g', '.ggg.'],
  leaf: ['.xxx', 'xxg.', 'g...'],
  spore: ['h.h', '.x.', 'h.h'],
  ash: ['xg'],
  shard: ['x.', 'xg', '.g'],
  rune0: ['x.x.x', 'x.x.x', 'xxxxx', '..x..', '..x..'],
  rune1: ['.xxx.', 'x...x', 'x.x.x', 'x...x', '.xxx.'],
  rune2: ['xxxxx', '....x', 'xxx.x', 'x...x', 'xxxxx'],
  rune3: ['xxxxx', '.x.x.', '..x..', '.x.x.', 'xxxxx'],
  crown: ['x..x..x', 'x.xxx.x', 'xxxxxxx', 'xxxxxxx', '.xxxxx.'],
  bang: ['.x.', 'xxx', 'xxx', '.x.', '.x.', '...', '.x.'],
  chevron: ['x.x', '.x.'],
  hex: ['..xxx..', '.g...g.', 'g.....g', 'x.....x', 'g.....g', '.g...g.', '..xxx..'],
  p12: ['x', 'x'],
};

// Posições no atlas (x, y). Os anéis ocupam a faixa da esquerda.
const AT: Record<string, [number, number]> = {
  orb: [44, 12],
  hex: [52, 12],
  bang: [60, 12],
  rune0: [26, 18],
  rune1: [32, 18],
  rune2: [38, 18],
  rune3: [64, 0],
  star: [70, 0],
  bubble: [76, 0],
  crown: [82, 0],
  flame: [90, 0],
  drop: [94, 0],
  leaf: [98, 0],
  spore: [103, 0],
  plus: [107, 0],
  diamond: [111, 0],
  shard: [115, 0],
  p1: [118, 0],
  p2: [120, 0],
  p21: [123, 0],
  ash: [123, 3],
  chevron: [118, 3],
  p12: [70, 8],
};

const RINGS: [string, number, number][] = [
  ['ring12', 0, 12],
  ['ring8', 26, 8],
  ['ring5', 44, 5],
  ['ring3', 56, 3],
];

const COLORS: Record<string, string> = { x: '#ffffff', g: '#bbbbbb', h: '#888888' };

function paint(ctx: CanvasRenderingContext2D, s: Sprite, ox: number, oy: number): void {
  for (let y = 0; y < s.length; y++) {
    for (let x = 0; x < s[y].length; x++) {
      const ch = s[y][x];
      if (ch === '.') continue;
      ctx.fillStyle = COLORS[ch];
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  }
}

const inDisc = (x: number, y: number, c: number, r: number) => {
  const dx = (x + 0.5 - c) / r;
  const dy = (y + 0.5 - c) / r;
  return dx * dx + dy * dy <= 1;
};

/** Anel de 1 px com a mesma lógica de disc() do bicho. */
function ring(ctx: CanvasRenderingContext2D, ox: number, oy: number, r: number): number {
  const size = r * 2 + 1;
  const c = size / 2;
  ctx.fillStyle = '#ffffff';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inDisc(x, y, c, r + 0.5) && !inDisc(x, y, c, r - 0.5)) ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  }
  return size;
}

// ---------- Fontes de dano (RetroFont 6×8) ----------

export const DMG_CHARS = '0123456789-+x!.';
const GLYPHS: Sprite[] = [
  ['.xx.', 'x..x', 'x..x', 'x..x', 'x..x', '.xx.'],
  ['.x..', 'xx..', '.x..', '.x..', '.x..', 'xxx.'],
  ['.xx.', 'x..x', '...x', '..x.', '.x..', 'xxxx'],
  ['xxx.', '...x', '.xx.', '...x', '...x', 'xxx.'],
  ['x..x', 'x..x', 'xxxx', '...x', '...x', '...x'],
  ['xxxx', 'x...', 'xxx.', '...x', '...x', 'xxx.'],
  ['.xx.', 'x...', 'xxx.', 'x..x', 'x..x', '.xx.'],
  ['xxxx', '...x', '..x.', '.x..', '.x..', '.x..'],
  ['.xx.', 'x..x', '.xx.', 'x..x', 'x..x', '.xx.'],
  ['.xx.', 'x..x', 'x..x', '.xxx', '...x', '.xx.'],
  ['....', '....', 'xxxx', '....', '....', '....'],
  ['....', '.x..', 'xxx.', '.x..', '....', '....'],
  ['....', 'x..x', '.xx.', '.xx.', 'x..x', '....'],
  ['.x..', '.x..', '.x..', '.x..', '....', '.x..'],
  ['....', '....', '....', '....', '....', '.x..'],
];

/** Variantes da fonte de dano: dmg-<id>. */
export const DMG_FONTS: Record<string, string> = {
  w: '#ffffff',
  y: '#ffcf3f',
  c: '#ffe066',
  r: '#ff4f6d',
  l: '#aa9fcc',
  g: '#58e07a',
  m: '#ff5fd2',
  brasa: '#ff7a3d',
  mare: '#4aa3ff',
  broto: '#52c95f',
};

function fontCanvas(color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = DMG_CHARS.length * 6;
  c.height = 8;
  const ctx = c.getContext('2d')!;
  GLYPHS.forEach((g, i) => {
    const ox = i * 6 + 1;
    // Contorno de 1 px (8 vizinhos) e depois a cor.
    ctx.fillStyle = '#140f24';
    for (let y = 0; y < g.length; y++)
      for (let x = 0; x < 4; x++) if (g[y][x] === 'x') ctx.fillRect(ox + x - 1, 1 + y - 1, 3, 3);
    ctx.fillStyle = color;
    for (let y = 0; y < g.length; y++) for (let x = 0; x < 4; x++) if (g[y][x] === 'x') ctx.fillRect(ox + x, 1 + y, 1, 1);
  });
  return c;
}

/** Registra a textura 'fx', os frames, as animações e as fontes de dano (uma vez por jogo). */
export function buildFxAtlas(scene: Phaser.Scene): void {
  if (scene.textures.exists('fx')) return;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const ctx = c.getContext('2d')!;
  const frames: [string, number, number, number, number][] = [];
  for (const [name, x, r] of RINGS) {
    const size = ring(ctx, x, 0, r);
    frames.push([name, x, 0, size, size]);
  }
  // Orbe: disco com borda #bbb e núcleo branco.
  const [ox, oy] = AT.orb;
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      if (!inDisc(x, y, 3.5, 3.5)) continue;
      ctx.fillStyle = inDisc(x, y, 3.5, 2.5) ? '#ffffff' : '#bbbbbb';
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  }
  frames.push(['orb', ox, oy, 7, 7]);
  // 'bango': o '!' com contorno de 1 px #140f24 já pintado (o tint só pinta o miolo claro).
  const [bx, by] = [64, 8];
  const bang = SPRITES.bang;
  ctx.fillStyle = '#140f24';
  for (let y = 0; y < bang.length; y++) for (let x = 0; x < 3; x++) if (bang[y][x] === 'x') ctx.fillRect(bx + x, by + y, 3, 3);
  paint(ctx, bang, bx + 1, by + 1);
  frames.push(['bango', bx, by, 5, 9]);
  for (const [name, s] of Object.entries(SPRITES)) {
    const [x, y] = AT[name];
    paint(ctx, s, x, y);
    frames.push([name, x, y, s[0].length, s.length]);
  }
  const tex = scene.textures.addCanvas('fx', c)!;
  for (const [name, x, y, w, h] of frames) tex.add(name, 0, x, y, w, h);

  const f = (names: string[]) => names.map((frame) => ({ key: 'fx', frame }));
  scene.anims.create({ key: 'ringGrow', frames: f(['ring3', 'ring5', 'ring8', 'ring12']), duration: 280 });
  scene.anims.create({ key: 'ringShrink', frames: f(['ring12', 'ring8', 'ring5', 'ring3']), duration: 280 });
  scene.anims.create({ key: 'shrink', frames: f(['star', 'plus', 'p1']), frameRate: 12 });

  for (const [id, color] of Object.entries(DMG_FONTS)) {
    const key = `dmgtex-${id}`;
    scene.textures.addCanvas(key, fontCanvas(color));
    // Parse já devolve a entrada completa do cache ({ data, texture, frame }).
    const entry = Phaser.GameObjects.RetroFont.Parse(scene, {
      image: key,
      'offset.x': 0,
      'offset.y': 0,
      width: 6,
      height: 8,
      chars: DMG_CHARS,
      charsPerRow: DMG_CHARS.length,
      'spacing.x': 0,
      'spacing.y': 0,
      lineSpacing: 0,
    });
    scene.cache.bitmapFont.add(`dmg-${id}`, entry);
  }
}
