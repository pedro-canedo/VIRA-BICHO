import { describe, expect, it } from 'vitest';
import { BattleInset, applyInsetToDocument } from '../client/src/ui/battleInset';

/** ResizeObserver de mentira: o teste dispara o callback à mão. */
function fakeRO() {
  const live: { cb: () => void; el: unknown; on: boolean }[] = [];
  class RO {
    private rec: { cb: () => void; el: unknown; on: boolean };
    constructor(cb: () => void) {
      this.rec = { cb, el: null, on: true };
      live.push(this.rec);
    }
    observe(el: unknown) {
      this.rec.el = el;
    }
    disconnect() {
      this.rec.on = false;
    }
  }
  const fire = () => live.filter((r) => r.on).forEach((r) => r.cb());
  return { RO, live, fire };
}

const panel = (h: number) => ({ isConnected: true, offsetHeight: h }) as unknown as HTMLElement & { offsetHeight: number };

describe('altura do painel de batalha (câmera e toasts)', () => {
  it('mede a altura de layout na hora e acompanha quando o painel muda de tamanho', () => {
    const got: number[] = [];
    const { RO, fire } = fakeRO();
    const inset = new BattleInset((px) => got.push(px), RO);
    const el = panel(412);
    inset.track(el);
    expect(got).toEqual([412]);
    // Resultado: somem botões e cronômetro, o painel encolhe.
    (el as { offsetHeight: number }).offsetHeight = 300;
    fire();
    expect(got).toEqual([412, 300]);
    fire(); // mesma altura não reaplica
    expect(got).toEqual([412, 300]);
  });

  it('fim da batalha zera e para de observar o painel antigo', () => {
    const got: number[] = [];
    const { RO, live, fire } = fakeRO();
    const inset = new BattleInset((px) => got.push(px), RO);
    const a = panel(400);
    inset.track(a);
    inset.track(null);
    expect(got).toEqual([400, 0]);
    expect(live.every((r) => !r.on)).toBe(true);
    (a as { offsetHeight: number }).offsetHeight = 500;
    fire();
    expect(got).toEqual([400, 0]);
    // Nova batalha logo em seguida troca o painel observado.
    const b = panel(380);
    inset.track(b);
    expect(got).toEqual([400, 0, 380]);
    expect(live.filter((r) => r.on).map((r) => r.el)).toEqual([b]);
  });

  it('sem ResizeObserver mede uma vez e segue funcionando', () => {
    const got: number[] = [];
    const inset = new BattleInset((px) => got.push(px), undefined);
    inset.track(panel(333));
    inset.track(null);
    expect(got).toEqual([333, 0]);
  });

  it('no documento: variável --battle-inset e classe in-battle só durante a batalha', () => {
    const props = new Map<string, string>();
    const cls = new Set<string>();
    const doc = {
      documentElement: { style: { setProperty: (k: string, v: string) => props.set(k, v) } },
      body: { classList: { toggle: (c: string, on: boolean) => (on ? cls.add(c) : cls.delete(c)) } },
    } as unknown as Document;
    applyInsetToDocument(420, doc);
    expect(props.get('--battle-inset')).toBe('420px');
    expect(cls.has('in-battle')).toBe(true);
    applyInsetToDocument(0, doc);
    expect(cls.has('in-battle')).toBe(false);
  });

  it('o CSS desce os toasts para cima do painel quando há batalha', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('client/src/style.css', 'utf8');
    const rule = css.match(/body\.in-battle \.toasts\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/top:\s*auto/);
    expect(rule).toMatch(/bottom:\s*calc\(var\(--battle-inset/);
  });
});
