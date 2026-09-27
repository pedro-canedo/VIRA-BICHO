import { describe, expect, it } from 'vitest';
import { DEFAULT_ORIGINS, clientId, originAllowed } from '../server/src/security';

describe('clientId', () => {
  it.each(['127.0.0.1', '::ffff:127.0.0.1', '::1'])('loopback %s confia no CF-Connecting-IP e ignora XFF', (remote) => {
    expect(clientId(remote, { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '6.6.6.6' })).toEqual({ key: '203.0.113.9', viaCloudflare: true });
  });

  it('fora do loopback ignora todos os cabeçalhos (CF forjado na LAN não vale)', () => {
    expect(clientId('192.168.3.50', { 'cf-connecting-ip': '1.1.1.1' })).toEqual({ key: '192.168.3.50', viaCloudflare: false });
    expect(clientId('::ffff:192.168.3.50', {})).toEqual({ key: '192.168.3.50', viaCloudflare: false });
  });

  it('loopback sem CF é local; CF inválido vai para um balde comum', () => {
    expect(clientId('127.0.0.1', {})).toEqual({ key: 'local', viaCloudflare: false });
    expect(clientId('127.0.0.1', { 'cf-connecting-ip': 'lixo' })).toEqual({ key: 'cf-invalid', viaCloudflare: true });
    expect(clientId('127.0.0.1', { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '6.6.6.6', 'true-client-ip': '6.6.6.6' })).toEqual({ key: 'local', viaCloudflare: false });
  });

  it('agrupa IPv6 em /64 e desfaz IPv4 mapeado', () => {
    const a = clientId('127.0.0.1', { 'cf-connecting-ip': '2001:db8:1:2:aaaa::1' });
    const b = clientId('127.0.0.1', { 'cf-connecting-ip': '2001:db8:1:2:bbbb::9' });
    const c = clientId('127.0.0.1', { 'cf-connecting-ip': '2001:db8:1:3::1' });
    expect(a.key).toBe('2001:db8:1:2::/64');
    expect(b.key).toBe(a.key);
    expect(c.key).not.toBe(a.key);
    expect(clientId('127.0.0.1', { 'cf-connecting-ip': '::ffff:198.51.100.4' }).key).toBe('198.51.100.4');
  });
});

describe('originAllowed', () => {
  const allow = new Set(DEFAULT_ORIGINS);
  it('segue a tabela de regras', () => {
    expect(originAllowed('https://virabicho.caixazen.online', true, allow)).toBe(true);
    expect(originAllowed('https://batllebicho.caixazen.online', true, allow)).toBe(true);
    expect(originAllowed('https://evil.example', true, allow)).toBe(false);
    expect(originAllowed('https://evil.example', false, allow)).toBe(false);
    expect(originAllowed(undefined, true, allow)).toBe(false);
    expect(originAllowed(undefined, false, allow)).toBe(true);
    expect(originAllowed('http://192.168.3.19:5173', false, allow)).toBe(true);
    expect(originAllowed('http://192.168.3.19:5173', true, allow)).toBe(false);
    expect(originAllowed('http://localhost:5173', false, allow)).toBe(true);
    expect(originAllowed('http://evil.local:3000', false, allow)).toBe(false);
    expect(originAllowed('http://8.8.8.8', false, allow)).toBe(false);
    expect(originAllowed('null', false, allow)).toBe(false);
  });
});
