import { FORM_LABEL, speciesName, type HistoryItem, type Look } from '@vb/shared';
import { drawCreature } from '../render/creature';
import { FORM_COLOR } from '../render/palette';
import { fmtTime } from './dom';

/** Cartão para compartilhar: o bicho final e a linha do tempo da partida. */
export function buildShareCard(opts: { name: string; look: Look; place: number; total: number; history: HistoryItem[]; wins: number; steals: number }): HTMLCanvasElement {
  const W = 720;
  const H = 400;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
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
  ctx.arc(170, 200, 150, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.drawImage(drawCreature(opts.look), 42, 72, 256, 256);

  ctx.fillStyle = '#ffcf3f';
  ctx.font = '22px "Press Start 2P", monospace';
  ctx.fillText('VIRA-BICHO', 330, 60);
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 34px Nunito, sans-serif';
  ctx.fillText(speciesName(opts.look.form, opts.look.stage), 330, 112);
  ctx.fillStyle = '#b9aee0';
  ctx.font = '800 20px Nunito, sans-serif';
  ctx.fillText(`${FORM_LABEL[opts.look.form]} · de ${opts.name}`, 330, 142);
  ctx.fillStyle = opts.place === 1 ? '#58e07a' : '#ffffff';
  ctx.font = '28px "Press Start 2P", monospace';
  ctx.fillText(opts.place === 1 ? 'VENCEU!' : `#${opts.place} de ${opts.total}`, 330, 196);
  ctx.fillStyle = '#b9aee0';
  ctx.font = '800 18px Nunito, sans-serif';
  ctx.fillText(`${opts.wins} vitórias · ${opts.steals} evoluções roubadas`, 330, 228);

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
  ctx.fillText('virabicho.caixazen.online', 330, 380);
  return c;
}
