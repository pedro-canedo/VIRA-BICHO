// Empacota o servidor num único arquivo ESM, sem dependências para instalar no celular.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/src/index.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  // Opcionais do ws (aceleradores nativos): ficam de fora.
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
console.log('servidor empacotado em dist/server.mjs');
