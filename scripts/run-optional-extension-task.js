#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
    getOptionalExtension,
    optionalExtensionExists,
    repoRoot
} = require('./optional-extensions');

const eslintExecutable = path.join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
const tscExecutable = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

function fail(message) {
    console.error(message);
    process.exit(1);
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        stdio: 'inherit',
        ...options
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function resolveNpmInvocation() {
    if (process.platform !== 'win32') {
        return { command: 'npm', prefixArgs: [] };
    }

    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath && fs.existsSync(npmExecPath) && npmExecPath.toLowerCase().endsWith('npm-cli.js')) {
        return {
            command: process.execPath,
            prefixArgs: [npmExecPath]
        };
    }

    const whereResult = spawnSync('where.exe', ['npm.cmd'], {
        cwd: repoRoot,
        encoding: 'utf8'
    });
    if (whereResult.status === 0) {
        const resolvedPath = whereResult.stdout
            .split(/\r?\n/)
            .map(line => line.trim())
            .find(Boolean);
        if (resolvedPath) {
            return {
                command: resolvedPath,
                prefixArgs: []
            };
        }
    }

    return {
        command: 'npm.cmd',
        prefixArgs: []
    };
}

function ensureExtensionAvailable(extension, action) {
    if (optionalExtensionExists(extension)) {
        return true;
    }

    const relativeDir = path.relative(repoRoot, extension.directory);
    console.log(`Skipping ${extension.marketplaceName} ${action}: ${relativeDir} is not present in this checkout.`);
    return false;
}

function requirePath(targetPath, description) {
    if (!fs.existsSync(targetPath)) {
        fail(`Missing ${description}: ${path.relative(repoRoot, targetPath)}`);
    }
}

function buildNpmRunArgs(scriptName, extraArgs) {
    return extraArgs.length > 0
        ? ['run', scriptName, '--', ...extraArgs]
        : ['run', scriptName];
}

function runAction(extension, action, extraArgs) {
    if (!ensureExtensionAvailable(extension, action)) {
        return;
    }

    const npmInvocation = resolveNpmInvocation();

    switch (action) {
        case 'install':
            requirePath(extension.packageJson, `${extension.marketplaceName} package manifest`);
            if (extension.id === 'db2') {
                run(
                    npmInvocation.command,
                    [...npmInvocation.prefixArgs, ...buildNpmRunArgs('install:vscode', extraArgs)],
                    { cwd: extension.directory }
                );
                return;
            }

            run(npmInvocation.command, [...npmInvocation.prefixArgs, 'install', ...extraArgs], { cwd: extension.directory });
            return;
        case 'lint':
            requirePath(eslintExecutable, 'root eslint executable');
            requirePath(extension.srcDir, `${extension.marketplaceName} source directory`);
            run(process.execPath, [eslintExecutable, extension.srcDir, '--ext', '.ts']);
            return;
        case 'check-types':
            requirePath(tscExecutable, 'root TypeScript executable');
            requirePath(extension.tsconfig, `${extension.marketplaceName} tsconfig`);
            run(process.execPath, [tscExecutable, '--project', extension.tsconfig, '--noEmit']);
            return;
        case 'build':
            requirePath(extension.packageJson, `${extension.marketplaceName} package manifest`);
            run(
                npmInvocation.command,
                [...npmInvocation.prefixArgs, ...buildNpmRunArgs('build', extraArgs)],
                { cwd: extension.directory }
            );
            return;
        case 'package':
            requirePath(extension.packageJson, `${extension.marketplaceName} package manifest`);
            run(
                npmInvocation.command,
                [...npmInvocation.prefixArgs, ...buildNpmRunArgs('package', extraArgs)],
                { cwd: extension.directory }
            );
            return;
        case 'verify':
            runAction(extension, 'lint', []);
            runAction(extension, 'check-types', []);
            runAction(extension, 'build', []);
            return;
        default:
            fail(`Unsupported action "${action}". Expected one of: install, lint, check-types, build, package, verify.`);
    }
}

function main() {
    const [extensionId, action, ...extraArgs] = process.argv.slice(2);

    if (!extensionId || !action) {
        fail(
            'Usage: node scripts/run-optional-extension-task.js <db2|duckdb|oracle|postgresql|vertica|snowflake|mssql|mysql> ' +
                '<install|lint|check-types|build|package|verify> [extra args]'
        );
    }

    const extension = getOptionalExtension(extensionId);
    if (!extension) {
        fail(`Unknown optional extension "${extensionId}".`);
    }

    runAction(extension, action, extraArgs);
}

main();
