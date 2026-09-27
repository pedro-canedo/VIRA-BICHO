type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

/** Mini "hyperscript" para montar a interface sem framework. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const ui = (): HTMLElement => document.getElementById('ui')!;

export function mount(el: HTMLElement): HTMLElement {
  ui().append(el);
  return el;
}

export function clearUi(): void {
  ui().replaceChildren();
}

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function modal(title: string, body: Node, onClose?: () => void): () => void {
  const close = () => {
    bg.remove();
    onClose?.();
  };
  const bg: HTMLDivElement = h(
    'div',
    { class: 'modal-bg', onclick: (e: Event) => e.target === bg && close() },
    h('div', { class: 'card modal' }, h('h2', {}, title), body, h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn primary', onclick: close }, 'Fechar'))),
  );
  document.body.append(bg);
  return close;
}
