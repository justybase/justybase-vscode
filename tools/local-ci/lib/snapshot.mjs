import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runStep } from './exec.mjs';

// Generated output is never copied from the Windows checkout. Everything is
// rebuilt in the Linux snapshot, which also keeps Windows and Linux native
// modules from being mixed.
const SNAPSHOT_EXCLUDES = [
    'node_modules/',
    'dist/',
    'out/',
    'coverage/',
    '.nyc_output/',
    '_site/',
    'artifacts/',
    'marketplace-review/',
    '.vscode-test/',
    '.vscode-test-*/',
    '.cache/',
    'test-results/',
    'playwright-report/',
    'docs/.vitepress/dist/',
    'docs/.vitepress/cache/',
    'tools/access-ddl-compare/.clone/',
    'Benchmark/*.results.md',
    '*.vsix',
    '*.log',
    '.DS_Store',
    'Thumbs.db',
];

function withTrailingSlash(value) {
    return value.endsWith('/') ? value : `${value}/`;
}

function readHash(file) {
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch {
        return null;
    }
}

function hashFiles(baseDirectory, relativePaths) {
    const hash = crypto.createHash('sha256');
    for (const relativePath of [...relativePaths].sort()) {
        const absolutePath = path.join(baseDirectory, relativePath);
        if (!fs.existsSync(absolutePath)) continue;
        hash.update(relativePath);
        hash.update('\0');
        hash.update(fs.readFileSync(absolutePath));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function rootDependencyInputs(workDirectory) {
    const inputs = ['package.json', 'package-lock.json', '.npmrc'];

    const packagesDirectory = path.join(workDirectory, 'packages');
    if (fs.existsSync(packagesDirectory)) {
        for (const entry of fs.readdirSync(packagesDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            for (const fileName of ['package.json', 'package-lock.json']) {
                const relativePath = `packages/${entry.name}/${fileName}`;
                if (fs.existsSync(path.join(workDirectory, relativePath))) {
                    inputs.push(relativePath);
                }
            }
        }
    }

    return inputs.filter(relativePath => fs.existsSync(path.join(workDirectory, relativePath)));
}

function makeShellScriptsExecutable(rootDirectory) {
    const pending = [rootDirectory];
    while (pending.length > 0) {
        const directory = pending.pop();
        let entries;
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (entry.name === '.git' || entry.name === 'node_modules') continue;
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                pending.push(absolutePath);
                continue;
            }
            if (entry.isFile() && entry.name.endsWith('.sh')) {
                try {
                    fs.chmodSync(absolutePath, 0o755);
                } catch {
                    // Best effort only; permission bits are irrelevant on drvfs.
                }
            }
        }
    }
}

function removeGeneratedDirectories(rootDirectory) {
    const pending = [rootDirectory];
    while (pending.length > 0) {
        const directory = pending.pop();
        let entries;
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.clone') continue;
            const absolutePath = path.join(directory, entry.name);
            if (entry.name === 'dist' || entry.name === '_site') {
                fs.rmSync(absolutePath, { recursive: true, force: true });
                continue;
            }
            pending.push(absolutePath);
        }
    }
}

export async function prepareWorkspace(ctx) {
    for (const directory of [ctx.workDir, ctx.stateDir, ctx.outDir]) {
        fs.mkdirSync(directory, { recursive: true });
    }

    console.log('\n=== Local CI workspace ===');
    console.log(`Source (read-only): ${ctx.repoRoot}`);
    console.log(`Snapshot:           ${ctx.workDir}`);
    console.log(`State:              ${ctx.stateDir}`);
    console.log(`Outputs:            ${ctx.outDir}`);

    const rsyncArgs = ['-rlptD', '--delete', '--no-owner', '--no-group'];
    for (const pattern of SNAPSHOT_EXCLUDES) {
        rsyncArgs.push('--exclude', pattern);
    }
    rsyncArgs.push(withTrailingSlash(ctx.repoRoot), withTrailingSlash(ctx.workDir));

    await runStep(ctx, {
        name: 'Sync source checkout into the disposable snapshot',
        command: 'rsync',
        args: rsyncArgs,
        cwd: '/',
    });

    // Git for Windows config lives in the user's global config, which is not
    // present in the container. Recreate the two settings that matter so the
    // snapshot does not look dirty only because of CRLF or executable bits.
    await runStep(ctx, {
        name: 'Configure snapshot line endings',
        command: 'git',
        args: ['-C', ctx.workDir, 'config', 'core.autocrlf', 'true'],
        cwd: '/',
    });
    await runStep(ctx, {
        name: 'Configure snapshot file modes',
        command: 'git',
        args: ['-C', ctx.workDir, 'config', 'core.fileMode', 'false'],
        cwd: '/',
    });
    await runStep(ctx, {
        name: 'Trust source and snapshot repositories',
        command: 'git',
        args: ['config', '--global', '--add', 'safe.directory', '*'],
        cwd: '/',
    });

    makeShellScriptsExecutable(ctx.workDir);
    removeGeneratedDirectories(ctx.workDir);

    const head = spawnSync('git', ['-C', ctx.workDir, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
    });
    if (head.status === 0) {
        ctx.sourceHead = head.stdout.trim();
    }
}

export async function ensureRootDependencies(ctx, { force = false } = {}) {
    const nodeModulesDirectory = path.join(ctx.workDir, 'node_modules');
    const installMarker = path.join(nodeModulesDirectory, '.package-lock.json');

    if (ctx.options.skipDeps) {
        if (!fs.existsSync(installMarker)) {
            throw new Error('--skip-deps was requested, but the snapshot has no installed root node_modules.');
        }
        console.log('\n==> [setup] Root dependencies reused (--skip-deps)');
        return;
    }

    const marker = path.join(ctx.stateDir, 'root-deps.hash');
    const hash = hashFiles(ctx.workDir, rootDependencyInputs(ctx.workDir));

    if (!force && readHash(marker) === hash && fs.existsSync(installMarker)) {
        console.log('\n==> [setup] Root dependencies reused (lockfile unchanged)');
        return;
    }

    await runStep(ctx, {
        name: 'Install root dependencies (npm ci)',
        command: 'npm',
        args: ['ci'],
        cwd: ctx.workDir,
    });
    fs.writeFileSync(marker, `${hash}\n`);
}

export async function ensureAccessReference(ctx) {
    const scriptDirectory = path.join(ctx.workDir, 'tools', 'access-ddl-compare');
    const script = path.join(scriptDirectory, 'bootstrap.sh');
    if (!fs.existsSync(script)) {
        console.warn('warning: tools/access-ddl-compare/bootstrap.sh is missing; skipping the pinned Access reference.');
        return false;
    }

    // The host checkout uses CRLF on Windows while the snapshot is Linux.
    // Run a temporary LF copy from the same directory so BASH_SOURCE still
    // resolves the pinned clone location without modifying tracked files.
    const normalizedScript = path.join(scriptDirectory, '.bootstrap.local-ci.sh');
    const source = fs.readFileSync(script);
    fs.writeFileSync(
        normalizedScript,
        source.toString('utf8').replace(/\r\n/g, '\n'),
        { mode: 0o755 },
    );

    try {
        await runStep(ctx, {
            name: 'Bootstrap pinned Access index-code reference',
            command: 'bash',
            args: [normalizedScript],
            cwd: ctx.workDir,
        });
    } finally {
        fs.rmSync(normalizedScript, { force: true });
    }
    return true;
}

export async function ensureExtensionDependencies(ctx, name, { force = false } = {}) {
    const directory = path.join(ctx.workDir, 'extensions', name);
    const lockFile = path.join(directory, 'package-lock.json');

    if (!fs.existsSync(lockFile)) {
        console.log(`\n==> [setup] ${name} extension dependencies skipped (no package-lock.json)`);
        return false;
    }

    if (ctx.options.skipDeps) {
        if (!fs.existsSync(path.join(directory, 'node_modules'))) {
            throw new Error(`--skip-deps was requested, but extensions/${name}/node_modules is missing.`);
        }
        console.log(`\n==> [setup] ${name} extension dependencies reused (--skip-deps)`);
        return true;
    }

    const marker = path.join(ctx.stateDir, `extension-${name}.hash`);
    const hash = hashFiles(directory, ['package.json', 'package-lock.json']);

    if (
        !force
        && readHash(marker) === hash
        && fs.existsSync(path.join(directory, 'node_modules'))
    ) {
        console.log(`\n==> [setup] ${name} extension dependencies reused (lockfile unchanged)`);
        return true;
    }

    await runStep(ctx, {
        name: `Install ${name} extension dependencies (npm ci)`,
        command: 'npm',
        args: ['ci'],
        cwd: directory,
    });
    fs.writeFileSync(marker, `${hash}\n`);
    return true;
}
