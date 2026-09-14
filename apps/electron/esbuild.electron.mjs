import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname);
const repositoryRoot = path.resolve(root, '../..');
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
  entryPoints: [path.join(root, 'src/preload/credentialPromptPreload.ts')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  external: ['electron'],
  outfile: path.join(dist, 'preload/credentialPromptPreload.js'),
  sourcemap: true,
});
await build({
  entryPoints: [path.join(root, 'src/renderer/main.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: path.join(dist, 'renderer/renderer.js'),
  sourcemap: true,
  alias: {
    '@justybase/dockyard-layout': path.join(repositoryRoot, 'packages/dockyard-layout/src/index.ts'),
    'avalondock-web': path.join(repositoryRoot, 'vendor/dockyard/src/index.js'),
  },
});
fs.mkdirSync(path.join(dist, 'renderer'), { recursive: true });
fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(dist, 'renderer/index.html'));
