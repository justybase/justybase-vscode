import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const SAFE_ARGUMENT = /^[A-Za-z0-9_./:=@%+-]+$/;

export class StepFailure extends Error {
    constructor(record) {
        const exit = record.exitCode === null ? '' : ` with exit code ${record.exitCode}`;
        const signal = record.signal ? ` (signal ${record.signal})` : '';
        super(`Step "${record.name}" failed${exit}${signal}.`);
        this.name = 'StepFailure';
        this.record = record;
    }
}

export function formatCommand(command, args = []) {
    return [command, ...args]
        .map(value => SAFE_ARGUMENT.test(value) ? value : JSON.stringify(value))
        .join(' ');
}

export function formatDuration(milliseconds) {
    if (milliseconds < 1000) return `${milliseconds} ms`;
    const totalSeconds = Math.round(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function pushRecord(ctx, record) {
    ctx.steps.push(record);
    return record;
}

/**
 * Run a command with inherited stdio and record the result in the run summary.
 * Throws StepFailure unless allowFailure is set.
 */
export function runStep(ctx, {
    name,
    command,
    args = [],
    cwd = ctx.workDir,
    env = {},
    allowFailure = false,
}) {
    const stage = ctx.currentStage;
    const display = formatCommand(command, args);
    console.log(`\n==> [${stage}] ${name}\n    $ ${display}`);

    const startedAt = performance.now();

    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(command, args, {
                cwd,
                env: { ...process.env, ...env },
                stdio: 'inherit',
                shell: false,
            });
        } catch (error) {
            const record = pushRecord(ctx, {
                stage,
                name,
                command: display,
                status: 'failed',
                exitCode: null,
                signal: null,
                durationMs: Math.round(performance.now() - startedAt),
                error: String(error.message ?? error),
            });
            reject(new StepFailure(record));
            return;
        }

        let settled = false;
        const complete = (status, exitCode, signal, error) => {
            if (settled) return;
            settled = true;
            const durationMs = Math.round(performance.now() - startedAt);
            const record = pushRecord(ctx, {
                stage,
                name,
                command: display,
                status,
                exitCode: exitCode ?? null,
                signal: signal ?? null,
                durationMs,
                ...(error ? { error: String(error.message ?? error) } : {}),
            });

            if (status === 'success') {
                console.log(`<== [${stage}] ${name} (${formatDuration(durationMs)})`);
                resolve(record);
                return;
            }

            if (allowFailure) {
                console.warn(`<== [${stage}] ${name} FAILED (${formatDuration(durationMs)}) - continuing`);
                resolve(record);
                return;
            }

            reject(new StepFailure(record));
        };

        child.once('error', error => complete('failed', null, null, error));
        child.once('close', (code, signal) => complete(
            code === 0 ? 'success' : 'failed',
            code,
            signal,
        ));
    });
}

/**
 * Run a command while capturing stdout/stderr. Used for small inspection
 * commands (git status, versions) whose output feeds later steps.
 */
export function captureCommand(ctx, {
    name,
    command,
    args = [],
    cwd = ctx.workDir,
    env = {},
    allowFailure = false,
    allowedExitCodes = [],
    timeoutMs = 0,
}) {
    const stage = ctx.currentStage;
    const display = formatCommand(command, args);
    console.log(`\n==> [${stage}] ${name}\n    $ ${display}`);

    const startedAt = performance.now();
    const result = spawnSync(command, args, {
        cwd,
        env: { ...process.env, ...env },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs || undefined,
    });

    const durationMs = Math.round(performance.now() - startedAt);
    const exitCode = typeof result.status === 'number' ? result.status : null;
    const acceptable = !result.error
        && (exitCode === 0 || allowedExitCodes.includes(exitCode));
    const status = acceptable
        ? 'success'
        : (allowFailure ? 'allowed-failure' : 'failed');

    const record = pushRecord(ctx, {
        stage,
        name,
        command: display,
        status,
        exitCode,
        signal: result.signal ?? null,
        durationMs,
        ...(result.error ? { error: String(result.error.message ?? result.error) } : {}),
    });

    const output = {
        ...record,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    };

    if (acceptable) {
        console.log(`<== [${stage}] ${name} (${formatDuration(durationMs)})`);
        return output;
    }

    if (result.stderr?.trim()) {
        console.error(result.stderr.trimEnd());
    }

    if (allowFailure) {
        console.warn(`<== [${stage}] ${name} FAILED (${formatDuration(durationMs)}) - continuing`);
        return output;
    }

    throw new StepFailure(record);
}
