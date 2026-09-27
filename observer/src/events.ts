// Eventos: buffer em memória para o painel + arquivos NDJSON diários em disco.
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
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
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const dayFile = (dir: string, day: string) => join(dir, `events-${day}.ndjson`);

export interface EventStoreOptions {
  /** Eventos mantidos em memória para o feed. */
  capacity?: number;
  /** Teto de bytes por arquivo diário (o resto do dia é descartado, com aviso no log). */
  maxDayBytes?: number;
  /** Quanto do fim de cada arquivo é lido ao restaurar o feed. */
  restoreTailBytes?: number;
}

export class EventStore {
  private ring: StoredEvent[] = [];
  private pending: StoredEvent[] = [];
  private nextId = 1;
  private writing: Promise<void> = Promise.resolve();
  private readonly capacity: number;
  private readonly maxDayBytes: number;
  private readonly restoreTailBytes: number;
  /** Bytes já gravados em cada arquivo diário (lidos do disco na primeira escrita do dia). */
  private dayBytes = new Map<string, number>();
  /** Eventos descartados por dia por causa do teto. */
  readonly dropped = new Map<string, number>();

  constructor(
    private readonly dir: string | null,
    opts: EventStoreOptions | number = {},
  ) {
    const o = typeof opts === 'number' ? { capacity: opts } : opts;
    this.capacity = o.capacity ?? 1_000;
    this.maxDayBytes = o.maxDayBytes ?? 20 * 1024 * 1024;
    this.restoreTailBytes = o.restoreTailBytes ?? 512 * 1024;
  }

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
        for (const [k, lines] of byDay) {
          const file = dayFile(dir, k);
          let used = this.dayBytes.get(k);
          if (used === undefined) {
            used = await stat(file).then((st) => st.size, () => 0);
            // Só guarda o dia corrente (e o anterior) para o mapa não crescer.
            if (this.dayBytes.size > 4) this.dayBytes.clear();
          }
          let text = '';
          let bytes = 0;
          let kept = 0;
          for (const line of lines) {
            const n = Buffer.byteLength(line) + 1;
            if (used + bytes + n > this.maxDayBytes) break;
            text += line + '\n';
            bytes += n;
            kept++;
          }
          if (kept < lines.length) {
            const before = this.dropped.get(k) ?? 0;
            if (before === 0) console.error(`[obs] ${file} passou de ${this.maxDayBytes} bytes: eventos do resto do dia não serão gravados em disco`);
            this.dropped.set(k, before + lines.length - kept);
          }
          if (text) await appendFile(file, text, { mode: 0o600 });
          this.dayBytes.set(k, used + bytes);
        }
      } catch (err) {
        console.error('[obs] falha ao gravar eventos:', (err as Error).message);
      }
    });
    return this.writing;
  }

  /**
   * Recarrega os últimos eventos (fim do arquivo de ontem e de hoje) para o feed não começar
   * vazio após reinício. Lê só o final de cada arquivo: um arquivo diário enorme não estoura o heap.
   */
  async restore(now = Date.now()): Promise<StoredEvent[]> {
    if (!this.dir) return [];
    const loaded: StoredEvent[] = [];
    for (const k of [dayKey(now - 86_400_000), dayKey(now)]) {
      loaded.push(...(await readDayTail(this.dir, k, this.restoreTailBytes)));
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

/** Uma linha do NDJSON como evento (null se inválida ou truncada). */
export function parseLine(line: string): StoredEvent | null {
  if (!line || line.length > 64 * 1024) return null;
  try {
    const e = JSON.parse(line) as StoredEvent;
    if (e && typeof e.id === 'number' && typeof e.t === 'number' && typeof e.type === 'string' && e.type.length <= 32) {
      return { id: e.id, t: e.t, type: e.type, seq: typeof e.seq === 'number' ? e.seq : undefined, data: sanitizeData(e.data) };
    }
  } catch {
    // linha truncada (queda no meio de uma escrita)
  }
  return null;
}

/** Lê só os últimos `maxBytes` de um arquivo diário (a primeira linha, parcial, é descartada). */
export async function readDayTail(dir: string, day: string, maxBytes: number): Promise<StoredEvent[]> {
  if (!DAY_RE.test(day)) return [];
  let h;
  try {
    h = await open(dayFile(dir, day), 'r');
  } catch {
    return [];
  }
  try {
    const { size } = await h.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await h.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const out: StoredEvent[] = [];
    for (const line of lines) {
      const e = parseLine(line);
      if (e) out.push(e);
    }
    return out;
  } catch {
    return [];
  } finally {
    await h.close();
  }
}

/** Percorre um arquivo diário linha a linha, sem carregá-lo inteiro na memória. */
export async function forEachInDay(dir: string, day: string, fn: (e: StoredEvent) => void): Promise<void> {
  if (!DAY_RE.test(day)) return;
  const stream = createReadStream(dayFile(dir, day), { encoding: 'utf8', highWaterMark: 64 * 1024 });
  const opened = await new Promise<boolean>((resolveOpen) => {
    stream.once('open', () => resolveOpen(true));
    stream.once('error', () => resolveOpen(false));
  });
  if (!opened) return;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const e = parseLine(line);
      if (e) fn(e);
    }
  } catch {
    // erro de leitura no meio: fica com o que deu para ler
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** Os últimos `limit` eventos de um dia que passam no filtro (mais antigos primeiro). */
export async function readDayLast(dir: string, day: string, limit: number, filter: (e: StoredEvent) => boolean = () => true): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  await forEachInDay(dir, day, (e) => {
    if (!filter(e)) return;
    out.push(e);
    if (out.length > limit * 2) out.splice(0, out.length - limit);
  });
  return out.slice(-limit);
}

/** Lê um arquivo diário inteiro (só para arquivos pequenos: testes e ferramentas). */
export async function readDay(dir: string, day: string): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  await forEachInDay(dir, day, (e) => out.push(e));
  return out;
}
