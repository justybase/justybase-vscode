#!/usr/bin/env node

/**
 * Launch the real VS Code Extension Host for the result-panel scenario.
 * The parent process owns all temporary files; the child only receives paths
 * and test configuration through its environment.
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { ExtensionHostScreenshotSession } = require('./extensionHostScreenshot');
const {
    createSqliteFixture,
    createSqliteFilterPerformanceFixture,
    FILTER_PERFORMANCE_TABLE_NAME,
    SQLITE_TABLE_NAME,
} = require('./extensionHostFixture');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const resultPanelSmokeTestPath = path.join(__dirname, 'extensionHostSmoke.js');
const authoringSmokeTestPath = path.join(__dirname, 'extensionHostAuthoringSmoke.js');
const filterPerformanceSmokeTestPath = path.join(__dirname, 'extensionHostFilterPerformanceSmoke.js');
const requestedVersion = (process.env.RESULT_PANEL_VSCODE_TEST_VERSION || 'stable').trim();

function requestedEngine() {
    const argument = process.argv.find(value => value === '--engine=netezza' || value === '--engine=sqlite');
    if (argument) return argument.slice('--engine='.length);
    return process.env.JUSTYBASE_EXTENSION_HOST_ENGINE === 'netezza' ? 'netezza' : 'sqlite';
}

function requestedSuite() {
    const argument = process.argv.find(value => value.startsWith('--suite='));
    const suite = argument ? argument.slice('--suite='.length) : 'result-panel';
    if (suite !== 'result-panel' && suite !== 'authoring' && suite !== 'result-panel-filter-performance') {
        throw new Error('Extension Host suite must be result-panel, result-panel-filter-performance, or authoring.');
    }
    return suite;
}

function screenshotsEnabled() {
    return process.argv.includes('--screenshots')
        || process.env.JUSTYBASE_EXTENSION_HOST_SCREENSHOTS === '1';
}

function findFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? address.port : undefined;
            server.close(error => {
                if (error) {
                    reject(error);
                } else if (!port) {
                    reject(new Error('Could not allocate a local Extension Host debugging port.'));
                } else {
                    resolve(port);
                }
            });
        });
    });
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

function iterationArtifactPath(filePath, iteration, repeatCount) {
    if (repeatCount === 1) return filePath;
    return filePath.replace(/\.json$/u, `-iteration-${iteration}.json`);
}

function readIterationReport(reportPath) {
    if (!fs.existsSync(reportPath)) return undefined;
    try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        return {
            status: report?.status === 'passed' ? 'passed' : 'failed',
            durationMs: Number.isFinite(report?.durationMs) ? report.durationMs : undefined,
            pendingRequestCount: Number.isInteger(report?.pendingRequestCount)
                ? report.pendingRequestCount
                : undefined,
            runtimeLeakCount: [
                report?.activeCommandCount,
                report?.executingSourceCount,
                report?.streamingResultCount,
                report?.streamingTransportCount,
                report?.pendingResultSyncCount,
            ].reduce((total, value) => total + (Number.isInteger(value) ? value : 0), 0),
        };
    } catch {
        return undefined;
    }
}

async function main() {
    const engine = requestedEngine();
    const suite = requestedSuite();
    const captureScreenshots = screenshotsEnabled();
    if (suite === 'result-panel-filter-performance' && engine !== 'sqlite') {
        throw new Error('Extension Host filter performance suite currently requires --engine=sqlite.');
    }
    const smokeTestPath = suite === 'authoring'
        ? authoringSmokeTestPath
        : suite === 'result-panel-filter-performance'
            ? filterPerformanceSmokeTestPath
            : resultPanelSmokeTestPath;
    requirePath(path.join(repositoryRoot, 'package.json'), 'core manifest');
    requirePath(path.join(repositoryRoot, 'dist', 'extension.js'), 'core bundle (run npm run build first)');
    requirePath(smokeTestPath, 'Extension Host smoke test');
    if (suite === 'result-panel' && engine === 'netezza') validateNetezzaEnvironment();
    const repeatCount = requestedRepeatCount();

    const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-extension-host-'));
    const artifactDirectory = process.env.JUSTYBASE_EXTENSION_HOST_ARTIFACT_DIR
        ? path.resolve(process.env.JUSTYBASE_EXTENSION_HOST_ARTIFACT_DIR)
        : captureScreenshots
            ? path.join(repositoryRoot, 'artifacts', 'extension-host')
            : path.join(workDirectory, 'artifacts');
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const reportPath = path.join(
        artifactDirectory,
        suite === 'result-panel'
            ? `${engine}-result-panel-report.json`
            : suite === 'result-panel-filter-performance'
                ? `${engine}-result-panel-filter-performance-report.json`
                : 'authoring-report.json',
    );
    const tracePath = path.join(
        artifactDirectory,
        suite === 'result-panel'
            ? `${engine}-result-panel-trace.json`
            : suite === 'result-panel-filter-performance'
                ? `${engine}-result-panel-filter-performance-trace.json`
                : 'authoring-trace.json',
    );
    const sourceFilePath = path.join(workDirectory, 'fixture.sql');
    const databasePath = path.join(workDirectory, 'fixture.sqlite');
    const tableName = engine === 'sqlite'
        ? suite === 'result-panel-filter-performance' ? FILTER_PERFORMANCE_TABLE_NAME : SQLITE_TABLE_NAME
        : `jbl_eh_${Date.now()}_${process.pid}`;

    if (engine === 'sqlite' && suite === 'result-panel') createSqliteFixture(databasePath);
    if (engine === 'sqlite' && suite === 'result-panel-filter-performance') {
        createSqliteFilterPerformanceFixture(databasePath);
    }

    const extensionTestsEnv = {
        ...process.env,
        NODE_ENV: 'test',
        JUSTYBASE_RESULT_PANEL_TRACE: '1',
        JUSTYBASE_EXTENSION_HOST_SUITE: suite,
        JUSTYBASE_EXTENSION_HOST_ENGINE: engine,
        JUSTYBASE_EXTENSION_HOST_WORK_DIR: workDirectory,
        JUSTYBASE_EXTENSION_HOST_DATABASE_PATH: databasePath,
        JUSTYBASE_EXTENSION_HOST_TABLE: tableName,
        JUSTYBASE_EXTENSION_HOST_SOURCE_FILE: sourceFilePath,
        JUSTYBASE_EXTENSION_HOST_REPORT_PATH: reportPath,
        JUSTYBASE_EXTENSION_HOST_TRACE_PATH: tracePath,
        JUSTYBASE_EXTENSION_HOST_ARTIFACT_DIR: artifactDirectory,
        JUSTYBASE_EXTENSION_HOST_SCREENSHOTS: captureScreenshots ? '1' : '0',
        ...(process.platform === 'linux' ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}),
    };

    let passed = false;
    const iterationResults = [];
    const iterationErrors = [];
    console.log(`=== Extension Host ${suite} scenario (${engine}, ${requestedVersion}, ${repeatCount} iteration(s)) ===`);
    try {
        for (let iteration = 1; iteration <= repeatCount; iteration += 1) {
            const iterationReportPath = iterationArtifactPath(reportPath, iteration, repeatCount);
            const iterationTracePath = iterationArtifactPath(tracePath, iteration, repeatCount);
            const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-extension-host-profile-'));
            const screenshotRequestDirectory = path.join(
                workDirectory,
                'screenshot-requests',
                suite,
                `iteration-${iteration}`,
            );
            const screenshotDirectory = path.join(
                artifactDirectory,
                'screenshots',
                suite,
                engine,
                `iteration-${iteration}`,
            );
            const debuggingPort = captureScreenshots ? await findFreePort() : undefined;
            const screenshotSession = captureScreenshots
                ? new ExtensionHostScreenshotSession({
                    port: debuggingPort,
                    requestDirectory: screenshotRequestDirectory,
                    screenshotDirectory,
                })
                : undefined;
            const options = {
                extensionDevelopmentPath: repositoryRoot,
                extensionTestsPath: smokeTestPath,
                extensionTestsEnv: {
                    ...extensionTestsEnv,
                    JUSTYBASE_EXTENSION_HOST_ITERATION: String(iteration),
                    JUSTYBASE_EXTENSION_HOST_REPORT_PATH: iterationReportPath,
                    JUSTYBASE_EXTENSION_HOST_TRACE_PATH: iterationTracePath,
                    ...(captureScreenshots
                        ? {
                            JUSTYBASE_EXTENSION_HOST_SCREENSHOT_REQUEST_DIR: screenshotRequestDirectory,
                            JUSTYBASE_EXTENSION_HOST_SCREENSHOT_DIR: screenshotDirectory,
                        }
                        : {}),
                },
                launchArgs: [
                    `--user-data-dir=${userDataDirectory}`,
                    '--disable-extensions',
                    '--disable-gpu',
                    ...(captureScreenshots
                        ? [
                            `--remote-debugging-port=${debuggingPort}`,
                            '--window-size=1600,1000',
                            '--force-device-scale-factor=1',
                        ]
                        : []),
                    ...(process.platform === 'linux'
                        ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox']
                        : []),
                ],
            };
            if (requestedVersion && requestedVersion !== 'stable') options.version = requestedVersion;
            screenshotSession?.start();
            let iterationError;
            try {
                const exitCode = await runTests(options);
                if (exitCode !== 0) throw new Error(`Extension Host exited with code ${exitCode}.`);
            } catch (error) {
                iterationError = error;
            } finally {
                try {
                    await screenshotSession?.stop();
                    if (screenshotSession) {
                        const manifestPath = path.join(screenshotDirectory, 'manifest.json');
                        if (!fs.existsSync(manifestPath)) {
                            throw new Error(`Extension Host screenshot manifest was not written: ${manifestPath}`);
                        }
                        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                        if (!Array.isArray(manifest) || manifest.length === 0 || manifest.some(item => item?.ok !== true)) {
                            throw new Error(`Extension Host screenshot capture produced no complete screenshots: ${manifestPath}`);
                        }
                        console.log(`Extension Host screenshots: ${screenshotDirectory}`);
                    }
                } catch (error) {
                    iterationError ??= error;
                }
                fs.rmSync(userDataDirectory, { recursive: true, force: true });
            }

            const report = readIterationReport(iterationReportPath);
            const status = iterationError || report?.status !== 'passed' ? 'failed' : 'passed';
            iterationResults.push({
                iteration,
                status,
                ...(report?.durationMs !== undefined ? { durationMs: report.durationMs } : {}),
                ...(report?.pendingRequestCount !== undefined
                    ? { pendingRequestCount: report.pendingRequestCount }
                    : {}),
                ...(report?.runtimeLeakCount !== undefined
                    ? { runtimeLeakCount: report.runtimeLeakCount }
                    : {}),
                reportAvailable: report !== undefined,
                traceAvailable: fs.existsSync(iterationTracePath),
            });
            if (iterationError) iterationErrors.push(iterationError);
        }

        let completionReportPath = reportPath;
        if (repeatCount > 1) {
            const summaryPath = reportPath.replace(/-report\.json$/u, '-repeat-summary.json');
            const failedIterations = iterationResults.filter(result => result.status === 'failed').length;
            fs.writeFileSync(summaryPath, `${JSON.stringify({
                schemaVersion: 1,
                suite,
                engine,
                repeatCount,
                passedIterations: repeatCount - failedIterations,
                failedIterations,
                iterations: iterationResults,
            }, null, 2)}\n`, 'utf8');
            console.log(`Extension Host repeat summary: ${summaryPath}`);
            completionReportPath = summaryPath;
        }
        if (iterationErrors.length > 0 || iterationResults.some(result => result.status === 'failed')) {
            const firstError = iterationErrors[0];
            const detail = firstError instanceof Error ? firstError.message : String(firstError ?? 'scenario report failed');
            throw new Error(`${iterationResults.filter(result => result.status === 'failed').length}/${repeatCount} Extension Host iteration(s) failed: ${detail}`);
        }
        passed = true;
        console.log(`Extension Host ${suite} scenario passed; report: ${completionReportPath}`);
    } finally {
        // Each iteration owns and removes its own fresh profile.
        const preserve = process.env.JUSTYBASE_EXTENSION_HOST_KEEP_ARTIFACTS === '1'
            || captureScreenshots
            || !passed;
        if (!preserve) fs.rmSync(workDirectory, { recursive: true, force: true });
        else console.log(`Extension Host artifacts retained at ${artifactDirectory}`);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
