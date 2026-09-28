import type { Phase } from '@vb/shared';
import { Anims, later, play, reduced } from './anim';
import { h } from './dom';
import { runeCanvas } from './fxcanvas';

interface PhaseLook {
  title: string;
  color: string;
  /** fundo da faixa, quando não é a própria cor da fase */
  bg?: string;
  sub: string;
}

export const PHASE_LOOK: Partial<Record<Phase, PhaseLook>> = {
  coleta: { title: 'COLETA', color: '#52c95f', sub: 'Coma bichos, junte Essência e evolua' },
  cacada: { title: 'CAÇADA', color: '#ff7a3d', sub: 'PvP liberado · a zona fecha' },
  final: { title: 'FINAL', color: '#ff4f6d', sub: 'Sem selvagens · derrota custa 2 estágios' },
  duelo: { title: 'DUELO FINAL', color: '#ff5fd2', bg: '#2a0840', sub: 'Os 2 mais fortes decidem tudo' },
};

/** Selo mágico e faixa na virada de fase (sobreposição central, sem capturar toques). */
export class PhaseSeal {
  readonly el = h('div', { class: 'phasefx', 'aria-live': 'polite' });
  private fx = new Anims();

  show(ph: Phase): void {
    const look = PHASE_LOOK[ph];
    if (!look) return;
    this.fx.cancel();
    const rm = reduced();
    const vig = h('i', { class: 'pvig', style: `--pc:${look.color}` });
    const rune = runeCanvas(look.color);
    rune.classList.add('prune');
    const letters = [...look.title].map((ch) => h('span', {}, ch === ' ' ? ' ' : ch));
    const band = h(
      'div',
      { class: `pband${look.bg ? ' dark' : ''}`, style: `--pc:${look.bg ?? look.color};--pt:${look.bg ? look.color : '#140f24'}` },
      h('div', { class: 'ptitle' }, ...letters),
      h('div', { class: 'psub' }, look.sub),
    );
    this.el.replaceChildren(vig, rune, band);

    // Vinheta de borda na cor da fase: 2 pulsos
    play(vig, [{ opacity: 0 }, { opacity: 0.35 }, { opacity: 0 }, { opacity: 0.35 }, { opacity: 0 }], { duration: rm ? 1200 : 1000, easing: rm ? 'linear' : 'steps(8)', fill: 'forwards' }, this.fx);

    if (rm) {
      // Faixa estática por 1500 ms, sem giro nem digitação
      play(rune, [{ opacity: 0 }, { opacity: 0.8, offset: 0.1 }, { opacity: 0.8, offset: 0.85 }, { opacity: 0 }], { duration: 1500, fill: 'forwards' }, this.fx);
      play(band, [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }], { duration: 1500, fill: 'forwards' }, this.fx);
    } else {
      // Círculo: escala 0,6→1 e gira 30° em 900 ms com steps(12); some até 1400 ms
      play(rune, [{ scale: '0.6', rotate: '0deg', opacity: 0.9 }, { scale: '1', rotate: '30deg', opacity: 0.9 }], { duration: 900, easing: 'steps(12)', fill: 'forwards' }, this.fx);
      play(rune, [{ opacity: 0.9 }, { opacity: 0 }], { delay: 900, duration: 500, easing: 'steps(5)', fill: 'forwards', composite: 'replace' }, this.fx);
      play(band, [{ transform: 'translateX(-110vw) skewY(-4deg)' }, { transform: 'translateX(0) skewY(-4deg)' }], { duration: 220, easing: 'cubic-bezier(.2,1.3,.4,1)', fill: 'backwards' }, this.fx);
      play(band, [{ transform: 'translateX(0) skewY(-4deg)' }, { transform: 'translateX(110vw) skewY(-4deg)' }], { delay: 1520, duration: 200, easing: 'ease-in', fill: 'forwards' }, this.fx);
      // Letras caindo uma a uma
      letters.forEach((l, i) => play(l, [{ translate: '0 -24px', opacity: 0 }, { translate: '0 0', opacity: 1 }], { delay: 180 + i * 25, duration: 180, easing: 'steps(3)', fill: 'backwards' }, this.fx));
    }
    later(1760, () => this.el.replaceChildren(), this.fx);
  }

  destroy(): void {
    this.fx.cancel();
    this.el.remove();
  }
}
