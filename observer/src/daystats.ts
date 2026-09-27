// Agregados do dia local: partidas, duração média, vencedores por forma, pico de online.
import { dayKey, type StoredEvent } from './events';

export interface DayStats {
  day: string;
  matchesStarted: number;
  matchesEnded: number;
  totalDurationMs: number;
  /** Partidas terminadas com duração informada (base da média). */
  durationN: number;
  winnersByForm: Record<string, number>;
  joins: number;
  peakOnline: number;
  peakAt: number | null;
  restarts: number;
}

export function emptyDay(day: string): DayStats {
  return {
    day,
    matchesStarted: 0,
    matchesEnded: 0,
    totalDurationMs: 0,
    durationN: 0,
    winnersByForm: {},
    joins: 0,
    peakOnline: 0,
    peakAt: null,
    restarts: 0,
  };
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const MAX_FORMS = 32;

/**
 * Valida um DayStats vindo do state.json: campo com tipo errado vira o valor vazio, e o
 * winnersByForm só aceita chaves próprias com contagens numéricas (nada herdado do protótipo).
 */
export function sanitizeDayStats(raw: unknown): DayStats | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day)) return null;
  const winners: Record<string, number> = {};
  const w = r.winnersByForm;
  if (w && typeof w === 'object' && !Array.isArray(w)) {
    for (const [k, v] of Object.entries(w as Record<string, unknown>).slice(0, MAX_FORMS)) {
      if (k === '__proto__' || k.length > 24) continue;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) winners[k] = v;
    }
  }
  return {
    day: r.day,
    matchesStarted: count(r.matchesStarted),
    matchesEnded: count(r.matchesEnded),
    totalDurationMs: count(r.totalDurationMs),
    durationN: count(r.durationN),
    winnersByForm: winners,
    joins: count(r.joins),
    peakOnline: count(r.peakOnline),
    peakAt: typeof r.peakAt === 'number' && Number.isFinite(r.peakAt) ? r.peakAt : null,
    restarts: count(r.restarts),
  };
}

export class DayAggregator {
  stats: DayStats;

  constructor(now = Date.now(), restored?: unknown) {
    const today = dayKey(now);
    const clean = sanitizeDayStats(restored);
    this.stats = clean && clean.day === today ? clean : emptyDay(today);
  }

  /**
   * Troca de dia. Evento com data anterior (atrasado) é ignorado; mas se o próprio relógio do
   * observador voltou para um dia anterior (`clock`), recomeça naquele dia em vez de ignorar tudo
   * até o relógio alcançar o dia salvo.
   */
  private roll(t: number, clock = false): boolean {
    const k = dayKey(t);
    if (k === this.stats.day) return true;
    if (k < this.stats.day && !clock) return false; // evento de ontem chegando atrasado
    this.stats = emptyDay(k);
    return true;
  }

  onEvent(e: StoredEvent): void {
    if (!this.roll(e.t)) return;
    const s = this.stats;
    switch (e.type) {
      case 'match_start':
        s.matchesStarted++;
        break;
      case 'match_end': {
        s.matchesEnded++;
        const d = e.data.durationMs;
        if (typeof d === 'number' && d > 0) {
          s.totalDurationMs += d;
          s.durationN++;
        }
        const form = typeof e.data.form === 'string' && e.data.form ? e.data.form.slice(0, 24) : 'sem vencedor';
        if (form === '__proto__') break;
        // Só chaves próprias: 'constructor', 'toString' etc. não podem ler o que vem do protótipo.
        const w = s.winnersByForm;
        if (Object.hasOwn(w, form)) w[form] = w[form] + 1;
        else if (Object.keys(w).length < MAX_FORMS) w[form] = 1;
        break;
      }
      case 'join':
        s.joins++;
        break;
      case 'restart':
        s.restarts++;
        break;
    }
  }

  onOnline(t: number, online: number): void {
    if (!this.roll(t, true)) return;
    if (online > this.stats.peakOnline || this.stats.peakAt === null) {
      this.stats.peakOnline = online;
      this.stats.peakAt = t;
    }
  }

  view(now = Date.now()) {
    this.roll(now, true);
    const s = this.stats;
    return {
      day: s.day,
      matchesStarted: s.matchesStarted,
      matchesEnded: s.matchesEnded,
      avgDurationMs: s.durationN ? Math.round(s.totalDurationMs / s.durationN) : null,
      winnersByForm: s.winnersByForm,
      joins: s.joins,
      peakOnline: s.peakOnline,
      peakAt: s.peakAt,
      restarts: s.restarts,
    };
  }
}
