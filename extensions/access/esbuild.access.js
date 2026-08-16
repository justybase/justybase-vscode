const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const minify = process.argv.includes('--minify');
const ACCESS_TEMPLATE_NAMES = ['empty.mdb', 'empty2007.accdb', 'empty2010.accdb', 'empty2016.accdb'];

function syncAccessTemplates() {
    const sourceDirectory = path.resolve(__dirname, '..', '..', 'packages', 'access-file', 'resources');
    const targetDirectory = path.resolve(__dirname, 'resources');
    fs.mkdirSync(targetDirectory, { recursive: true });

    for (const templateName of ACCESS_TEMPLATE_NAMES) {
        const sourcePath = path.join(sourceDirectory, templateName);
        const targetPath = path.join(targetDirectory, templateName);
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Missing Access template: ${sourcePath}`);
        }
        fs.copyFileSync(sourcePath, targetPath);
    }
}

async function main() {
    syncAccessTemplates();
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
