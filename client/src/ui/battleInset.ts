/**
 * Altura do painel de batalha, acompanhada enquanto ele existe. O mundo centraliza a luta na área
 * visível acima do painel, e os avisos (toasts) descem para logo acima dele, para não cobrirem o
 * nome dos lutadores que a câmera sobe para o topo da tela.
 *
 * Mede com offsetHeight (altura de layout, sem a escala da animação de entrada) e remede quando o
 * painel muda de tamanho (os botões e o cronômetro somem no resultado, a revelação cresce).
 */
type RO = new (cb: () => void) => { observe(el: Element): void; disconnect(): void };

export class BattleInset {
  private ro: InstanceType<RO> | null = null;
  private px = 0;

  constructor(
    private apply: (px: number) => void,
    private RObs: RO | undefined = (globalThis as { ResizeObserver?: RO }).ResizeObserver,
  ) {}

  /** Passa a acompanhar o painel (ou zera, com null). */
  track(el: HTMLElement | null): void {
    this.ro?.disconnect();
    this.ro = null;
    if (!el) {
      this.set(0);
      return;
    }
    const measure = () => this.set(el.isConnected ? el.offsetHeight : 0);
    measure();
    if (this.RObs) {
      this.ro = new this.RObs(measure);
      this.ro.observe(el);
    }
  }

  private set(px: number): void {
    const v = Math.max(0, Math.round(px));
    if (v === this.px) return;
    this.px = v;
    this.apply(v);
  }
}

/** Aplica a altura no documento: variável CSS para os toasts e classe enquanto há batalha. */
export function applyInsetToDocument(px: number, doc: Document = document): void {
  doc.documentElement.style.setProperty('--battle-inset', `${px}px`);
  doc.body.classList.toggle('in-battle', px > 0);
}
