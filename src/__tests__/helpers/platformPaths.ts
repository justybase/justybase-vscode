import * as path from 'node:path';

/**
 * Absolute path exactly as File SQL profile/workspace persistence stores it:
 * the host filesystem resolution with forward slashes.
 *
 * Tests must not hard-code POSIX fixtures such as `/data/a.csv` because the
 * same normalization resolves them to `D:/data/a.csv` on Windows.
 */
export function normalizedFilePath(filePath: string): string {
    return path.resolve(filePath).split(path.sep).join('/');
}

/** Native absolute path used by Data Workspace sources and editor commands. */
export function resolvedFilePath(filePath: string): string {
    return path.resolve(filePath);
}
