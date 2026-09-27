import { describe, expect, it } from 'vitest';
import { BALANCE, FX_IMPACT_MS } from '@vb/shared';
import { HIT_END_AT, SEAL_FADE_AT } from '../client/src/ui/battle';

describe('efeitos do painel de batalha', () => {
  it('número e selos somem antes do próximo b_turn/b_end', () => {
    // entrada do selo (280 ms) e fade (150 ms) cabem na janela da revelação
    expect(SEAL_FADE_AT).toBeGreaterThanOrEqual(280);
    expect(FX_IMPACT_MS + SEAL_FADE_AT + 150).toBeLessThanOrEqual(FX_IMPACT_MS + HIT_END_AT);
    expect(FX_IMPACT_MS + HIT_END_AT).toBeLessThan(BALANCE.battle.revealMs);
  });
});
