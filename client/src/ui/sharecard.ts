import { FORM_LABEL, SKILLS, speciesName, type HistoryItem, type Look, type SkillId } from '@vb/shared';
import { drawCreature } from '../render/creature';
import { FORM_COLOR } from '../render/palette';
import { fmtTime } from './dom';

export interface ShareCardOpts {
  name: string;
  look: Look;
  place: number;
  total: number;
  history: HistoryItem[];
  wins: number;
  steals: number;
  deaths: number;
  power: number;
  skills: SkillId[];
  /** Título da build (ícone da linha e nome) na cor da linha. */
  title: { icon: string; text: string; color: string } | null;
}

const EMOJI = '"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';

/** Cartão para compartilhar: o bicho final, a build e a linha do tempo da partida. */
export function buildShareCard(opts: ShareCardOpts): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 720;
  c.height = 400;
  draw(c, opts);
  // As fontes da página (Nunito, Press Start 2P) podem ainda estar carregando: redesenha quando chegarem
  if (document.fonts && document.fonts.status !== 'loaded') void document.fonts.ready.then(() => draw(c, opts));
  return c;
}

function draw(c: HTMLCanvasElement, opts: ShareCardOpts): void {
  const W = c.width;
  const H = c.height;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  const color = FORM_COLOR[opts.look.form];
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1b1433');
  g.addColorStop(1, '#2d1f52');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.18;
  ctx.beginPath();
  ctx.arc(170, 184, 150, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.drawImage(drawCreature(opts.look), 42, 48, 256, 256);

  // Habilidades compradas, embaixo do bicho
  if (opts.skills.length) {
    const size = opts.skills.length > 6 ? 26 : 32;
    const gap = size + 8;
    const x0 = 170 - ((opts.skills.length - 1) * gap) / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${size}px ${EMOJI}`;
    opts.skills.forEach((id, i) => ctx.fillText(SKILLS[id].icon, x0 + i * gap, 344));
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  ctx.fillStyle = '#ffcf3f';
  ctx.font = '22px "Press Start 2P", monospace';
  ctx.fillText('BATLLE-BICHO', 330, 56);
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 34px Nunito, sans-serif';
  ctx.fillText(speciesName(opts.look.form, opts.look.stage), 330, 104);
  ctx.fillStyle = '#b9aee0';
  ctx.font = '800 20px Nunito, sans-serif';
  ctx.fillText(`${FORM_LABEL[opts.look.form]} · de ${opts.name}`, 330, 132);
  if (opts.title) {
    // Emoji e texto em chamadas separadas: a fonte de emoji tem dígitos e espaços largos
    ctx.fillStyle = opts.title.color;
    ctx.font = `20px ${EMOJI}`;
    ctx.fillText(opts.title.icon, 330, 162);
    ctx.font = '900 22px Nunito, sans-serif';
    ctx.fillText(opts.title.text, 362, 162);
  }
  ctx.fillStyle = opts.place === 1 ? '#58e07a' : '#ffffff';
  ctx.font = '28px "Press Start 2P", monospace';
  ctx.fillText(opts.place === 1 ? 'VENCEU!' : `#${opts.place} de ${opts.total}`, 330, 206);
  ctx.fillStyle = '#b9aee0';
  ctx.font = '800 18px Nunito, sans-serif';
  ctx.fillText(`${opts.wins} vitórias · ${opts.steals} roubos · Força ${opts.power} · ${opts.deaths} ${opts.deaths === 1 ? 'morte' : 'mortes'}`, 330, 238);

  // Linha do tempo das formas (sem repetir a mesma aparência seguida).
  const steps: HistoryItem[] = [];
  for (const it of opts.history) {
    const prev = steps.at(-1);
    if (!prev || prev.look.form !== it.look.form || prev.look.stage !== it.look.stage) steps.push(it);
  }
  const shown = steps.slice(-6);
  shown.forEach((it, i) => {
    const x = 330 + i * 62;
    ctx.drawImage(drawCreature(it.look), x, 262, 56, 56);
    ctx.fillStyle = '#8c80b8';
    ctx.font = '800 13px Nunito, sans-serif';
    ctx.fillText(fmtTime(it.el), x + 12, 336);
  });
  ctx.fillStyle = '#6f6499';
  ctx.font = '800 15px Nunito, sans-serif';
  ctx.fillText(location.host, 330, 380);
}
