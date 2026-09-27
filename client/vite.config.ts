import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  build: {
    outDir: fileURLToPath(new URL('../dist/public', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/health': 'http://localhost:3000',
    },
  },
});
