const esbuild = require('esbuild');

const minify = process.argv.includes('--minify');

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
        external: ['vscode', 'mysql2', 'mysql2/promise'],
        logLevel: 'info'
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
