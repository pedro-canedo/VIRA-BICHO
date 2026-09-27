// Checagem pública: GET no endereço do jogo pela internet (Cloudflare → túnel → celular).
// Se responde, o túnel está de pé.
import { httpGet } from './httpget';

export interface PublicCheck {
  url: string;
  ok: boolean | null;
  status: number | null;
  latencyMs: number | null;
  checkedAt: number | null;
  lastOkAt: number | null;
  error: string | null;
  consecutiveFailures: number;
}

export function emptyPublicCheck(url: string): PublicCheck {
  return { url, ok: null, status: null, latencyMs: null, checkedAt: null, lastOkAt: null, error: null, consecutiveFailures: 0 };
}

export async function checkPublic(prev: PublicCheck, timeoutMs: number, now = Date.now()): Promise<PublicCheck> {
  try {
    const res = await httpGet(prev.url, { timeoutMs, maxBytes: 64 * 1024, headers: { 'cache-control': 'no-cache' } });
    const ok = res.status >= 200 && res.status < 300;
    return {
      url: prev.url,
      ok,
      status: res.status,
      latencyMs: Math.round(res.ms),
      checkedAt: now,
      lastOkAt: ok ? now : prev.lastOkAt,
      error: ok ? null : `HTTP ${res.status}`,
      consecutiveFailures: ok ? 0 : prev.consecutiveFailures + 1,
    };
  } catch (err) {
    return {
      ...prev,
      ok: false,
      status: null,
      latencyMs: null,
      checkedAt: now,
      error: (err as Error).message.slice(0, 120),
      consecutiveFailures: prev.consecutiveFailures + 1,
    };
  }
}
