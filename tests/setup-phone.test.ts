import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('scripts/setup-phone.sh', () => {
  it('limita o heap do Node e rotaciona o log do serviço', () => {
    const sh = readFileSync(new URL('../scripts/setup-phone.sh', import.meta.url), 'utf8');
    expect(sh).toContain('--max-old-space-size=');
    expect(sh).toContain('s5000000');
    expect(sh).toContain('n5');
  });
});
