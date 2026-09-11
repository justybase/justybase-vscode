import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname);
const dist = path.join(root, 'dist');

await build({
  entryPoints: [path.join(root, 'src/main/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: path.join(dist, 'main/main.js'),
  sourcemap: true,
});
await build({
  entryPoints: [path.join(root, 'src/preload/preload.ts')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  external: ['electron'],
  outfile: path.join(dist, 'preload/preload.js'),
  sourcemap: true,
});
await build({
  entryPoints: [path.join(root, 'src/renderer/main.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: path.join(dist, 'renderer/renderer.js'),
  sourcemap: true,
});
fs.mkdirSync(path.join(dist, 'renderer'), { recursive: true });
fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(dist, 'renderer/index.html'));
