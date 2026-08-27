#!/usr/bin/env node

/**
 * Launch the real VS Code Extension Host for the result-panel scenario.
 * The parent process owns all temporary files; the child only receives paths
 * and test configuration through its environment.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const {
    createSqliteFixture,
    SQLITE_TABLE_NAME,
} = require('./extensionHostFixture');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const smokeTestPath = path.join(__dirname, 'extensionHostSmoke.js');
const requestedVersion = (process.env.RESULT_PANEL_VSCODE_TEST_VERSION || 'stable').trim();

function requestedEngine() {
    const argument = process.argv.find(value => value === '--engine=netezza' || value === '--engine=sqlite');
    if (argument) return argument.slice('--engine='.length);
    return process.env.JUSTYBASE_EXTENSION_HOST_ENGINE === 'netezza' ? 'netezza' : 'sqlite';
}

function requirePath(targetPath, description) {
    if (!fs.existsSync(targetPath)) {
        throw new Error(`Extension Host regression: missing ${description}: ${path.relative(repositoryRoot, targetPath)}`);
    }
}

function validateNetezzaEnvironment() {
    const required = ['NZ_DEV_HOST', 'NZ_DEV_PORT', 'NZ_DEV_USER', 'NZ_DEV_PASSWORD', 'NZ_DEV_DATABASE'];
    const missing = required.filter(name => !process.env[name]);
    if (missing.length > 0) {
        throw new Error(`Netezza Extension Host test configuration is incomplete: ${missing.join(', ')}`);
    }
}

function requestedRepeatCount() {
    const raw = (process.env.JUSTYBASE_EXTENSION_HOST_REPEAT || '1').trim();
    const count = Number.parseInt(raw, 10);
    if (!/^\d+$/u.test(raw) || count < 1 || count > 100) {
        throw new Error('JUSTYBASE_EXTENSION_HOST_REPEAT must be an integer from 1 to 100.');
    }
    return count;
}

async function main() {
    const engine = requestedEngine();
    requirePath(path.join(repositoryRoot, 'package.json'), 'core manifest');
    requirePath(path.join(repositoryRoot, 'dist', 'extension.js'), 'core bundle (run npm run build first)');
    requirePath(smokeTestPath, 'Extension Host smoke test');
    if (engine === 'netezza') validateNetezzaEnvironment();
    const repeatCount = requestedRepeatCount();

    const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-extension-host-'));
    const artifactDirectory = process.env.JUSTYBASE_EXTENSION_HOST_ARTIFACT_DIR
        ? path.resolve(process.env.JUSTYBASE_EXTENSION_HOST_ARTIFACT_DIR)
        : path.join(workDirectory, 'artifacts');
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const reportPath = path.join(artifactDirectory, `${engine}-result-panel-report.json`);
    const tracePath = path.join(artifactDirectory, `${engine}-result-panel-trace.json`);
    const sourceFilePath = path.join(workDirectory, 'fixture.sql');
    const databasePath = path.join(workDirectory, 'fixture.sqlite');
    const tableName = engine === 'sqlite'
        ? SQLITE_TABLE_NAME
        : `jbl_eh_${Date.now()}_${process.pid}`;

    if (engine === 'sqlite') createSqliteFixture(databasePath);

    const extensionTestsEnv = {
        ...process.env,
        NODE_ENV: 'test',
        JUSTYBASE_RESULT_PANEL_TRACE: '1',
        JUSTYBASE_EXTENSION_HOST_ENGINE: engine,
        JUSTYBASE_EXTENSION_HOST_WORK_DIR: workDirectory,
        JUSTYBASE_EXTENSION_HOST_DATABASE_PATH: databasePath,
        JUSTYBASE_EXTENSION_HOST_TABLE: tableName,
        JUSTYBASE_EXTENSION_HOST_SOURCE_FILE: sourceFilePath,
        JUSTYBASE_EXTENSION_HOST_REPORT_PATH: reportPath,
        JUSTYBASE_EXTENSION_HOST_TRACE_PATH: tracePath,
        JUSTYBASE_EXTENSION_HOST_ARTIFACT_DIR: artifactDirectory,
        ...(process.platform === 'linux' ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}),
    };

    let passed = false;
    console.log(`=== Extension Host result-panel scenario (${engine}, ${requestedVersion}, ${repeatCount} iteration(s)) ===`);
    try {
        for (let iteration = 1; iteration <= repeatCount; iteration += 1) {
            const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-extension-host-profile-'));
            const options = {
                extensionDevelopmentPath: repositoryRoot,
                extensionTestsPath: smokeTestPath,
                extensionTestsEnv: {
                    ...extensionTestsEnv,
                    JUSTYBASE_EXTENSION_HOST_ITERATION: String(iteration),
                },
                launchArgs: [
                    `--user-data-dir=${userDataDirectory}`,
                    '--disable-extensions',
                    '--disable-gpu',
                    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
                ],
            };
            if (requestedVersion && requestedVersion !== 'stable') options.version = requestedVersion;
            try {
                const exitCode = await runTests(options);
                if (exitCode !== 0) throw new Error(`Extension Host exited with code ${exitCode}.`);
            } finally {
                fs.rmSync(userDataDirectory, { recursive: true, force: true });
            }
        }
        passed = true;
        console.log(`Extension Host result-panel scenario passed; report: ${reportPath}`);
    } finally {
        // Each iteration owns and removes its own fresh profile.
        const preserve = process.env.JUSTYBASE_EXTENSION_HOST_KEEP_ARTIFACTS === '1' || !passed;
        if (!preserve) fs.rmSync(workDirectory, { recursive: true, force: true });
        else console.log(`Extension Host artifacts retained at ${artifactDirectory}`);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
