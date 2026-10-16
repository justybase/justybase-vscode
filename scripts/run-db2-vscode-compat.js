#!/usr/bin/env node
// @ts-check

const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const repositoryRoot = path.resolve(__dirname, '..');
const db2ExtensionRoot = path.join(repositoryRoot, 'extensions', 'db2');
const extensionTestsPath = path.join(db2ExtensionRoot, 'test', 'extensionHost', 'runtimeSmoke.js');
const requestedVersion = (process.env.DB2_VSCODE_TEST_VERSION || 'stable').trim();

async function main() {
    const options = {
        extensionDevelopmentPath: db2ExtensionRoot,
        extensionTestsPath,
        extensionTestsEnv: { ...process.env },
        launchArgs: ['--disable-extensions'],
    };

    // @vscode/test-electron treats an omitted version as the current Stable
    // release. Insiders and exact release versions are passed through.
    if (requestedVersion && requestedVersion !== 'stable') {
        options.version = requestedVersion;
    }

    console.log(`Running Db2 TypeScript-driver smoke test in VS Code ${requestedVersion}.`);
    await runTests(options);
}

main().catch(error => {
    console.error('Db2 VS Code Extension Host smoke test failed.');
    console.error(error);
    process.exit(1);
});
