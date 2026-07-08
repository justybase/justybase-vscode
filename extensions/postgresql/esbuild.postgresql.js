const esbuild = require('esbuild');

const production = process.argv.includes('--production');

async function main() {
    const context = await esbuild.context({
        entryPoints: ['./src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: true,
        platform: 'node',
        outfile: 'dist/extension.js',
        external: ['vscode', 'pg'],
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
