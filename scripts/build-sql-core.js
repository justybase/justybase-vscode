const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const packageRoot = path.join(root, 'packages/sql-core');
const outputRoot = path.join(packageRoot, 'dist');
fs.mkdirSync(outputRoot, { recursive: true });

const entries = [
  {
    source: path.join(packageRoot, 'src/runtime.ts'),
    output: path.join(outputRoot, 'index.js'),
    declaration: 'index.d.ts',
  },
  {
    source: path.join(packageRoot, 'src/validation.ts'),
    output: path.join(outputRoot, 'validation.js'),
    declaration: 'validation.d.ts',
  },
];

for (const entry of entries) {
  esbuild.buildSync({
    entryPoints: [entry.source],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: entry.output,
    external: [
      '@justybase/contracts',
      'vscode',
      'vscode-languageserver',
      'vscode-languageserver/node',
      'vscode-languageserver-textdocument',
    ],
    sourcemap: true,
  });
  fs.copyFileSync(
    path.join(packageRoot, 'src', entry.declaration),
    path.join(outputRoot, entry.declaration),
  );
}
