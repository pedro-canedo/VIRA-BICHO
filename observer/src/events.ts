// Eventos: buffer em memória para o painel + arquivos NDJSON diários em disco.
import { appendFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { OBS_EVENT_TYPES, type ObsEventValue } from '../../shared/src/obs';

/** Tipos gerados pelo próprio observador. */
export const OBS_SYNTHETIC_TYPES = ['restart', 'down', 'up'] as const;
export const ALL_EVENT_TYPES: readonly string[] = [...OBS_EVENT_TYPES, ...OBS_SYNTHETIC_TYPES];

export interface StoredEvent {
  /** Identificador do observador (crescente, sobrevive a reinícios do jogo). */
  id: number;
  t: number;
  type: string;
  /** seq do jogo (ausente nos eventos sintéticos). */
  seq?: number;
  data: Record<string, ObsEventValue>;
}

const MAX_STR = 200;
const MAX_KEYS = 16;

/** Normaliza o data vindo do jogo: só valores primitivos, chaves e textos curtos. */
export function sanitizeData(raw: unknown): Record<string, ObsEventValue> {
  const out: Record<string, ObsEventValue> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_KEYS) break;
    if (k.length > 32 || k === '__proto__') continue;
    if (v === null || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : null;
    else if (typeof v === 'string') out[k] = v.slice(0, MAX_STR);
    else continue;
    n++;
  }
  return out;
}

/** Data local AAAA-MM-DD (o celular está no fuso do Brasil; os agregados seguem o dia local). */
export function dayKey(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const FILE_RE = /^events-(\d{4})-(\d{2})-(\d{2})\.ndjson$/;

export class EventStore {
  private ring: StoredEvent[] = [];
  private pending: StoredEvent[] = [];
  private nextId = 1;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string | null,
    private readonly capacity = 1_000,
  ) {}

  get lastId(): number {
    return this.nextId - 1;
  }

  add(e: Omit<StoredEvent, 'id'>): StoredEvent {
    const ev: StoredEvent = { id: this.nextId++, ...e };
    this.ring.push(ev);
    if (this.ring.length > this.capacity * 1.25) this.ring.splice(0, this.ring.length - this.capacity);
    if (this.dir) this.pending.push(ev);
    return ev;
  }

  /** Eventos mais recentes primeiro, com filtro opcional por tipo e paginação por id. */
  query(opts: { limit?: number; types?: readonly string[]; beforeId?: number; afterId?: number } = {}): StoredEvent[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, this.capacity));
    const out: StoredEvent[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.ring[i];
      if (opts.afterId !== undefined && e.id <= opts.afterId) break;
      if (opts.beforeId !== undefined && e.id >= opts.beforeId) continue;
      if (opts.types && opts.types.length && !opts.types.includes(e.type)) continue;
      out.push(e);
    }
    return out;
  }

  /** Grava os eventos pendentes, agrupados pelo dia (um append por arquivo). */
  flush(): Promise<void> {
    if (!this.dir || this.pending.length === 0) return this.writing;
    const batch = this.pending;
    this.pending = [];
    const dir = this.dir;
    this.writing = this.writing.then(async () => {
      const byDay = new Map<string, string[]>();
      for (const e of batch) {
        const k = dayKey(e.t);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k)!.push(JSON.stringify(e));
      }
      try {
        await mkdir(dir, { recursive: true });
        for (const [k, lines] of byDay) await appendFile(join(dir, `events-${k}.ndjson`), lines.join('\n') + '\n', { mode: 0o600 });
      } catch (err) {
        console.error('[obs] falha ao gravar eventos:', (err as Error).message);
      }
    });
    return this.writing;
  }

  /** Recarrega os últimos eventos (hoje e ontem) para o feed não começar vazio após reinício. */
  async restore(now = Date.now()): Promise<StoredEvent[]> {
    if (!this.dir) return [];
    const loaded: StoredEvent[] = [];
    for (const k of [dayKey(now - 86_400_000), dayKey(now)]) {
      loaded.push(...(await readDay(this.dir, k)));
    }
    const tail = loaded.slice(-this.capacity);
    this.ring = tail;
    const maxId = loaded.reduce((m, e) => Math.max(m, e.id), 0);
    this.nextId = Math.max(this.nextId, maxId + 1);
    return tail;
  }

  /** Apaga arquivos com mais de keepDays dias. */
  async prune(keepDays: number, now = Date.now()): Promise<string[]> {
    if (!this.dir) return [];
    const cutoff = dayKey(now - keepDays * 86_400_000);
    const removed: string[] = [];
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return removed;
    }
    for (const f of files) {
      const m = FILE_RE.exec(f);
      if (!m) continue;
      if (`${m[1]}-${m[2]}-${m[3]}` < cutoff) {
        await unlink(join(this.dir, f)).catch(() => {});
        removed.push(f);
      }
    }
    return removed;
  }
}

/** Lê um arquivo diário (linhas inválidas são ignoradas). */
export async function readDay(dir: string, day: string): Promise<StoredEvent[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  let text: string;
  try {
    text = await readFile(join(dir, `events-${day}.ndjson`), 'utf8');
  } catch {
    return [];
  }
  const out: StoredEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as StoredEvent;
      if (typeof e.id === 'number' && typeof e.t === 'number' && typeof e.type === 'string') {
        out.push({ id: e.id, t: e.t, type: e.type, seq: e.seq, data: sanitizeData(e.data) });
      }
    } catch {
      // linha truncada (queda no meio de uma escrita)
    }
  }
  return out;
}
