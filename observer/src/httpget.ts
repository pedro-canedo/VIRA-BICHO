// GET mínimo com node:http/https (mais leve que o fetch/undici num celular com pouca RAM).
import http from 'node:http';
import https from 'node:https';

export interface GetResult {
  status: number;
  body: string;
  ms: number;
}

export interface GetOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  /** Corpo máximo aceito (bytes). */
  maxBytes?: number;
}

export class HttpGetError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function httpGet(url: string, opts: GetOptions): Promise<GetResult> {
  const started = performance.now();
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  return new Promise((resolvePromise, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new HttpGetError(`URL inválida: ${url}`, 'EINVAL'));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      { method: 'GET', headers: { 'user-agent': 'vira-bicho-obs', ...opts.headers }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new HttpGetError('resposta grande demais', 'E2BIG'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolvePromise({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            ms: performance.now() - started,
          });
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        res.on('close', () => {
          clearTimeout(timer);
          if (!res.complete) reject(new HttpGetError('conexão interrompida', 'ECONNRESET'));
        });
      },
    );
    // Prazo total (conexão + resposta), não só de ociosidade do socket.
    const timer = setTimeout(() => req.destroy(new HttpGetError(`timeout de ${opts.timeoutMs} ms`, 'ETIMEDOUT')), opts.timeoutMs);
    req.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err instanceof HttpGetError ? err : new HttpGetError(err.message, err.code ?? 'EIO'));
    });
    req.end();
  });
}
