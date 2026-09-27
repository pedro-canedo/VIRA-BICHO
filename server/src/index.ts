import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { OBS_INTERNAL_PORT } from './internal';

const PORT = Number(process.env.PORT ?? 3000);
/** Sem valor = todas as interfaces (LAN + túnel), como antes. */
const HOST = process.env.HOST || undefined;
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR ?? join(HERE, 'public'));
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const port = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
};
/** Endpoint interno do observador (sempre em 127.0.0.1). */
const OBS_PORT = port(process.env.OBS_INTERNAL_PORT, OBS_INTERNAL_PORT);
const OBS_TOKEN = process.env.OBS_INTERNAL_TOKEN;
// O segredo fica só na closure do servidor interno: fora do process.env (e de processos filhos).
delete process.env.OBS_INTERNAL_TOKEN;

const fatal = (origin: string, err: unknown) => {
  console.error(JSON.stringify({ t: Date.now(), ev: 'fatal', origin, err: String((err as Error)?.stack ?? err).slice(0, 2000) }));
  process.exit(1);
};

// O estado pode ter ficado inconsistente: sai e deixa o runit reiniciar.
process.on('uncaughtException', (err, origin) => fatal(origin, err));
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ t: Date.now(), ev: 'unhandled_rejection', err: String((reason as Error)?.stack ?? reason).slice(0, 2000) }));
});

const app = createApp({
  publicDir: PUBLIC_DIR,
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),
  trustedKeys: list(process.env.VB_TRUSTED_IPS),
  obs: { token: OBS_TOKEN },
});

// Erro antes de ouvir (EADDRINUSE etc.): sem sair, os timers manteriam vivo um processo sem porta.
const onBootError = (err: Error) => fatal('listen', err);
app.server.once('error', onBootError);
const onListening = () => {
  app.server.off('error', onBootError);
  console.log(`VIRA-BICHO ouvindo em ${HOST ?? '*'}:${PORT} (arquivos em ${PUBLIC_DIR})`);
  // Opcional: se a porta interna estiver ocupada, o jogo segue no ar e o endpoint tenta de novo a cada 30 s.
  app.serveInternal(OBS_PORT);
};
if (HOST) app.server.listen(PORT, HOST, onListening);
else app.server.listen(PORT, onListening);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 2000).unref();
  for (const ws of app.wss.clients) ws.close(1012, 'reiniciando');
  // Dá um instante para os frames de fechamento saírem antes de derrubar tudo.
  setTimeout(() => void app.close().finally(() => process.exit(0)), 300);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
