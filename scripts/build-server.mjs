// Empacota o servidor num único arquivo ESM, sem dependências para instalar no celular.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// Versão reportada ao observador: a do package.json mais o commit (e "-dirty" com alterações locais).
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let version = String(pkg.version ?? '0.0.0');
try {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const sha = git('rev-parse', '--short', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
  if (sha) version += `+${sha}${dirty ? '-dirty' : ''}`;
} catch {
  // sem git: só a versão do package.json
}

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
  define: { __VB_VERSION__: JSON.stringify(version.slice(0, 40)) },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
console.log(`servidor empacotado em dist/server.mjs (versão ${version})`);
