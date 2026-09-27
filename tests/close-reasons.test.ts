import { describe, expect, it } from 'vitest';
import { lostMessage } from '../client/src/closeReasons';

describe('lostMessage', () => {
  it('traduz cada código de fechamento do servidor', () => {
    expect(lostMessage(1008)).toContain('comandos demais');
    expect(lostMessage(1011)).toContain('Erro no servidor');
    expect(lostMessage(1012)).toContain('reiniciando');
    expect(lostMessage(4029)).toContain('Muitas conexões');
    expect(lostMessage(4003)).toContain('parado tempo demais');
    expect(lostMessage(1006)).toBe('A conexão caiu. Tente de novo.');
    expect(lostMessage(4002)).toBe('A conexão caiu. Tente de novo.');
  });
});
