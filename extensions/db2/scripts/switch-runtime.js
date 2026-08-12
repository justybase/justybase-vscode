#!/usr/bin/env node
// @ts-check

/**
 * Compatibility wrapper for the former Node/Electron runtime switcher.
 *
 * ibm_db is now compiled once for N-API, which is shared by supported Node
 * and Electron hosts. The historical command names remain so existing local
 * scripts keep working, but none of them overwrite the binary for another ABI.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DB2_EXTENSION_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(DB2_EXTENSION_ROOT, '..', '..');
const REBUILD_NAPI_SCRIPT = path.join(__dirname, 'rebuild-napi.js');
const REQUIRED_DB2_LIVE_ENV = [
    'DB2_LIVE_TEST_HOST',
    'DB2_LIVE_TEST_DATABASE',
    'DB2_LIVE_TEST_USER',
    'DB2_LIVE_TEST_PASSWORD',
];

function printUsage() {
    console.log(
        'Usage:\n'
        + '  node scripts/switch-runtime.js napi\n'
        + '  node scripts/switch-runtime.js node\n'
        + '  node scripts/switch-runtime.js electron\n'
        + '  node scripts/switch-runtime.js with-node-runtime -- <command> [args]\n'
        + '  node scripts/switch-runtime.js auto-for-live-tests -- <command> [args]\n\n'
        + 'The node and electron aliases both build one Node-API runtime.\n',
    );
}

function fail(message, exitCode = 1) {
    console.error(message);
    process.exit(exitCode);
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        ...options,
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
        return { command: process.execPath, prefixArgs: [npmExecPath] };
    }

    return { command: 'npm.cmd', prefixArgs: [] };
}

function configureCliDriverEnvironment(baseEnv) {
    const env = { ...baseEnv };
    const cliDriverHome = path.join(DB2_EXTENSION_ROOT, 'node_modules', 'ibm_db', 'installer', 'clidriver');
    const addPath = (name, value) => {
        if (!fs.existsSync(value)) {
            return;
        }
        const values = (env[name] || '').split(path.delimiter).filter(Boolean);
        if (!values.includes(value)) {
            env[name] = [value, ...values].join(path.delimiter);
        }
    };

    if (fs.existsSync(cliDriverHome)) {
        env.IBM_DB_HOME = cliDriverHome;
        addPath('PATH', path.join(cliDriverHome, 'bin'));
        addPath('PATH', path.join(cliDriverHome, 'lib'));
        if (process.platform === 'linux') {
            addPath('LD_LIBRARY_PATH', path.join(cliDriverHome, 'lib'));
        } else if (process.platform === 'darwin') {
            addPath('DYLD_LIBRARY_PATH', path.join(cliDriverHome, 'lib'));
        }
    }

    return env;
}

function prepareNapiRuntime() {
    console.log('Preparing the shared Db2 Node-API runtime...');
    const exitCode = run(process.execPath, [REBUILD_NAPI_SCRIPT], {
        cwd: DB2_EXTENSION_ROOT,
        env: configureCliDriverEnvironment(process.env),
    });
    if (exitCode !== 0) {
        fail('Failed to build the Db2 Node-API runtime.', exitCode);
    }
}

function getMissingDb2LiveVariables() {
    return REQUIRED_DB2_LIVE_ENV.filter(name => !process.env[name]?.trim());
}

function resolveCommandInvocation(commandArgs) {
    if (commandArgs.length === 0) {
        fail('No command was provided after "--".');
    }

    const [command, ...args] = commandArgs;
    if (command === 'node') {
        return { command: process.execPath, args };
    }
    if (command === 'npm') {
        const npm = resolveNpmInvocation();
        return { command: npm.command, args: [...npm.prefixArgs, ...args] };
    }
    return { command, args };
}

function runCommandInRepository(commandArgs) {
    const invocation = resolveCommandInvocation(commandArgs);
    return run(invocation.command, invocation.args, {
        cwd: REPOSITORY_ROOT,
        env: configureCliDriverEnvironment(process.env),
    });
}

function runWithNapiRuntime(commandArgs, onlyWhenLiveDb2Configured) {
    const missingVariables = getMissingDb2LiveVariables();
    if (onlyWhenLiveDb2Configured && missingVariables.length > 0) {
        if (missingVariables.length < REQUIRED_DB2_LIVE_ENV.length) {
            console.warn(`DB2 live-test environment is incomplete; skipping N-API rebuild. Missing: ${missingVariables.join(', ')}`);
        } else {
            console.log('DB2 live-test environment was not detected; skipping N-API rebuild.');
        }
        process.exit(runCommandInRepository(commandArgs));
    }

    prepareNapiRuntime();
    process.exit(runCommandInRepository(commandArgs));
}

function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    if (!command || command === 'help' || command === '--help' || command === '-h') {
        printUsage();
        return;
    }

    const separatorIndex = args.indexOf('--');
    const commandArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];
    switch (command) {
        case 'napi':
        case 'node':
        case 'electron':
            prepareNapiRuntime();
            return;
        case 'with-node-runtime':
            runWithNapiRuntime(commandArgs, false);
            return;
        case 'auto-for-live-tests':
            runWithNapiRuntime(commandArgs, true);
            return;
        default:
            fail(`Unknown DB2 runtime command "${command}".`);
    }
}

main();
