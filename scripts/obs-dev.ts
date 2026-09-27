// Painel de observabilidade em desenvolvimento, sem o jogo real:
// sobe o servidor falso do contrato (com atividade simulada) e o observador lendo observer/public.
//   npm run dev:obs   → http://localhost:3001  (token: OBS_TOKEN ou "dev-token-vira-bicho")
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../observer/src/config';
import { Observer } from '../observer/src/observer';
import { createObsServer } from '../observer/src/server';
import { startFakeGame } from '../tests/helpers/fake-game';

const TOKEN = process.env.OBS_TOKEN || 'dev-token-vira-bicho';
const INTERNAL = 'dev-internal';
const game = await startFakeGame(INTERNAL, Number(process.env.FAKE_GAME_PORT ?? 0));

const cfg = loadConfig({
  ...process.env,
  OBS_TOKEN: TOKEN,
  OBS_INTERNAL_TOKEN: INTERNAL,
  GAME_INTERNAL_URL: game.url,
  PUBLIC_URL: `${game.url}/health`,
  OBS_DATA_DIR: process.env.OBS_DATA_DIR || join(tmpdir(), 'vira-bicho-obs-dev'),
  OBS_PUBLIC_DIR: 'observer/public',
});
cfg.intervals.publicCheck = 10_000;

const obs = new Observer(cfg);
await obs.init();
const { server } = createObsServer(obs, { token: TOKEN, publicDir: cfg.publicDir, sessionFile: join(cfg.dataDir, 'sessions.json') });
server.listen(cfg.port, () => {
  console.log(`observador de desenvolvimento em http://localhost:${cfg.port}  (token: ${TOKEN})`);
  console.log(`jogo falso em ${game.url} · dados em ${cfg.dataDir}`);
  obs.start();
});
process.on('SIGINT', () => {
  void obs.stop().then(() => process.exit(0));
});

// ---------- atividade simulada ----------
const NAMES = ['Tatu', 'Capivara', 'Jabuti', 'Sagui', 'Mico', 'Boto', 'Onça', '<img src=x onerror=alert(1)>', 'Quati'];
const FORMS = ['brasa', 'mare', 'broto', 'vapor', 'cinza', 'mangue', 'quimera'];
const COUNTRIES = ['BR', 'BR', 'BR', 'BR', 'PT', 'US', 'AR'];
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];

setInterval(() => {
  const s = game.stats;
  const online = Math.max(0, s.players.online + Math.round((Math.random() - 0.45) * 3));
  const playing = Math.min(online, Math.round(online * 0.6));
  const spectating = Math.min(online - playing, Math.round(Math.random()));
  s.players = { online, playing, spectating, lobby: online - playing - spectating };
  s.connections.open = online;
  s.process.cpuPct = Math.round((5 + Math.random() * 20) * 10) / 10;
  s.process.rssMB = Math.round(70 + online * 2 + Math.random() * 5);
  s.process.eventLoopLagMs = { p50: 1 + Math.random(), p99: 4 + Math.random() * 10, max: 20 + Math.random() * 30 };
  s.process.tickMs = { p50: 1.5, p99: 3 + Math.random() * 5, max: 12 };
  const mobile = Math.round(online * 0.7);
  s.breakdown = { countries: { BR: Math.max(0, online - 2), PT: Math.min(online, 1), US: Math.min(Math.max(online - 1, 0), 1) }, devices: { mobile, desktop: online - mobile } };
  for (const r of s.rooms) r.elapsedMs += 2_000;
  if (Math.random() < 0.3) {
    const room = pick(s.rooms).code;
    s.counters.joins++;
    game.emit('join', { name: pick(NAMES), mode: pick(['publica', 'privada']), room, country: pick(COUNTRIES), device: pick(['mobile', 'desktop']) });
  }
  if (Math.random() < 0.15) game.emit('leave', { name: pick(NAMES), room: pick(s.rooms).code, reason: pick(['fechou', 'eliminado', 'timeout']), inMatch: Math.random() < 0.5 });
  if (Math.random() < 0.08) {
    s.counters.matchesEnded++;
    game.emit('match_end', { room: 'ABCD', winner: pick(NAMES), form: pick(FORMS), durationMs: 240_000 + Math.random() * 90_000, humans: 3 });
    game.emit('match_start', { room: 'ABCD', humans: 3, bots: 5, players: 8 });
    s.counters.matchesStarted++;
    s.rooms[0].elapsedMs = 0;
  }
  if (Math.random() < 0.05) game.emit('duel', { room: 'ABCD', a: pick(NAMES), b: pick(NAMES) });
  if (Math.random() < 0.03) {
    s.counters.rateLimited++;
    game.emit('security', { kind: pick(['rate_limit', 'origin', 'too_many_conns']), ipHash: Math.random().toString(16).slice(2, 10), detail: 'simulado' });
  }
}, 2_000);
