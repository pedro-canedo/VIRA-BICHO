import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OBS_INTERNAL_DEFAULT_URL } from '../../shared/src/obs';

export interface ObsConfig {
  port: number;
  host: string;
  /** Senha do painel (login e Authorization: Bearer). */
  token: string;
  /** Segredo compartilhado com o jogo (cabeçalho x-obs-token). */
  internalToken: string;
  gameUrl: string;
  publicUrl: string;
  dataDir: string;
  publicDir: string;
  /** Diretório dos serviços runit (null = não verifica). */
  serviceDir: string | null;
  procRoot: string;
  sysRoot: string;
  /** Intervalos em ms. */
  intervals: {
    poll: number;
    sample: number;
    services: number;
    publicCheck: number;
    persist: number;
  };
  /** Timeout das consultas ao jogo. */
  pollTimeoutMs: number;
  publicTimeoutMs: number;
  /** Janela das séries (24 h). */
  seriesWindowMs: number;
  /** Dias de NDJSON mantidos em disco. */
  keepDays: number;
}

type Env = Record<string, string | undefined>;

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Pasta com index.html/app.js/app.css: dist/obs-public no build, observer/public em desenvolvimento. */
function findPublicDir(env: Env): string {
  if (env.OBS_PUBLIC_DIR) return resolve(env.OBS_PUBLIC_DIR);
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'obs-public'), join(here, '..', 'public')];
  return candidates.find((d) => existsSync(join(d, 'index.html'))) ?? candidates[0];
}

export function loadConfig(env: Env = process.env): ObsConfig {
  const prefix = env.PREFIX;
  const svDefault = prefix ? join(prefix, 'var', 'service') : null;
  return {
    port: int(env.OBS_PORT, 3001),
    host: env.OBS_HOST || '0.0.0.0',
    token: env.OBS_TOKEN ?? '',
    internalToken: env.OBS_INTERNAL_TOKEN ?? '',
    gameUrl: (env.GAME_INTERNAL_URL || OBS_INTERNAL_DEFAULT_URL).replace(/\/+$/, ''),
    publicUrl: env.PUBLIC_URL || 'https://batllebicho.caixazen.online/health',
    dataDir: resolve(env.OBS_DATA_DIR || join(homedir(), 'apps', 'vira-bicho-obs', 'data')),
    publicDir: findPublicDir(env),
    serviceDir: env.OBS_SERVICE_DIR === '' ? null : (env.OBS_SERVICE_DIR ?? svDefault),
    procRoot: env.OBS_PROC_ROOT || '/proc',
    sysRoot: env.OBS_SYS_ROOT || '/sys',
    intervals: {
      poll: 2_000,
      sample: 5_000,
      services: 30_000,
      publicCheck: 60_000,
      persist: 60_000,
    },
    pollTimeoutMs: 1_500,
    publicTimeoutMs: 10_000,
    seriesWindowMs: 24 * 3600_000,
    keepDays: 7,
  };
}
