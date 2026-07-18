const esbuild = require('esbuild');

// Marketplace artifacts must stay reviewable. Minification is opt-in and is
// intentionally not used by the packaging or release scripts.
const minify = process.argv.includes('--minify');

/**
 * DB2CODEPAGE UTF-8 Banner - Layer 1 of Defense-in-Depth Strategy
 * ================================================================
 * This banner is injected at the VERY TOP of the bundled extension.js file,
 * ensuring DB2CODEPAGE=1208 (UTF-8) is set before any module code runs.
 *
 * This is the PRIMARY mechanism for packaged extensions. See extension.ts
 * for full documentation of the layered strategy:
 *   Layer 1: esbuild.db2.js banner (THIS FILE - first for packaged extensions)
 *   Layer 2: .vscode/launch.json env (for F5 debug sessions)
 *   Layer 3: extension.ts module-level check (fallback)
 *   Layer 4: db2Connection.ts ensureClidriverOnPath() (runtime fallback)
 *
 * The IBM CLI driver reads DB2CODEPAGE during initialization, so it must be
 * set before the ibm_db module is loaded or any connection is established.
 */
const DB2CODEPAGE_BANNER = `
// DB2CODEPAGE=1208 (UTF-8) - Layer 1: esbuild banner (PRIMARY for packaged extensions)
// See extension.ts for full documentation of the defense-in-depth strategy.
if (!process.env.DB2CODEPAGE) {
  process.env.DB2CODEPAGE = '1208';
}
`;

async function main() {
    const context = await esbuild.context({
        entryPoints: ['./src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify,
        sourcemap: true,
        sourcesContent: true,
        platform: 'node',
        outfile: 'dist/extension.js',
        external: ['vscode', 'ibm_db'],
        logLevel: 'info',
        banner: {
            js: DB2CODEPAGE_BANNER
        }
    });

    const watch = process.argv.includes('--watch');

    if (watch) {
        await context.watch();
        return;
    }

    await context.rebuild();
    await context.dispose();
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
