#!/usr/bin/env node

/**
 * Runs companion activation checks inside a real VS Code Extension Host.
 *
 * This is deliberately separate from Jest: a Jest mock can prove the
 * activation code's branches, but only Extension Host execution verifies that
 * the packaged core and companion bundles can load together in VS Code.
 */
const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const repositoryRoot = path.resolve(__dirname, '..');
const coreExtensionId = 'krzysztof-d.justybaselite-netezza';
const smokeTestPath = path.join(repositoryRoot, 'scripts', 'extensionHost', 'companionSmoke.js');

const EXTENSIONS = Object.freeze({
    access: { id: 'krzysztof-d.justybaselite-access', kind: 'access', runtime: ['@duckdb/node-api', 'mdb-reader'] },
    db2: { id: 'krzysztof-d.justybaselite-db2', kind: 'db2', runtime: ['ibm_db'] },
    duckdb: { id: 'krzysztof-d.justybaselite-duckdb', kind: 'duckdb', runtime: ['@duckdb/node-api'] },
    mssql: { id: 'krzysztof-d.justybaselite-mssql', kind: 'mssql', runtime: ['mssql'] },
    mysql: { id: 'krzysztof-d.justybaselite-mysql', kind: 'mysql', runtime: ['mysql2'] },
    clickhouse: { id: 'krzysztof-d.justybaselite-clickhouse', kind: 'clickhouse', runtime: ['@clickhouse/client'] },
    oracle: { id: 'krzysztof-d.justybaselite-oracle', kind: 'oracle', runtime: ['oracledb'] },
    postgresql: { id: 'krzysztof-d.justybaselite-postgresql', kind: 'postgresql', runtime: ['pg'] },
    snowflake: { id: 'krzysztof-d.justybaselite-snowflake', kind: 'snowflake', runtime: ['snowflake-sdk'] },
    vertica: { id: 'krzysztof-d.justybaselite-vertica', kind: 'vertica', runtime: ['vertica-nodejs'] },
});

function fail(message) {
    throw new Error(`VS Code companion smoke: ${message}`);
}

function extensionRoot(extensionKey) {
    return path.join(repositoryRoot, 'extensions', extensionKey);
}

function requirePath(targetPath, description) {
    if (!fs.existsSync(targetPath)) {
        fail(`missing ${description}: ${path.relative(repositoryRoot, targetPath)}`);
    }
}

function canResolveFromExtension(extensionKey, moduleName) {
    try {
        require.resolve(moduleName, { paths: [extensionRoot(extensionKey)] });
        return true;
    } catch {
        return false;
    }
}

function validateExtension(extensionKey) {
    const definition = EXTENSIONS[extensionKey];
    if (!definition) {
        fail(`unknown extension id: ${extensionKey}`);
    }

    const root = extensionRoot(extensionKey);
    requirePath(path.join(root, 'package.json'), `${extensionKey} manifest`);
    requirePath(path.join(root, 'dist', 'extension.js'), `${extensionKey} bundle`);

    const missingRuntime = definition.runtime.filter(moduleName => !canResolveFromExtension(extensionKey, moduleName));
    if (missingRuntime.length > 0) {
        fail(
            `${extensionKey} runtime is incomplete; install: ${missingRuntime.join(', ')}`,
        );
    }
}

function prependEnvironmentPath(environment, name, value) {
    const values = (environment[name] || '').split(path.delimiter).filter(Boolean);
    if (!values.includes(value)) {
        environment[name] = [value, ...values].join(path.delimiter);
    }
}

function buildExtensionHostEnvironment(extensionKey) {
    const environment = {
        ...process.env,
        NODE_ENV: 'test',
        COMPANION_CORE_EXTENSION_ID: coreExtensionId,
    };

    if (extensionKey === 'db2') {
        const cliDriverHome = path.join(extensionRoot('db2'), 'node_modules', 'ibm_db', 'installer', 'clidriver');
        environment.DB2CODEPAGE = environment.DB2CODEPAGE || '1208';
        environment.IBM_DB_HOME = cliDriverHome;
        prependEnvironmentPath(environment, 'PATH', path.join(cliDriverHome, 'bin'));
        prependEnvironmentPath(environment, 'PATH', path.join(cliDriverHome, 'lib'));
        if (process.platform === 'linux') {
            prependEnvironmentPath(environment, 'LD_LIBRARY_PATH', path.join(cliDriverHome, 'lib'));
        } else if (process.platform === 'darwin') {
            prependEnvironmentPath(environment, 'DYLD_LIBRARY_PATH', path.join(cliDriverHome, 'lib'));
        }
    }

    return environment;
}

async function runExtensionSmoke(extensionKey) {
    const definition = EXTENSIONS[extensionKey];
    const extensionDevelopmentPath = [repositoryRoot, extensionRoot(extensionKey)];
    const requestedVersion = (process.env.COMPANION_VSCODE_TEST_VERSION || 'stable').trim();
    const options = {
        extensionDevelopmentPath,
        extensionTestsPath: smokeTestPath,
        extensionTestsEnv: {
            ...buildExtensionHostEnvironment(extensionKey),
            COMPANION_EXTENSION_ID: definition.id,
            COMPANION_DATABASE_KIND: definition.kind,
        },
        launchArgs: ['--disable-extensions'],
    };

    if (requestedVersion && requestedVersion !== 'stable') {
        options.version = requestedVersion;
    }

    console.log(`\n=== ${extensionKey} VS Code Extension Host smoke (${requestedVersion}) ===`);
    const exitCode = await runTests(options);
    if (exitCode !== 0) {
        fail(`${extensionKey} Extension Host exited with code ${exitCode}.`);
    }
}

async function main() {
    requirePath(path.join(repositoryRoot, 'package.json'), 'core manifest');
    requirePath(path.join(repositoryRoot, 'dist', 'extension.js'), 'core bundle');
    requirePath(smokeTestPath, 'Extension Host smoke test');

    const requestedExtensions = process.argv.slice(2);
    const extensionKeys = requestedExtensions.length > 0
        ? requestedExtensions
        : Object.keys(EXTENSIONS);
    extensionKeys.forEach(validateExtension);

    for (const extensionKey of extensionKeys) {
        await runExtensionSmoke(extensionKey);
    }

    console.log('\nVS Code companion Extension Host smoke passed.');
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
