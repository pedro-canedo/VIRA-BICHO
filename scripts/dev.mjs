// Sobe o servidor (tsx watch, porta 3000) e o Vite (porta 5173, com proxy do WebSocket).
import { spawn } from 'node:child_process';

const procs = [
  spawn('npx', ['tsx', 'watch', 'server/src/index.ts'], { stdio: 'inherit', env: { ...process.env, PUBLIC_DIR: 'client' } }),
  spawn('npx', ['vite', '--config', 'client/vite.config.ts'], { stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
