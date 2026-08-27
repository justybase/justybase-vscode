#!/usr/bin/env node

/**
 * Runs the result-panel race scenario in a real VS Code Extension Host.
 * This complements Jest mocks by exercising activation, command registration,
 * and the host-side ResultPanelView state machine together.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const smokeTestPath = path.join(__dirname, 'resultPanelRegressionSmoke.js');
const requestedVersion = (process.env.RESULT_PANEL_VSCODE_TEST_VERSION || 'stable').trim();

function requirePath(targetPath, description) {
    if (!fs.existsSync(targetPath)) {
        throw new Error(`Result-panel Extension Host: missing ${description}: ${path.relative(repositoryRoot, targetPath)}`);
    }
}

async function main() {
    requirePath(path.join(repositoryRoot, 'package.json'), 'core manifest');
    requirePath(path.join(repositoryRoot, 'dist', 'extension.js'), 'core bundle (run npm run build first)');
    requirePath(smokeTestPath, 'regression smoke test');

    const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-result-panel-vscode-'));
    const options = {
        extensionDevelopmentPath: repositoryRoot,
        extensionTestsPath: smokeTestPath,
        extensionTestsEnv: {
            ...process.env,
            NODE_ENV: 'test',
            JUSTYBASE_RESULT_PANEL_TRACE: '1',
            ...(process.platform === 'linux' ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}),
        },
        // The disposable Linux runners used by CI/WSL containers do not expose
        // the Chromium sandbox namespace. Windows keeps the default sandbox.
        launchArgs: [
            `--user-data-dir=${userDataDirectory}`,
            '--disable-extensions',
            '--disable-gpu',
            ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        ],
    };

    if (requestedVersion && requestedVersion !== 'stable') {
        options.version = requestedVersion;
    }

    console.log(`=== result-panel VS Code Extension Host regression (${requestedVersion}) ===`);
    try {
        const exitCode = await runTests(options);
        if (exitCode !== 0) {
            throw new Error(`Result-panel Extension Host exited with code ${exitCode}.`);
        }
        console.log('Result-panel Extension Host regression passed.');
    } finally {
        fs.rmSync(userDataDirectory, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
