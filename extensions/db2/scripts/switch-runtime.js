#!/usr/bin/env node
// @ts-check

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DB2_EXT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DB2_EXT_ROOT, '..', '..');
const REBUILD_ELECTRON_SCRIPT = path.join(__dirname, 'rebuild-electron.js');
const IBM_DB_PACKAGE_DIR = path.join(DB2_EXT_ROOT, 'node_modules', 'ibm_db');
const CLIDRIVER_HOME = path.join(IBM_DB_PACKAGE_DIR, 'installer', 'clidriver');
const REQUIRED_DB2_LIVE_ENV = [
    'DB2_LIVE_TEST_HOST',
    'DB2_LIVE_TEST_DATABASE',
    'DB2_LIVE_TEST_USER',
    'DB2_LIVE_TEST_PASSWORD'
];

function printUsage() {
    console.log(
        'Usage:\n' +
        '  node scripts/switch-runtime.js node\n' +
        '  node scripts/switch-runtime.js electron [--electron <version> | --vscode-dir <path>]\n' +
        '  node scripts/switch-runtime.js with-node-runtime [electron rebuild args] -- <command> [args]\n' +
        '  node scripts/switch-runtime.js auto-for-live-tests [electron rebuild args] -- <command> [args]\n' +
        '\n' +
        'Commands:\n' +
        '  node                Rebuild ibm_db for the current Node/Jest runtime.\n' +
        '  electron            Rebuild ibm_db for the VS Code Electron/F5 runtime.\n' +
        '  with-node-runtime   Temporarily switch to Node, run a command, then restore Electron.\n' +
        '  auto-for-live-tests Same as with-node-runtime, but only when full DB2 live-test env is present.\n' +
        '\n' +
        'Optional env overrides for Electron restore:\n' +
        '  DB2_RUNTIME_VSCODE_DIR\n' +
        '  DB2_RUNTIME_ELECTRON_VERSION\n'
    );
}

/**
 * @param {string} message
 * @param {number} [exitCode=1]
 */
function fail(message, exitCode = 1) {
    if (message) {
        console.error(message);
    }

    process.exit(exitCode);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [options={}]
 */
function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        ...options
    });

    if (result.error) {
        throw result.error;
    }

    return result.status ?? 1;
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
        cwd: REPO_ROOT,
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

/**
 * @param {string | undefined} clidriverPath
 */
function isValidClidriverHome(clidriverPath) {
    if (!clidriverPath || !fs.existsSync(clidriverPath)) {
        return false;
    }

    if (!fs.existsSync(path.join(clidriverPath, 'include', 'sqlcli1.h'))) {
        return false;
    }

    if (process.platform === 'win32') {
        return fs.existsSync(path.join(clidriverPath, 'bin', 'db2cli64.dll'));
    }

    if (process.platform === 'linux') {
        return fs.existsSync(path.join(clidriverPath, 'bin', 'db2cli'))
            || fs.existsSync(path.join(clidriverPath, 'lib', 'libdb2.so'));
    }

    if (process.platform === 'darwin') {
        return fs.existsSync(path.join(clidriverPath, 'bin', 'db2cli'))
            || fs.existsSync(path.join(clidriverPath, 'lib', 'libdb2.dylib'));
    }

    return false;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} envName
 * @param {string} dir
 */
function prependPathEntry(env, envName, dir) {
    if (!fs.existsSync(dir)) {
        return;
    }

    const separator = path.delimiter;
    const currentValue = env[envName] || '';
    const values = currentValue.split(separator).filter(Boolean);
    if (values.includes(dir)) {
        return;
    }

    env[envName] = [dir, ...values].join(separator);
}

/**
 * @param {Record<string, string | undefined>} baseEnv
 * @returns {Record<string, string | undefined>}
 */
function configureClidriverEnvironment(baseEnv) {
    const env = { ...baseEnv };
    prependPathEntry(env, 'PATH', path.dirname(process.execPath));

    if (!isValidClidriverHome(CLIDRIVER_HOME)) {
        return env;
    }

    env.IBM_DB_HOME = CLIDRIVER_HOME;
    prependPathEntry(env, 'PATH', path.join(CLIDRIVER_HOME, 'bin'));
    prependPathEntry(env, 'PATH', path.join(CLIDRIVER_HOME, 'lib'));

    if (process.platform === 'linux') {
        prependPathEntry(env, 'LD_LIBRARY_PATH', path.join(CLIDRIVER_HOME, 'lib'));
    } else if (process.platform === 'darwin') {
        prependPathEntry(env, 'DYLD_LIBRARY_PATH', path.join(CLIDRIVER_HOME, 'lib'));
    }

    return env;
}

function ensureIbmDbInstalled() {
    if (fs.existsSync(IBM_DB_PACKAGE_DIR)) {
        return;
    }

    console.log('ibm_db is missing in extensions\\db2. Installing it before rebuild...');
    const npmInvocation = resolveNpmInvocation();
    const status = run(
        npmInvocation.command,
        [...npmInvocation.prefixArgs, 'install', '--force', 'ibm_db@^4.0.0'],
        {
            cwd: DB2_EXT_ROOT,
            env: configureClidriverEnvironment(process.env)
        }
    );

    if (status !== 0) {
        fail('Failed to install ibm_db before switching DB2 runtime.', status);
    }
}

/**
 * @param {string[]} extraArgs
 * @returns {string[]}
 */
function getElectronRestoreArgs(extraArgs) {
    if (extraArgs.length > 0) {
        return extraArgs;
    }

    const envArgs = [];
    const explicitElectronVersion = process.env.DB2_RUNTIME_ELECTRON_VERSION?.trim();
    const vscodeDir = process.env.DB2_RUNTIME_VSCODE_DIR?.trim();

    if (explicitElectronVersion) {
        envArgs.push('--electron', explicitElectronVersion);
    }

    if (vscodeDir) {
        envArgs.push('--vscode-dir', vscodeDir);
    }

    return envArgs;
}

/**
 * @param {string[]} extraArgs
 * @returns {boolean}
 */
function hasExplicitElectronRestoreTarget(extraArgs) {
    if (extraArgs.length > 0) {
        return true;
    }

    return Boolean(
        process.env.DB2_RUNTIME_ELECTRON_VERSION?.trim()
        || process.env.DB2_RUNTIME_VSCODE_DIR?.trim()
    );
}

function switchToNodeRuntime() {
    ensureIbmDbInstalled();

    console.log(`Rebuilding ibm_db for Node ${process.version} (ABI ${process.versions.modules})...`);
    const npmInvocation = resolveNpmInvocation();
    const status = run(
        npmInvocation.command,
        [...npmInvocation.prefixArgs, 'rebuild', 'ibm_db'],
        {
            cwd: DB2_EXT_ROOT,
            env: configureClidriverEnvironment(process.env)
        }
    );

    if (status !== 0) {
        fail('Failed to rebuild ibm_db for the current Node runtime.', status);
    }

    console.log('DB2 runtime is now aligned with Node/Jest.');
    console.log('Restore Electron/F5 bindings with: npm run db2:runtime:electron');
}

/**
 * @param {string[]} [extraArgs=[]]
 * @returns {number}
 */
function switchToElectronRuntime(extraArgs = []) {
    const electronArgs = getElectronRestoreArgs(extraArgs);
    console.log('Rebuilding ibm_db for the VS Code Electron/F5 runtime...');
    return run(
        process.execPath,
        [REBUILD_ELECTRON_SCRIPT, ...electronArgs],
        {
            cwd: DB2_EXT_ROOT,
            env: { ...process.env }
        }
    );
}

/**
 * @param {string[]} commandArgs
 * @returns {{ command: string, args: string[] }}
 */
function resolveCommandInvocation(commandArgs) {
    if (commandArgs.length === 0) {
        fail('No command was provided after "--".');
    }

    const [command, ...args] = commandArgs;
    if (command === 'node') {
        return {
            command: process.execPath,
            args
        };
    }

    if (command === 'npm') {
        const npmInvocation = resolveNpmInvocation();
        return {
            command: npmInvocation.command,
            args: [...npmInvocation.prefixArgs, ...args]
        };
    }

    return { command, args };
}

/**
 * @param {string[]} commandArgs
 * @returns {number}
 */
function runCommandInRepo(commandArgs) {
    const invocation = resolveCommandInvocation(commandArgs);
    return run(invocation.command, invocation.args, {
        cwd: REPO_ROOT,
        env: configureClidriverEnvironment(process.env)
    });
}

/**
 * @returns {string[]}
 */
function getMissingDb2LiveVariables() {
    return REQUIRED_DB2_LIVE_ENV.filter(name => {
        const value = process.env[name];
        return !(typeof value === 'string' && value.trim().length > 0);
    });
}

/**
 * @param {string[]} commandArgs
 * @param {string[]} electronArgs
 * @param {boolean} onlyIfLiveDb2Configured
 */
function runWithTemporaryNodeRuntime(commandArgs, electronArgs, onlyIfLiveDb2Configured) {
    const missingDb2Variables = getMissingDb2LiveVariables();
    if (onlyIfLiveDb2Configured && missingDb2Variables.length > 0) {
        if (missingDb2Variables.length < REQUIRED_DB2_LIVE_ENV.length) {
            console.warn(
                'DB2 live-test env is incomplete, so DB2 runtime switching is skipped.\n' +
                `Missing: ${missingDb2Variables.join(', ')}`
            );
        } else {
            console.log('DB2 live-test env not detected, so DB2 runtime switching is skipped.');
        }

        process.exit(runCommandInRepo(commandArgs));
    }

    switchToNodeRuntime();

    let commandExitCode = 0;
    let commandLaunchError;

    try {
        commandExitCode = runCommandInRepo(commandArgs);
    } catch (error) {
        commandLaunchError = error;
        commandExitCode = 1;
    }

    console.log('\nRestoring DB2 runtime for VS Code Electron/F5...');
    const restoreExitCode = switchToElectronRuntime(electronArgs);
    const restoreIsRequired = !onlyIfLiveDb2Configured || hasExplicitElectronRestoreTarget(electronArgs);

    if (commandLaunchError) {
        throw commandLaunchError;
    }

    if (restoreExitCode !== 0) {
        if (restoreIsRequired) {
            process.exit(restoreExitCode);
        }

        console.warn(
            'DB2 Electron/F5 runtime restore failed after the live-test command completed. '
            + 'Leaving ibm_db aligned to Node/Jest; set DB2_RUNTIME_ELECTRON_VERSION or '
            + 'DB2_RUNTIME_VSCODE_DIR to make restore mandatory in this environment.'
        );
    }

    process.exit(commandExitCode);
}

function main() {
    const args = process.argv.slice(2);
    const [command] = args;

    if (!command || command === 'help' || command === '--help' || command === '-h') {
        printUsage();
        return;
    }

    const separatorIndex = args.indexOf('--');
    const extraArgs = separatorIndex >= 0 ? args.slice(1, separatorIndex) : args.slice(1);
    const commandArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];

    switch (command) {
        case 'node':
            switchToNodeRuntime();
            return;
        case 'electron': {
            const exitCode = switchToElectronRuntime(extraArgs);
            if (exitCode !== 0) {
                process.exit(exitCode);
            }
            return;
        }
        case 'with-node-runtime':
            runWithTemporaryNodeRuntime(commandArgs, extraArgs, false);
            return;
        case 'auto-for-live-tests':
            runWithTemporaryNodeRuntime(commandArgs, extraArgs, true);
            return;
        default:
            fail(`Unknown DB2 runtime command "${command}".\n`);
    }
}

main();
