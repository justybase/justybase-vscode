const esbuild = require('esbuild');
const fs = require('fs');

// Marketplace artifacts must stay reviewable. Minification is opt-in and is
// intentionally not used by the packaging or release scripts.
const minify = process.argv.includes('--minify');

async function main() {
  // These libraries are loaded as globals by several webviews. Build them from
  // their published ESM sources instead of shipping upstream production/minified
  // UMD files, so Marketplace artifacts stay readable and source-mapped.
  const tanStackTableCtx = await esbuild.context({
    entryPoints: ['./node_modules/@tanstack/table-core/build/lib/index.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'TableCore',
    minify,
    sourcemap: true,
    sourcesContent: true,
    platform: 'browser',
    outfile: 'media/tanstack-table-core.js',
    logLevel: 'info',
  });

  const tanStackVirtualCtx = await esbuild.context({
    entryPoints: ['./node_modules/@tanstack/virtual-core/dist/esm/index.js'],
    bundle: true,
    format: 'iife',
    globalName: 'VirtualCore',
    minify,
    sourcemap: true,
    sourcesContent: true,
    platform: 'browser',
    outfile: 'media/tanstack-virtual-core.js',
    logLevel: 'info',
  });

  // Main extension bundle
  const extensionCtx = await esbuild.context({
    entryPoints: ['./src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify,
    sourcemap: true,
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
    minify,
    sourcemap: true,
    sourcesContent: true,
    platform: 'browser',
    outdir: 'dist/media',
    logLevel: 'info',
  });

  // Language server bundle
  const serverCtx = await esbuild.context({
    entryPoints: ['./src/server/main.ts'],
    bundle: true,
    format: 'cjs',
    minify,
    sourcemap: true,
    sourcesContent: true,
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
    minify,
    sourcemap: true,
    sourcesContent: true,
    platform: 'node',
    outfile: 'dist/metadataDiskCompress.worker.js',
    external: ['vscode'],
    logLevel: 'info',
  });

  const watch = process.argv.includes('--watch');

  if (watch) {
    await Promise.all([
      tanStackTableCtx.watch(),
      tanStackVirtualCtx.watch(),
      extensionCtx.watch(),
      webviewCtx.watch(),
      serverCtx.watch(),
      metadataWorkerCtx.watch(),
    ]);
  } else {
    await Promise.all([
      tanStackTableCtx.rebuild(),
      tanStackVirtualCtx.rebuild(),
      extensionCtx.rebuild(),
      webviewCtx.rebuild(),
      serverCtx.rebuild(),
      metadataWorkerCtx.rebuild(),
    ]);
    await Promise.all([
      tanStackTableCtx.dispose(),
      tanStackVirtualCtx.dispose(),
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
