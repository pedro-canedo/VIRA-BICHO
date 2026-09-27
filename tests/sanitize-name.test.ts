import { describe, expect, it } from 'vitest';
import { sanitizeName } from '../server/src/security';
import { sanitizeName as fromLobby } from '../server/src/lobby';
import { Room, type Member } from '../server/src/room';

describe('sanitizeName', () => {
  it('não lança com nada que não seja string', () => {
    for (const v of [{}, [], 42, null, undefined, { toString: 1 }]) expect(sanitizeName(v)).toBe('Bichinho');
    expect(fromLobby).toBe(sanitizeName);
  });

  it('remove bidi, zero-width e preenchedores invisíveis', () => {
    expect(sanitizeName('‮odrep')).toBe('odrep');
    expect(sanitizeName('Pedro​')).toBe('Pedro');
    expect(sanitizeName('ㅤ')).toBe('Bichinho');
    expect(sanitizeName('⠀⠀')).toBe('Bichinho');
    expect(sanitizeName('a\u0000b\u0085c')).toBe('abc');
  });

  it('normaliza fullwidth e espaços', () => {
    expect(sanitizeName('ＰＥＤＲＯ')).toBe('PEDRO');
    expect(sanitizeName('  a 　  b  ')).toBe('a b');
  });

  it('corta em 14 code points sem partir emoji', () => {
    const out = sanitizeName('😀'.repeat(20));
    expect(Array.from(out).length).toBeLessThanOrEqual(14);
    expect(out).toBe('😀'.repeat(14));
    expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false);
  });

  it('tira < e >, limita marcas combinantes e não deixa imitar bot', () => {
    expect(sanitizeName('<b>x</b>')).not.toMatch(/[<>]/);
    const z = sanitizeName('a' + '́'.repeat(10));
    expect(z.match(/\p{M}/gu)!.length).toBeLessThanOrEqual(2);
    expect(sanitizeName('🤖 bot')).toBe('Bichinho');
    expect(sanitizeName('BOT')).toBe('Bichinho');
    expect(sanitizeName('Robot')).toBe('Robot');
  });

  it('nomes parecidos com zero-width viram duplicados numerados na sala', () => {
    const room = new Room('TEST', true, 1);
    const mk = (raw: string): Member => ({ conn: { send: () => {} }, name: sanitizeName(raw), player: null });
    const a = mk('Pedro');
    const b = mk('Pedro​');
    room.join(a, 0);
    room.join(b, 0);
    expect([a.name, b.name]).toEqual(['Pedro', 'Pedro 2']);
  });
});
