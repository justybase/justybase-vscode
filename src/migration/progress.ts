/**
 * Structured migration progress tracking.
 */

import type { MigrationPhase, MigrationProgress } from './types';

export function formatElapsedSeconds(elapsedMs: number): number {
    return Math.floor(elapsedMs / 1000);
}

export function createMigrationProgress(
    phase: MigrationPhase,
    rowsRead: number,
    totalRows: number | undefined,
    message: string,
    startedAt: number,
): MigrationProgress {
    const percent = phase === 'done'
        ? 100
        : totalRows && totalRows > 0
        ? Math.min(100, Math.round((rowsRead / totalRows) * 100))
        : 0;

    return {
        phase,
        totalRows,
        rowsRead,
        percent,
        message,
        elapsedSeconds: formatElapsedSeconds(Date.now() - startedAt),
    };
}

/**
 * Creates a progress callback throttled to report at most once per interval.
 */
export function createThrottledProgressCallback(
    callback: (progress: MigrationProgress) => void,
    intervalMs: number = 500,
): { report: (progress: MigrationProgress) => void; flush: () => void } {
    let lastReportAt = 0;
    let lastProgress: MigrationProgress | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const report = (progress: MigrationProgress): void => {
        lastProgress = progress;
        const now = Date.now();
        if (now - lastReportAt < intervalMs) {
            if (!timer) {
                timer = setTimeout(() => {
                    timer = undefined;
                    if (lastProgress) {
                        lastReportAt = Date.now();
                        callback(lastProgress);
                    }
                }, intervalMs - (now - lastReportAt));
            }
            return;
        }
        lastReportAt = now;
        callback(progress);
    };

    const flush = (): void => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        if (lastProgress) {
            lastReportAt = Date.now();
            callback(lastProgress);
        }
    };

    return { report, flush };
}
