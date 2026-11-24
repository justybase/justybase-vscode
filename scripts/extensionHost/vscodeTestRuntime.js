#!/usr/bin/env node

/**
 * Resolve (and, when necessary, download) the VS Code build used by the
 * Extension Host suites.
 *
 * Both Extension Host entry points used to hand `.version` straight to
 * `@vscode/test-electron`, which resolves `stable` through a live CDN request
 * inside the first iteration.  A transient network failure there aborted the
 * whole gate after ~300 ms with an empty failure detail, because the library
 * may reject with a bare string.  Resolving once, before any iteration, with a
 * bounded retry and a readable reason makes the gate deterministic: a cached
 * install needs no network at all, and a genuine outage is reported instead of
 * looking like a scenario failure.
 */
const fs = require('node:fs');
const path = require('node:path');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const DEFAULT_CACHE_PATH = path.join(repositoryRoot, '.vscode-test');
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;

/**
 * Turn any rejection value into a non-empty, log-safe reason.
 * `@vscode/test-electron` can reject with strings (`'Failed to get JSON'`) and
 * with errors that carry no message, so `error.message` alone is not enough.
 */
function describeVSCodeTestFailure(error) {
    if (error instanceof Error) {
        const message = typeof error.message === 'string' ? error.message.trim() : '';
        if (message.length > 0) return message;
        // Node's happy-eyeballs connector rejects with an AggregateError whose
        // own message is empty; the per-address reasons are the useful part.
        if (Array.isArray(error.errors) && error.errors.length > 0) {
            const nested = error.errors
                .map(inner => describeVSCodeTestFailure(inner))
                .filter(inner => inner.length > 0);
            if (nested.length > 0) return `${error.name || 'Error'} (${nested.join('; ')})`;
        }
        if (typeof error.name === 'string' && error.name.length > 0 && error.name !== 'Error') {
            return `${error.name} (no message)`;
        }
        return 'unknown error (no message)';
    }
    const text = typeof error === 'string' ? error.trim() : String(error ?? '').trim();
    if (text.length > 0) return text;
    if (error && typeof error === 'object' && Array.isArray(error.errors) && error.errors.length > 0) {
        return `unknown error (${error.errors.map(inner => describeVSCodeTestFailure(inner)).join('; ')})`;
    }
    return 'unknown error (the VS Code download step rejected without a message)';
}

/**
 * Normalise any thrown value into an `Error` with a usable message.
 *
 * Node's dual-stack connector rejects with an `AggregateError` whose own
 * `message` is empty even though its `errors` carry the per-address reason;
 * keeping such an error unchanged is what produced the empty
 * "iteration(s) failed: " line in CI.
 */
function toVSCodeTestError(error) {
    if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
        return error;
    }
    return new Error(describeVSCodeTestFailure(error));
}

/**
 * Return an executable path for the requested VS Code build.
 *
 * @param {object} [options]
 * @param {string} [options.version] Requested version (`stable` by default).
 * @param {number} [options.attempts] Total download attempts, at least 1.
 * @param {number} [options.timeout] Idle timeout for each network read.
 * @param {string} [options.cachePath] Test-download cache directory.
 * @param {number} [options.retryDelayMs] Base delay between attempts.
 * @param {(options: object) => Promise<string>} [options.download] Injectable downloader.
 * @param {(ms: number) => Promise<void>} [options.sleep] Injectable delay.
 * @param {(message: string) => void} [options.log] Injectable warning sink.
 */
async function resolveVSCodeExecutable(options = {}) {
    const {
        version = 'stable',
        attempts = DEFAULT_ATTEMPTS,
        timeout = DEFAULT_TIMEOUT_MS,
        cachePath = DEFAULT_CACHE_PATH,
        retryDelayMs = DEFAULT_RETRY_DELAY_MS,
        download = downloadAndUnzipVSCode,
        sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
        log = message => console.warn(message),
    } = options;

    const totalAttempts = Number.isInteger(attempts) && attempts >= 1 ? attempts : DEFAULT_ATTEMPTS;
    let lastFailure;
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        try {
            const executablePath = await download({
                ...(version && version !== 'stable' ? { version } : {}),
                cachePath,
                timeout,
                extensionDevelopmentPath: repositoryRoot,
            });
            if (typeof executablePath !== 'string' || executablePath.length === 0) {
                throw new Error(`the VS Code download returned no executable path (got ${String(executablePath)})`);
            }
            if (!fs.existsSync(executablePath)) {
                throw new Error(`the VS Code executable is missing after resolution: ${executablePath}`);
            }
            return executablePath;
        } catch (error) {
            lastFailure = describeVSCodeTestFailure(error);
            log(`VS Code ${version} resolution attempt ${attempt}/${totalAttempts} failed: ${lastFailure}`);
            if (attempt < totalAttempts) await sleep(retryDelayMs * attempt);
        }
    }

    throw new Error(
        `Could not prepare VS Code ${version} for the Extension Host run after ${totalAttempts} attempt(s) `
        + `(cache: ${path.relative(repositoryRoot, cachePath) || cachePath}). Last failure: ${lastFailure}`,
    );
}

module.exports = {
    DEFAULT_CACHE_PATH,
    describeVSCodeTestFailure,
    repositoryRoot,
    resolveVSCodeExecutable,
    toVSCodeTestError,
};
