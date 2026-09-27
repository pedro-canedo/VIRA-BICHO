// Séries temporais em buffer circular de tamanho fixo (sem alocação por amostra).
// Tempo em Float64, valores em Float32 (NaN = sem dado). 24 h a cada 5 s = 17 280 pontos,
// ~1,1 MB para 13 métricas.

export const SERIES_FIELDS = [
  'online',
  'playing',
  'lobby',
  'rooms',
  'conns',
  'gameRssMB',
  'gameCpuPct',
  'lagP99',
  'tickP99',
  'load1',
  'memFreeMB',
  'tempC',
  'battery',
] as const;
export type SeriesField = (typeof SERIES_FIELDS)[number];
export type SeriesSample = Partial<Record<SeriesField, number | null>>;

export interface SeriesRange {
  from: number;
  to: number;
  /** Largura de cada ponto (ms) depois de reduzir. */
  stepMs: number;
  t: number[];
  fields: Record<string, (number | null)[]>;
}

const MAGIC = 0x56425331; // "VBS1"

export class RingSeries {
  readonly t: Float64Array;
  readonly cols: Float32Array[];
  private head = 0; // próxima posição de escrita
  private count = 0;

  constructor(
    readonly capacity: number,
    readonly fields: readonly string[] = SERIES_FIELDS,
  ) {
    this.t = new Float64Array(capacity);
    this.cols = fields.map(() => new Float32Array(capacity).fill(Number.NaN));
  }

  get size(): number {
    return this.count;
  }

  push(t: number, sample: Record<string, number | null | undefined>): void {
    const i = this.head;
    this.t[i] = t;
    for (let f = 0; f < this.fields.length; f++) {
      const v = sample[this.fields[f]];
      this.cols[f][i] = typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
    }
    this.head = (i + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Índice físico da k-ésima amostra em ordem cronológica. */
  private idx(k: number): number {
    return (this.head - this.count + k + this.capacity) % this.capacity;
  }

  last(): { t: number; values: Record<string, number | null> } | null {
    if (this.count === 0) return null;
    const i = this.idx(this.count - 1);
    const values: Record<string, number | null> = {};
    this.fields.forEach((f, c) => {
      const v = this.cols[c][i];
      values[f] = Number.isNaN(v) ? null : v;
    });
    return { t: this.t[i], values };
  }

  /** Primeira posição cronológica com t >= from (busca binária; os tempos são crescentes). */
  private lowerBound(from: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[this.idx(mid)] < from) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Amostras em [from, to], reduzidas a no máximo maxPoints por média em baldes de tempo.
   * Para "online" e afins a média de 5 s em baldes de alguns minutos é o que o gráfico precisa.
   */
  range(from: number, to: number, maxPoints = 360, only?: readonly string[]): SeriesRange {
    const names = only ? this.fields.filter((f) => only.includes(f)) : [...this.fields];
    const colIdx = names.map((n) => this.fields.indexOf(n));
    const span = Math.max(1, to - from);
    const buckets = Math.max(1, Math.min(maxPoints, 2000));
    const stepMs = Math.max(1, Math.ceil(span / buckets));
    const sums = colIdx.map(() => new Float64Array(buckets));
    const ns = colIdx.map(() => new Uint32Array(buckets));
    const hit = new Uint8Array(buckets);
    for (let k = this.lowerBound(from); k < this.count; k++) {
      const i = this.idx(k);
      const t = this.t[i];
      if (t > to) break;
      const b = Math.min(buckets - 1, Math.floor((t - from) / stepMs));
      hit[b] = 1;
      for (let c = 0; c < colIdx.length; c++) {
        const v = this.cols[colIdx[c]][i];
        if (!Number.isNaN(v)) {
          sums[c][b] += v;
          ns[c][b]++;
        }
      }
    }
    const out: SeriesRange = { from, to, stepMs, t: [], fields: {} };
    names.forEach((n) => (out.fields[n] = []));
    for (let b = 0; b < buckets; b++) {
      if (!hit[b]) continue;
      out.t.push(from + b * stepMs + Math.floor(stepMs / 2));
      for (let c = 0; c < names.length; c++) {
        out.fields[names[c]].push(ns[c][b] ? Math.round((sums[c][b] / ns[c][b]) * 100) / 100 : null);
      }
    }
    return out;
  }

  /** Máximo de um campo em [from, to] (null se não houver dado). */
  max(field: string, from: number, to = Number.POSITIVE_INFINITY): number | null {
    const c = this.fields.indexOf(field);
    if (c < 0) return null;
    let best: number | null = null;
    for (let k = this.lowerBound(from); k < this.count; k++) {
      const i = this.idx(k);
      if (this.t[i] > to) break;
      const v = this.cols[c][i];
      if (!Number.isNaN(v) && (best === null || v > best)) best = v;
    }
    return best;
  }

  /**
   * Formato binário: [u32 magic][u32 tamanho do cabeçalho JSON][JSON {fields,count}]
   * [count × f64 tempos][fields × count × f32 valores], tudo em ordem cronológica.
   */
  serialize(): Buffer {
    const header = Buffer.from(JSON.stringify({ fields: this.fields, count: this.count }), 'utf8');
    const n = this.count;
    const buf = Buffer.alloc(8 + header.length + n * 8 + this.fields.length * n * 4);
    buf.writeUInt32LE(MAGIC, 0);
    buf.writeUInt32LE(header.length, 4);
    header.copy(buf, 8);
    let off = 8 + header.length;
    for (let k = 0; k < n; k++, off += 8) buf.writeDoubleLE(this.t[this.idx(k)], off);
    for (let c = 0; c < this.fields.length; c++) {
      const col = this.cols[c];
      for (let k = 0; k < n; k++, off += 4) buf.writeFloatLE(col[this.idx(k)], off);
    }
    return buf;
  }

  /**
   * Restaura de um buffer salvo. Campos são casados pelo nome (campos novos ficam vazios,
   * removidos são ignorados); amostras mais antigas que minT são descartadas.
   */
  static deserialize(buf: Buffer, capacity: number, fields: readonly string[] = SERIES_FIELDS, minT = 0): RingSeries {
    const s = new RingSeries(capacity, fields);
    if (buf.length < 8 || buf.readUInt32LE(0) !== MAGIC) throw new Error('arquivo de séries inválido');
    const hlen = buf.readUInt32LE(4);
    const header = JSON.parse(buf.subarray(8, 8 + hlen).toString('utf8')) as { fields: string[]; count: number };
    const n = header.count;
    const base = 8 + hlen;
    if (buf.length < base + n * 8 + header.fields.length * n * 4) throw new Error('arquivo de séries truncado');
    const valuesAt = (c: number, k: number) => buf.readFloatLE(base + n * 8 + (c * n + k) * 4);
    const map = fields.map((f) => header.fields.indexOf(f));
    const start = Math.max(0, n - capacity);
    for (let k = start; k < n; k++) {
      const t = buf.readDoubleLE(base + k * 8);
      if (t < minT) continue;
      const sample: Record<string, number | null> = {};
      fields.forEach((f, i) => (sample[f] = map[i] >= 0 ? valuesAt(map[i], k) : null));
      s.push(t, sample);
    }
    return s;
  }
}
