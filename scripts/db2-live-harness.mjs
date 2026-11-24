#!/usr/bin/env node
/**
 * Ephemeral Db2 LUW live-test harness.
 *
 * Creates a disposable Db2 container (normally through Docker inside WSL
 * Ubuntu), provisions EXPLAIN tables and the `JBL_LIVE` fixture, runs the Db2
 * live suites with hardened assertions, then removes the container.
 *
 * Safety rules:
 * - never touches an existing container (random name + random loopback port);
 * - never pulls an image unless DB2_HARNESS_ALLOW_PULL=1;
 * - never prints the generated password (output is sanitized).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildDockerRunArgs,
    buildFixtureSql,
    buildJestArgs,
    buildJestEnv,
    parseHostPort,
    readHarnessOptions,
    redactSecret,
} from './db2-live-harness-config.cjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const options = readHarnessOptions(process.env);

const useWsl = process.platform === 'win32';
const dockerPrefix = useWsl ? ['wsl', '-d', options.wslDistro, '--', 'docker'] : ['docker'];
const label = '[db2-live-harness]';

let containerStarted = false;

function log(message) {
    process.stdout.write(`${label} ${redactSecret(message, options.password)}\n`);
}

function warn(message) {
    process.stderr.write(`${label} ${redactSecret(message, options.password)}\n`);
}

function runDocker(args, { input, allowFailure = false, capture = false } = {}) {
    const result = spawnSync(dockerPrefix[0], [...dockerPrefix.slice(1), ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        input,
        maxBuffer: 32 * 1024 * 1024,
    });

    if (result.error) {
        throw result.error;
    }

    const stdout = redactSecret(result.stdout || '', options.password);
    const stderr = redactSecret(result.stderr || '', options.password);
    if (!capture) {
        if (stdout.trim()) {
            process.stdout.write(stdout);
        }
        if (stderr.trim()) {
            process.stderr.write(stderr);
        }
    }

    if (result.status !== 0 && !allowFailure) {
        throw new Error(
            `docker ${args.slice(0, 2).join(' ')} failed with exit code ${result.status}`
                + (stderr ? `: ${stderr.trim()}` : ''),
        );
    }

    return { status: result.status, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Executes a bash script inside the container through stdin.
 *
 * Passing the script through stdin avoids the Windows -> WSL argument quoting
 * layer, which otherwise eats nested `su - ... -c "..."` quotes and produces
 * misleading `SQL1024N` readiness failures.
 */
function execScript(script, execOptions = {}) {
    return runDocker(
        ['exec', '--interactive', options.containerName, 'bash', '-s'],
        { ...execOptions, input: script },
    );
}

function db2Script(sqlStatements) {
    return `su - ${options.user} -s /bin/bash -c ${JSON.stringify(
        `db2 connect to ${options.database} >/dev/null 2>&1; ${sqlStatements}`,
    )}\n`;
}

function sleep(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForReady(deadline) {
    let lastError = '';
    while (Date.now() < deadline) {
        const probe = execScript(
            db2Script('db2 -x "select 1 from sysibm.sysdummy1"'),
            { allowFailure: true, capture: true },
        );

        if (probe.status === 0 && /(^|\n)\s*1\s*($|\n)/.test(probe.stdout)) {
            return;
        }

        lastError = probe.stderr || probe.stdout || 'database not ready';
        log(`waiting for Db2 readiness (${Math.ceil((deadline - Date.now()) / 1000)}s left)`);
        await sleep(options.pollIntervalMs);
    }

    throw new Error(`Db2 did not become ready in time: ${lastError}`);
}

function ensureImageAvailable() {
    const present = runDocker(['image', 'inspect', options.image], {
        allowFailure: true,
        capture: true,
    });
    if (present.status === 0) {
        return;
    }

    if (process.env.DB2_HARNESS_ALLOW_PULL === '1') {
        log(`image ${options.image} missing; pulling because DB2_HARNESS_ALLOW_PULL=1`);
        runDocker(['pull', options.image]);
        return;
    }

    throw new Error(
        `Docker image ${options.image} is not available locally and pulling is disabled. `
        + 'Use a cached image via DB2_HARNESS_IMAGE, for example ibmcom/db2:11.5.8.0, '
        + 'or set DB2_HARNESS_ALLOW_PULL=1 explicitly.',
    );
}

function provisionExplainTables() {
    execScript(db2Script(`db2 -tf ${options.explainDdlPath}`));
    log('EXPLAIN tables provisioned');
}

function provisionFixture() {
    const fixtureSql = buildFixtureSql(options.fixtureSchema);
    const encoded = Buffer.from(fixtureSql, 'utf8').toString('base64');
    execScript(
        `echo '${encoded}' | base64 -d > /tmp/jbl-live-fixture.sql\n`
        + `chown ${options.user} /tmp/jbl-live-fixture.sql\n`
        + db2Script('db2 -tvf /tmp/jbl-live-fixture.sql'),
    );
    log(`fixture schema ${options.fixtureSchema} seeded`);
}

function resolveHostPort() {
    const result = runDocker(['port', options.containerName, '50000/tcp'], { capture: true });
    const port = parseHostPort(result.stdout);
    if (!port) {
        throw new Error(`Unable to resolve published port from: ${result.stdout}`);
    }
    return port;
}

function startContainer() {
    runDocker(buildDockerRunArgs(options));
    containerStarted = true;
    log(`container ${options.containerName} started from ${options.image}`);
}

function teardown() {
    if (!containerStarted) {
        return;
    }

    if (options.keepContainer) {
        warn(`DB2_HARNESS_KEEP=1: leaving container ${options.containerName} running`);
        return;
    }

    const removal = runDocker(['rm', '--force', '--volumes', options.containerName], {
        allowFailure: true,
        capture: true,
    });
    if (removal.status === 0) {
        log(`container ${options.containerName} removed`);
    } else {
        warn(`failed to remove container ${options.containerName}: ${removal.stderr}`);
    }
    containerStarted = false;
}

function dumpDiagnostics() {
    const logs = runDocker(['logs', '--tail', '120', options.containerName], {
        allowFailure: true,
        capture: true,
    });
    if (logs.stdout || logs.stderr) {
        warn('--- container log tail ---');
        warn(`${logs.stdout}\n${logs.stderr}`.trim());
    }
}

function runJest(hostPort) {
    const env = { ...process.env, ...buildJestEnv(options, hostPort) };
    const [command, ...args] = buildJestArgs();
    const result = spawnSync(process.execPath, [command, ...args], {
        cwd: repoRoot,
        env,
        stdio: 'inherit',
    });
    return result.status === 0;
}

async function main() {
    if (!existsSync(resolve(repoRoot, 'jest.live.config.js'))) {
        throw new Error(`Not a JustyBase repository root: ${repoRoot}`);
    }

    ensureImageAvailable();
    startContainer();

    const deadline = Date.now() + options.readyTimeoutMs;
    try {
        await waitForReady(deadline);
        provisionExplainTables();
        provisionFixture();

        const hostPort = resolveHostPort();
        log(`running Db2 live suites against 127.0.0.1:${hostPort}/${options.database}`);

        const passed = runJest(hostPort);
        if (!passed) {
            dumpDiagnostics();
            process.exitCode = 1;
        }
    } catch (error) {
        dumpDiagnostics();
        throw error;
    } finally {
        teardown();
    }
}

main().catch((error) => {
    warn(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
