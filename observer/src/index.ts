// vira-bicho-obs: observabilidade do VIRA-BICHO (serviço separado, porta OBS_PORT).
import { loadConfig } from './config';
import { Observer } from './observer';
import { createObsServer } from './server';

const cfg = loadConfig();
if (cfg.token.length < 16) {
  console.error('[obs] OBS_TOKEN ausente ou curto demais (mínimo 16 caracteres). Veja ~/.config/vira-bicho/secrets.env.');
  process.exit(1);
}
if (!cfg.internalToken) console.error('[obs] aviso: OBS_INTERNAL_TOKEN vazio; o jogo vai recusar a coleta.');

const obs = new Observer(cfg);
await obs.init();
const { server, closeStreams } = createObsServer(obs, { token: cfg.token, publicDir: cfg.publicDir });

server.listen(cfg.port, cfg.host, () => {
  console.log(`[obs] painel em http://${cfg.host}:${cfg.port} · jogo ${cfg.gameUrl} · dados em ${cfg.dataDir}`);
  obs.start();
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[obs] ${signal}: salvando e encerrando`);
  closeStreams();
  server.close();
  await obs.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
