import type { Elem, Form } from '@vb/shared';

export interface Tone {
  body: string;
  dark: string;
  light: string;
}

export const ELEM_TONE: Record<Elem, Tone> = {
  brasa: { body: '#ff7a3d', dark: '#b8400f', light: '#ffd27a' },
  mare: { body: '#4aa3ff', dark: '#1b4fc4', light: '#c4e6ff' },
  broto: { body: '#52c95f', dark: '#17803a', light: '#d2f7b8' },
};

export const NEUTRAL_TONE: Tone = { body: '#e9e1cc', dark: '#9d9580', light: '#fffaf0' };

export const FORM_COLOR: Record<Form, string> = {
  neutro: '#e9e1cc',
  brasa: '#ff7a3d',
  mare: '#4aa3ff',
  broto: '#52c95f',
  vapor: '#b9a7ff',
  cinza: '#a8845c',
  mangue: '#3fb3a0',
  quimera: '#ff5fd2',
};

export const BIOME_COLORS: Record<Elem, { base: string; alt: string; accent: string }> = {
  brasa: { base: '#4a2419', alt: '#4f271b', accent: '#ff8c42' },
  mare: { base: '#173a5c', alt: '#193e62', accent: '#7cc4ff' },
  broto: { base: '#1c4526', alt: '#1e4a29', accent: '#9be36b' },
};

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

export const hexNum = (hex: string): number => parseInt(hex.slice(1), 16);
