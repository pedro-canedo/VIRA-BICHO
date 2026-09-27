import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRequestTarget } from '../server/src/static';
import type { App } from '../server/src/app';
import { httpGet, rawHttp, startApp, within, wsClient } from './helpers/app';

let app: App;
let port: number;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ app, port, close } = await startApp());
});
afterEach(() => close());

describe('fronteira HTTP não derruba o processo', () => {
  it.each(['/%', '/%FF', '/%C0%AF', '//', '/%E0%A4%A', 'http://[', '*'])('%s → 4xx e o servidor segue de pé', async (target) => {
    const r = await rawHttp(port, target);
    if (target === '//') expect(r.status).toBe(404); // vira '/', sem build do cliente
    else expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect((await httpGet(port, '/health')).status).toBe(200);
  });

  it('erro do servidor (EMFILE no accept) não lança', async () => {
    expect(() => app.server.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }))).not.toThrow();
    expect((await httpGet(port, '/health')).status).toBe(200);
  });
});

describe('fronteira WebSocket não derruba o processo', () => {
  it('frame maior que o limite → 1009', async () => {
    const { client } = await wsClient(port);
    client!.send('x'.repeat(600));
    expect((await client!.closed).code).toBe(1009);
    expect((await httpGet(port, '/health')).status).toBe(200);
  });

  it('texto com UTF-8 inválido → 1007', async () => {
    const { client } = await wsClient(port);
    client!.ws.send(Buffer.from([0xff, 0xfe]), { binary: false });
    expect((await client!.closed).code).toBe(1007);
    expect((await httpGet(port, '/health')).status).toBe(200);
  });

  it('hello com name {toString:1} é ignorado e a conexão continua utilizável', async () => {
    const { client } = await wsClient(port);
    client!.send('{"t":"hello","name":{"toString":1},"mode":"quick"}');
    client!.send({ t: 'hello', name: 'Pedro', mode: 'quick' });
    const lobby = await client!.waitFor((m) => m.t === 'lobby');
    expect(lobby.t).toBe('lobby');
    expect(await within(client!.closed, 100)).toBe('timeout');
    expect((await httpGet(port, '/health')).status).toBe(200);
  });

  it('exceção dentro do handler → 1011 só para aquela conexão', async () => {
    vi.spyOn(app.lobby, 'handle').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = await wsClient(port);
    client!.send({ t: 'hello', name: 'A', mode: 'quick' });
    expect((await client!.closed).code).toBe(1011);
    err.mockRestore();
    const { client: other } = await wsClient(port);
    other!.send({ t: 'hello', name: 'B', mode: 'quick' });
    expect((await other!.waitFor((m) => m.t === 'lobby')).t).toBe('lobby');
    other!.ws.close();
  });
});

describe('parseRequestTarget', () => {
  it('decodifica, normaliza e recusa o que é estranho', () => {
    expect(parseRequestTarget('/%FF', 2048)).toBeNull();
    expect(parseRequestTarget('//', 2048)).toEqual({ path: '/', query: '' });
    expect(parseRequestTarget('/a?b=1', 2048)).toEqual({ path: '/a', query: 'b=1' });
    expect(parseRequestTarget('/..%2f..%2fx', 2048)).toBeNull();
    expect(parseRequestTarget('/a%5cb', 2048)).toBeNull();
    expect(parseRequestTarget('/a%00', 2048)).toBeNull();
    expect(parseRequestTarget('http://x/', 2048)).toBeNull();
    expect(parseRequestTarget(undefined, 2048)).toBeNull();
    expect(parseRequestTarget('/' + 'a'.repeat(2999), 2048)).toBe('too_long');
  });
});
