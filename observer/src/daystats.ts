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

export class DayAggregator {
  stats: DayStats;

  constructor(now = Date.now(), restored?: DayStats | null) {
    const today = dayKey(now);
    this.stats = restored && restored.day === today ? { ...emptyDay(today), ...restored } : emptyDay(today);
  }

  private roll(t: number): boolean {
    const k = dayKey(t);
    if (k === this.stats.day) return true;
    if (k < this.stats.day) return false; // evento de ontem chegando atrasado
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
        if (Object.hasOwn(s.winnersByForm, form) || Object.keys(s.winnersByForm).length < 32) {
          s.winnersByForm[form] = (s.winnersByForm[form] ?? 0) + 1;
        }
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
    if (!this.roll(t)) return;
    if (online > this.stats.peakOnline || this.stats.peakAt === null) {
      this.stats.peakOnline = online;
      this.stats.peakAt = t;
    }
  }

  view(now = Date.now()) {
    this.roll(now);
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
