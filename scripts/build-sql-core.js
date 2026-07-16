const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'packages/sql-core/src/runtime.ts');
const output = path.join(root, 'packages/sql-core/dist/index.js');
fs.mkdirSync(path.dirname(output), { recursive: true });

esbuild.buildSync({
  entryPoints: [source],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: output,
  external: ['@justybase/contracts', 'chevrotain', 'vscode', 'vscode-languageserver', 'vscode-languageserver-textdocument'],
  sourcemap: true,
});
fs.copyFileSync(path.join(root, 'packages/sql-core/src/index.d.ts'), path.join(root, 'packages/sql-core/dist/index.d.ts'));
