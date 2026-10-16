const esbuild = require('esbuild');

// Marketplace artifacts stay reviewable; minification is opt-in.
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
        external: ['vscode'],
        logLevel: 'info'
    });

    if (process.argv.includes('--watch')) {
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
