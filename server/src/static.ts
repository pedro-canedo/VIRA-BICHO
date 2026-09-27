import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, posix } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticFile {
  body: Buffer;
  type: string;
  cacheControl: string;
  etag: string;
}

/**
 * Alvo da requisição já decodificado e normalizado. Nunca lança: null para qualquer coisa estranha
 * (sem '/', absolute-form, '*', %-encoding inválido, '\\', NUL ou segmento '..').
 */
export function parseRequestTarget(raw: string | undefined, maxLen: number): { path: string; query: string } | 'too_long' | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.length > maxLen) return 'too_long';
  if (raw[0] !== '/') return null;
  const q = raw.indexOf('?');
  const rawPath = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? '' : raw.slice(q + 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  if (decoded.split('/').includes('..')) return null;
  return { path: posix.normalize(decoded), query };
}

function cacheFor(pathname: string): string {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (pathname === '/index.html') return 'no-cache';
  return 'public, max-age=3600';
}

/**
 * Lê o build do cliente para a memória no boot (sem fs por requisição, sem path traversal: o lookup é exato).
 * Ignora dotfiles; diretório inexistente vira Map vazio (dev com Vite).
 */
export function loadStatic(publicDir: string, maxTotalBytes = 32 * 1024 * 1024): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  let total = 0;
  const walk = (dir: string, prefix: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      const pathname = `${prefix}/${name}`;
      const st = statSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) {
        walk(full, pathname);
        continue;
      }
      if (!st.isFile() || total + st.size > maxTotalBytes) continue;
      const body = readFileSync(full);
      total += body.length;
      files.set(pathname, {
        body,
        type: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
        cacheControl: cacheFor(pathname),
        etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
      });
    }
  };
  walk(publicDir, '');
  return files;
}
