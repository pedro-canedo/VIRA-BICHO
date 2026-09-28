import { attackElem, type Elem, type Form, type Stage } from '@vb/shared';
import { ELEM_TONE, FORM_COLOR, hexNum, type Tone } from './palette';

/** Cores reservadas dos efeitos (números, para tint). */
export const FXC = {
  gold: 0xffcf3f,
  gold2: 0xffe066,
  ghost: 0xffe28a,
  magenta: 0xff5fd2,
  pink: 0xffafe8,
  zoneDark: 0x2a0840,
  red: 0xff4f6d,
  blue: 0x7cc4ff,
  blueL: 0xc4e6ff,
  green: 0x58e07a,
  lilac: 0xb98cff,
  lilac2: 0xaa9fcc,
  white: 0xffffff,
  ink: 0x140f24,
  cream: 0xfffaf0,
  dust: 0xe9e1cc,
  stone: 0x9d9580,
  slate: 0x6d6a80,
  sun: 0xffd23f,
  vapor: 0xb9a7ff,
  ash: 0xa8845c,
  mud: 0x3fb3a0,
  ember: 0xffd27a,
  petal: 0xff8fc8,
  blossom: 0xffd6f0,
  grass: 0x9be36b,
  lava: 0xff8c42,
  soot: 0x3b3947,
  duelShade: 0xd08a9a,
  night: 0x0b0716,
} as const;

/** Prisma da Quimera: troca de cor a cada 40 ms. */
export const PRISM: readonly number[] = [0xff7a3d, 0xffcf3f, 0x52c95f, 0x4aa3ff, 0xff5fd2];
export const prismAt = (ms: number): number => PRISM[Math.floor(ms / 40) % PRISM.length];

const ramp = (t: Tone): readonly number[] => [hexNum(t.light), hexNum(t.body), hexNum(t.dark)];

export const ELEM_RAMP: Record<Elem, readonly number[]> = {
  brasa: ramp(ELEM_TONE.brasa),
  mare: ramp(ELEM_TONE.mare),
  broto: ramp(ELEM_TONE.broto),
};

/** RAMP[forma] = [light, body, dark]; a Quimera usa as 5 cores do prisma. */
export const RAMP: Record<Form, readonly number[]> = {
  ...ELEM_RAMP,
  vapor: [0xffffff, 0xb9a7ff, 0xc4e6ff],
  cinza: [0xff7a3d, 0xa8845c, 0x6d6a80],
  mangue: [0xd2f7b8, 0x3fb3a0, 0x17803a],
  quimera: PRISM,
  neutro: [0xfffaf0, 0xe9e1cc, 0x9d9580],
};

export const FORM_TINT = Object.fromEntries(Object.entries(FORM_COLOR).map(([k, v]) => [k, hexNum(v)])) as Record<Form, number>;

/** Escola de magia do golpe: o elemento de ataque, a Quimera ou o neutro (inclusive o bebê neutro). */
export type School = Elem | 'quimera' | 'neutro';

export function schoolOf(f: Form, s: Stage, o: Elem[]): School {
  if (f === 'neutro') return 'neutro';
  if (f === 'quimera') return 'quimera';
  return attackElem({ form: f, stage: s, order: o }) ?? 'neutro';
}

/** Cor "body" do elemento dominante (ou neutra). */
export function bodyTint(f: Form, o: Elem[]): number {
  const e = o[0];
  if (f === 'neutro' || !e) return RAMP.neutro[1];
  return f === 'quimera' ? FXC.magenta : ELEM_RAMP[e][1];
}

export function lightTint(f: Form, o: Elem[]): number {
  const e = o[0];
  if (f === 'neutro' || !e) return RAMP.neutro[0];
  return f === 'quimera' ? 0xffcf3f : ELEM_RAMP[e][0];
}

export function darkTint(f: Form, o: Elem[]): number {
  const e = o[0];
  if (f === 'neutro' || !e) return RAMP.neutro[2];
  return f === 'quimera' ? 0x6d2a8f : ELEM_RAMP[e][2];
}

/** Frame do ícone do elemento no atlas 'fx'. */
export const ELEM_FRAME: Record<Elem, string> = { brasa: 'flame', mare: 'drop', broto: 'leaf' };
