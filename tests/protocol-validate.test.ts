import { describe, expect, it } from 'vitest';
import { parseClientMsg } from '@vb/shared';

describe('parseClientMsg', () => {
  it.each([
    null,
    [],
    'x',
    { t: 1 },
    { t: 'hello', name: { toString: 1 }, mode: 'quick' },
    { t: 'hello', name: ['a'], mode: 'quick' },
    { t: 'hello', name: 'a'.repeat(65), mode: 'quick' },
    { t: 'hello', name: 'a', mode: 'admin' },
    { t: 'hello', name: 'a', mode: 'join', code: { toString: 1 } },
    { t: 'hello', name: 'a', mode: 'join', code: 'ABCDEFGHI' },
    { t: 'move', x: '1', y: 1 },
    { t: 'move', x: 1.5, y: 1 },
    { t: 'move', x: 1e9, y: 1 },
    { t: 'move', x: 1 },
    { t: 'target', id: 0 },
    { t: 'target', id: -1 },
    { t: 'target', id: 1.5 },
    { t: 'target', id: '3' },
    { t: 'act', a: 'voar' },
    { t: 'nada' },
    { t: '__proto__' },
  ])('recusa %j', (v) => {
    expect(parseClientMsg(v)).toBeNull();
  });

  it('aceita as mensagens válidas', () => {
    expect(parseClientMsg({ t: 'hello', name: 'Pedro', mode: 'quick' })).toEqual({ t: 'hello', name: 'Pedro', mode: 'quick' });
    expect(parseClientMsg({ t: 'hello', name: 'Pedro', mode: 'join', code: 'abcd' })).toEqual({ t: 'hello', name: 'Pedro', mode: 'join', code: 'abcd' });
    expect(parseClientMsg({ t: 'move', x: -3, y: 70 })).toEqual({ t: 'move', x: -3, y: 70 });
    expect(parseClientMsg({ t: 'target', id: 7 })).toEqual({ t: 'target', id: 7 });
    expect(parseClientMsg({ t: 'act', a: 'carga' })).toEqual({ t: 'act', a: 'carga' });
    expect(parseClientMsg({ t: 'startnow' })).toEqual({ t: 'startnow' });
    expect(parseClientMsg({ t: 'leave' })).toEqual({ t: 'leave' });
  });

  it('devolve objeto novo, sem campos extras', () => {
    const input = JSON.parse('{"t":"move","x":1,"y":2,"extra":true,"__proto__":{"polu":1}}');
    const out = parseClientMsg(input);
    expect(out).not.toBe(input);
    expect(Object.keys(out!)).toEqual(['t', 'x', 'y']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});
