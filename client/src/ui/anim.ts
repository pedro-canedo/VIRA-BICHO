import { h } from './dom';

// Movimento acessível: tudo o que anima na interface passa por aqui.

const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let reducedFlag = !!mq?.matches;
mq?.addEventListener('change', (e) => (reducedFlag = e.matches));

/** true com prefers-reduced-motion: reduce (acompanha mudanças do sistema). */
export const reduced = (): boolean => reducedFlag;

/** Dono de animações e timeouts, para cancelar tudo de uma vez (startTurn, end, destroy). */
export class Anims {
  private list: Animation[] = [];
  private timers = new Set<number>();

  add(a: Animation): void {
    if (this.list.length > 96) this.list = this.list.filter((x) => x.playState !== 'finished');
    this.list.push(a);
  }

  track(id: number): void {
    this.timers.add(id);
  }

  untrack(id: number): void {
    this.timers.delete(id);
  }

  /** Cancela o que ainda está rodando; o que já terminou com fill 'forwards' fica como está. */
  cancel(): void {
    for (const a of this.list) if (a.playState !== 'finished') a.cancel();
    this.list.length = 0;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
  }
}

export function play(el: Element, keyframes: Keyframe[], opts: KeyframeAnimationOptions, owner?: Anims): Animation | null {
  if (typeof el.animate !== 'function') return null;
  const a = el.animate(keyframes, opts);
  owner?.add(a);
  return a;
}

export function later(ms: number, fn: () => void, owner: Anims): void {
  const id = window.setTimeout(() => {
    owner.untrack(id);
    fn();
  }, ms);
  owner.track(id);
}

export function vibrate(pattern: number | number[]): void {
  if (reducedFlag) return;
  try {
    if (localStorage.getItem('vb.vibe') === '0') return;
    navigator.vibrate?.(pattern);
  } catch {
    // sem vibração
  }
}

// ---------- contadores com um rAF compartilhado ----------

interface Counter {
  from: number;
  to: number;
  t0: number;
  ms: number;
  fmt: (n: number) => string;
}

const counters = new Map<HTMLElement, Counter>();
let countRaf = 0;

function stepCounters(now: number): void {
  for (const [el, c] of counters) {
    const k = Math.min(1, (now - c.t0) / c.ms);
    el.textContent = c.fmt(Math.round(c.from + (c.to - c.from) * k));
    if (k >= 1) counters.delete(el);
  }
  countRaf = counters.size ? requestAnimationFrame(stepCounters) : 0;
}

/** Conta de `from` até `to` em `ms`. Com reduced-motion pula direto ao valor. */
export function countTo(el: HTMLElement, from: number, to: number, ms: number, fmt: (n: number) => string = String): void {
  if (reducedFlag || from === to || ms <= 0) {
    counters.delete(el);
    el.textContent = fmt(to);
    return;
  }
  counters.set(el, { from, to, t0: performance.now(), ms, fmt });
  if (!countRaf) countRaf = requestAnimationFrame(stepCounters);
}

// ---------- barra com dano fantasma ----------

/** Barra de HP: o <i> cai na hora e o fantasma (<b>) segura o valor antigo e desce depois. */
export class GhostBar {
  readonly el: HTMLElement;
  private fill = h('i');
  private ghost = h('b', { class: 'ghost' });
  private frac = -1;

  constructor(cls = '') {
    this.el = h('div', { class: `bar hpbar ${cls}`.trim() }, this.ghost, this.fill);
  }

  get value(): number {
    return this.frac;
  }

  set(frac: number, owner?: Anims): void {
    frac = Math.max(0, Math.min(1, frac));
    if (frac === this.frac) return;
    const g = this.ghost.style;
    const f = this.fill.style;
    if (this.frac < 0) {
      g.transition = f.transition = 'none';
      g.transform = f.transform = `scaleX(${frac})`;
    } else if (frac < this.frac) {
      const drop = this.frac - frac;
      this.ghost.classList.remove('heal');
      g.transition = f.transition = 'none';
      g.transform = `scaleX(${this.frac})`;
      f.transform = `scaleX(${frac})`;
      void this.ghost.offsetWidth;
      g.transition = '';
      g.transform = `scaleX(${frac})`;
      play(this.ghost, [{ background: '#ffffff' }, { background: '#ffffff' }], { duration: 120 }, owner);
      if (drop >= 0.25 && !reducedFlag) play(this.el, [{ transform: 'scaleY(1.25)' }, { transform: 'scaleY(1.25)' }], { duration: 100 }, owner);
    } else {
      // Cura: o trecho verde salta para o valor novo e a barra cresce atrás dele
      this.ghost.classList.add('heal');
      g.transition = 'none';
      g.transform = `scaleX(${frac})`;
      f.transition = reducedFlag ? 'none' : 'transform .4s ease-out';
      f.transform = `scaleX(${frac})`;
    }
    this.el.classList.toggle('low', frac > 0 && frac <= 0.25);
    this.frac = frac;
  }
}

// ---------- texto digitado e carimbo ----------

const typing = new Map<HTMLElement, number>();

/** Digita `text` letra a letra (`ms` por letra). Com reduced-motion escreve direto. */
export function typeText(el: HTMLElement, text: string, ms = 40): void {
  window.clearTimeout(typing.get(el));
  typing.delete(el);
  if (reducedFlag || text.length < 2) {
    el.textContent = text;
    return;
  }
  let i = 0;
  const step = () => {
    i++;
    el.textContent = text.slice(0, i);
    if (i < text.length) typing.set(el, window.setTimeout(step, ms));
    else typing.delete(el);
  };
  step();
}

/** Entrada de carimbo: escala `from`→1 em degraus; com reduced-motion vira fade. Usa a propriedade `scale` (não briga com transform). */
export function stampIn(el: Element, owner?: Anims, o: { from?: number; ms?: number; delay?: number; rot?: [number, number] } = {}): void {
  const delay = o.delay ?? 0;
  if (reducedFlag) {
    play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 150, delay, fill: 'backwards' }, owner);
    return;
  }
  const from = o.from ?? 2;
  const kf: Keyframe[] = [
    { scale: String(from), opacity: 0 },
    { scale: '0.9', opacity: 1, offset: 0.7 },
    { scale: '1', opacity: 1 },
  ];
  if (o.rot) {
    kf[0].rotate = `${o.rot[0]}deg`;
    kf[1].rotate = `${o.rot[1]}deg`;
    kf[2].rotate = `${o.rot[1]}deg`;
  }
  play(el, kf, { duration: o.ms ?? 220, delay, easing: 'steps(3)', fill: o.rot ? 'both' : 'backwards' }, owner);
}
