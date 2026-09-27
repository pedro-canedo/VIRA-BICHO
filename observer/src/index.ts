// vira-bicho-obs: observabilidade do VIRA-BICHO (serviço separado, porta OBS_PORT).
import { join } from 'node:path';
import { loadConfig } from './config';
import { Observer } from './observer';
import { createObsServer } from './server';

const cfg = loadConfig();
if (cfg.token.length < 16) {
  console.error('[obs] OBS_TOKEN ausente ou curto demais (mínimo 16 caracteres). Veja ~/.config/vira-bicho/secrets.env.');
  process.exit(1);
}
if (!cfg.internalToken) console.error('[obs] aviso: OBS_INTERNAL_TOKEN vazio; o jogo vai recusar a coleta.');

process.on('unhandledRejection', (err) => {
  console.error('[obs] promessa rejeitada sem tratamento:', err instanceof Error ? err.stack : err);
});
process.on('uncaughtException', (err) => {
  console.error('[obs] exceção não tratada, saindo:', err.stack ?? err.message);
  process.exit(1);
});

const obs = new Observer(cfg);
await obs.init();
const { server, closeStreams } = createObsServer(obs, {
  token: cfg.token,
  publicDir: cfg.publicDir,
  sessionFile: join(cfg.dataDir, 'sessions.json'),
});

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(`[obs] não foi possível escutar em ${cfg.host}:${cfg.port}: ${err.code ?? err.message}`);
  // Espera um pouco antes de sair: com a porta ocupada, o runit reiniciaria a cada segundo e encheria o log.
  setTimeout(() => process.exit(1), 10_000).unref();
  void obs.stop();
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`[obs] painel em http://${cfg.host}:${cfg.port} · jogo ${cfg.gameUrl} · dados em ${cfg.dataDir}`);
  obs.start();
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[obs] ${signal}: salvando e encerrando`);
  // Se a gravação travar no disco, sai assim mesmo (o sv restart não fica esperando para sempre).
  setTimeout(() => {
    console.error('[obs] encerramento demorou demais; saindo sem terminar de salvar');
    process.exit(1);
  }, 5_000).unref();
  closeStreams();
  server.close();
  await obs.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
