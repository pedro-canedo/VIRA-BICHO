// Empacota o observador (vira-bicho-obs) num único arquivo ESM e copia o painel estático.
// Nenhuma dependência de runtime: só módulos do Node. O celular recebe dist/obs.mjs + dist/obs-public/.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

await build({
  entryPoints: ['observer/src/index.ts'],
  outfile: 'dist/obs.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
});

rmSync('dist/obs-public', { recursive: true, force: true });
mkdirSync('dist/obs-public', { recursive: true });
for (const f of ['index.html', 'login.html', 'app.js', 'view.js', 'app.css', 'favicon.svg']) {
  cpSync(`observer/public/${f}`, `dist/obs-public/${f}`);
}
console.log('observador empacotado em dist/obs.mjs (+ dist/obs-public/)');
