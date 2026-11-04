import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

await build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: ['src/main/preload.ts'],
  outfile: 'dist/main/preload.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: ['src/renderer/renderer.ts'],
  outfile: 'dist/renderer/renderer.js',
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
});

cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
// ikona aplikacji (ta sama co na pasku tytułu): okno, pasek tytułu i instalator
cpSync('assets/icon.png', 'dist/renderer/icon.png');
cpSync('assets/icon.ico', 'dist/renderer/icon.ico');
