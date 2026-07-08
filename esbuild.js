const esbuild = require('esbuild');
const fs = require('fs');

const production = process.argv.includes('--production');

async function main() {
  // Main extension bundle
  const extensionCtx = await esbuild.context({
    entryPoints: ['./src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: true,
    platform: 'node',
    outfile: 'dist/extension.js',
    // snappyjs is pure JS and must be bundled — VSIX is packaged with --no-dependencies.
    external: ['vscode'],
    logLevel: 'info',
  });

  // Webview scripts bundle (IIFE — these do NOT need to export)
  const webviewEntryPoints = [
    './media/resultPanel.ts',
    './media/resultPanel/filter.ts',
    './media/resultPanel/grid.ts',
    './media/resultPanel/selection.ts',
    './media/searchWorker.ts',
    './media/editDataPanel.ts',
    './media/queryHistory.ts',
    './media/queryHistoryExtended.ts',
    './media/sessionMonitor.ts',
    './media/securityPanel.ts',
    './media/importWizard.ts',
    './media/visualQueryBuilder.ts',
    './media/tableDesigner.ts',
    './media/explainPlanGraph.ts',
    './media/testDataGenerator.ts'
  ].filter(f => fs.existsSync(f));

  const webviewCtx = await esbuild.context({
    entryPoints: webviewEntryPoints,
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    platform: 'browser',
    outdir: 'dist/media',
    logLevel: 'info',
  });

  // Language server bundle
  const serverCtx = await esbuild.context({
    entryPoints: ['./src/server/main.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    platform: 'node',
    outfile: 'dist/server/main.js',
    external: ['vscode'],
    logLevel: 'info',
  });

  // Metadata disk compression worker (off main extension host thread)
  const metadataWorkerCtx = await esbuild.context({
    entryPoints: ['./src/metadata/diskStorage/metadataDiskCompress.worker.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    platform: 'node',
    outfile: 'dist/metadataDiskCompress.worker.js',
    external: ['vscode'],
    logLevel: 'info',
  });

  const watch = process.argv.includes('--watch');

  if (watch) {
    await Promise.all([
      extensionCtx.watch(),
      webviewCtx.watch(),
      serverCtx.watch(),
      metadataWorkerCtx.watch(),
    ]);
  } else {
    await Promise.all([
      extensionCtx.rebuild(),
      webviewCtx.rebuild(),
      serverCtx.rebuild(),
      metadataWorkerCtx.rebuild(),
    ]);
    await Promise.all([
      extensionCtx.dispose(),
      webviewCtx.dispose(),
      serverCtx.dispose(),
      metadataWorkerCtx.dispose(),
    ]);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
