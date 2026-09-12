import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

await esbuild.build({
  entryPoints: [path.join(repositoryRoot, 'test-harness/shared-data-grid.tsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  outfile: path.join(repositoryRoot, 'dist/test-harness/shared-data-grid.js'),
  sourcemap: false,
  minify: false,
  loader: { '.css': 'css' },
  logLevel: 'info',
});
