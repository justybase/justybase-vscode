#!/usr/bin/env node

/**
 * Runs the optional extension integration suites one at a time.
 *
 * The regular per-dialect scripts intentionally soft-skip when a local
 * database is not configured. This gate is different: it is a local release
 * gate and fails before Jest starts when a required runtime or connection
 * configuration is missing. Running sequentially with --no-cache also avoids
 * Jest transform-cache races when several suites are started together.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const jestExecutable = path.join(repositoryRoot, 'node_modules', 'jest', 'bin', 'jest.js');

const REQUIRED_ENVIRONMENT = Object.freeze({
    access: [
        ['ACCESS_TEST_FILE'],
    ],
    db2: [
        ['DB2_LIVE_TEST_HOST'],
        ['DB2_LIVE_TEST_DATABASE'],
        ['DB2_LIVE_TEST_USER'],
        ['DB2_LIVE_TEST_PASSWORD'],
    ],
    mssql: [
        ['MSSQL_LIVE_TEST_HOST'],
        ['MSSQL_LIVE_TEST_DATABASE'],
        ['MSSQL_LIVE_TEST_USER'],
        ['MSSQL_LIVE_TEST_PASSWORD'],
    ],
    mysql: [
        ['MYSQL_LIVE_TEST_HOST'],
        ['MYSQL_LIVE_TEST_DATABASE'],
        ['MYSQL_LIVE_TEST_USER'],
        ['MYSQL_LIVE_TEST_PASSWORD'],
    ],
    oracle: [
        ['ORACLE_LIVE_TEST_HOST'],
        ['ORACLE_LIVE_TEST_DATABASE'],
        ['ORACLE_LIVE_TEST_USER'],
        ['ORACLE_LIVE_TEST_PASSWORD'],
    ],
    postgresql: [
        ['POSTGRES_LIVE_TEST_HOST', 'PG_LIVE_TEST_HOST'],
        ['POSTGRES_LIVE_TEST_DATABASE', 'PG_LIVE_TEST_DATABASE'],
        ['POSTGRES_LIVE_TEST_USER', 'PG_LIVE_TEST_USER'],
        ['POSTGRES_LIVE_TEST_PASSWORD', 'PG_LIVE_TEST_PASSWORD'],
    ],
    snowflake: [
        ['SNOWFLAKE_LIVE_TEST_ACCOUNT', 'SNOWFLAKE_LIVE_TEST_HOST'],
        ['SNOWFLAKE_LIVE_TEST_DATABASE'],
        ['SNOWFLAKE_LIVE_TEST_USER'],
        ['SNOWFLAKE_LIVE_TEST_PASSWORD'],
    ],
    // The shared Vertica harness explicitly permits an empty/missing password.
    vertica: [
        ['VERTICA_LIVE_TEST_HOST'],
        ['VERTICA_LIVE_TEST_DATABASE'],
        ['VERTICA_LIVE_TEST_USER'],
    ],
});

const RUNTIME_MODULES = Object.freeze({
    access: ['@duckdb/node-api', 'mdb-reader'],
    db2: ['ibm_db'],
    duckdb: ['@duckdb/node-api', '@justybase/spreadsheet-tasks', 'mdb-reader'],
    mssql: ['mssql'],
    mysql: ['mysql2'],
    oracle: ['oracledb'],
    postgresql: ['pg'],
    snowflake: ['snowflake-sdk'],
    vertica: ['vertica-nodejs'],
});

const TEST_SCRIPTS = Object.freeze({
    access: 'test:access:integration',
    db2: 'test:db2:integration',
    duckdb: 'test:duckdb:integration',
    mssql: 'test:mssql:integration',
    mysql: 'test:mysql:integration',
    oracle: 'test:oracle:integration',
    postgresql: 'test:postgres:integration',
    snowflake: 'test:snowflake:integration',
    vertica: 'test:vertica:integration',
});

function fail(message) {
    console.error(`Extension integration gate: ${message}`);
    process.exit(1);
}

function extensionRuntimeRoot(extensionId) {
    return path.join(repositoryRoot, 'extensions', extensionId);
}

function canResolveFromExtension(extensionId, moduleName) {
    try {
        require.resolve(moduleName, { paths: [extensionRuntimeRoot(extensionId)] });
        return true;
    } catch {
        return false;
    }
}

function validateRuntime(extensionId) {
    const missingModules = (RUNTIME_MODULES[extensionId] || [])
        .filter(moduleName => !canResolveFromExtension(extensionId, moduleName));
    if (missingModules.length > 0) {
        fail(
            `${extensionId} runtime is incomplete. Install the extension dependencies before running the gate: `
            + missingModules.join(', '),
        );
    }
}

function validateEnvironment(extensionId) {
    const missing = (REQUIRED_ENVIRONMENT[extensionId] || [])
        .filter(names => !names.some(name => process.env[name]?.trim()));
    if (missing.length > 0) {
        fail(
            `${extensionId} live database configuration is missing: `
            + missing.map(names => names.join(' or ')).join(', '),
        );
    }
}

function validateInputs(extensionIds) {
    if (!fs.existsSync(jestExecutable)) {
        fail(`Jest executable is missing: ${path.relative(repositoryRoot, jestExecutable)}`);
    }

    for (const extensionId of extensionIds) {
        validateRuntime(extensionId);
        validateEnvironment(extensionId);
    }
}

function runSuite(extensionId) {
    const script = TEST_SCRIPTS[extensionId];
    const resultDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-extension-integration-'));
    const resultFile = path.join(resultDirectory, 'jest-results.json');
    const environment = {
        ...process.env,
        RUN_MYSQL_INTEGRATION: extensionId === 'mysql' ? '1' : process.env.RUN_MYSQL_INTEGRATION,
        RUN_SNOWFLAKE_INTEGRATION: extensionId === 'snowflake' ? '1' : process.env.RUN_SNOWFLAKE_INTEGRATION,
    };

    console.log(`\n=== ${extensionId} extension integration ===`);
    const result = spawnSync(
        'npm',
        ['run', script, '--', '--no-cache', '--runInBand', '--json', '--outputFile', resultFile],
        {
            cwd: repositoryRoot,
            env: environment,
            stdio: 'inherit',
        },
    );

    if (result.error) {
        fail(`${extensionId} integration process could not start: ${result.error.message}`);
    }
    if (result.status !== 0) {
        fail(`${extensionId} integration failed with exit code ${result.status ?? 'unknown'}.`);
    }

    if (!fs.existsSync(resultFile)) {
        fail(`${extensionId} integration did not produce a Jest result report.`);
    }

    let report;
    try {
        report = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    } catch (error) {
        fail(
            `${extensionId} integration produced an unreadable Jest result report: `
            + (error instanceof Error ? error.message : String(error)),
        );
    } finally {
        fs.rmSync(resultDirectory, { recursive: true, force: true });
    }

    const skippedTests = Number(report.numPendingTests || 0) + Number(report.numTodoTests || 0);
    if (Number(report.numTotalTests || 0) === 0) {
        fail(`${extensionId} integration ran no tests.`);
    }
    if (skippedTests > 0) {
        fail(`${extensionId} integration skipped ${skippedTests} test(s); configure the live fixture instead.`);
    }
}

function main() {
    const extensionIds = process.argv.slice(2);
    const selectedExtensions = extensionIds.length > 0
        ? extensionIds
        : Object.keys(TEST_SCRIPTS);
    const unknownExtensions = selectedExtensions.filter(extensionId => !TEST_SCRIPTS[extensionId]);

    if (unknownExtensions.length > 0) {
        fail(`unknown extension id(s): ${unknownExtensions.join(', ')}`);
    }

    validateInputs(selectedExtensions);
    for (const extensionId of selectedExtensions) {
        runSuite(extensionId);
    }
    console.log('\nExtension integration gate passed.');
}

main();
