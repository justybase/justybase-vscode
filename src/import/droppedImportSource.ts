import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const DROPPED_IMPORT_DIRECTORY = 'import-drops';
const ABANDONED_SOURCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function getDroppedImportDirectory(storageDirectory: string): string {
    return path.join(storageDirectory, DROPPED_IMPORT_DIRECTORY);
}

/** Persist a dropped file in private extension storage and return its path. */
export async function stageDroppedImportSource(
    storageDirectory: string,
    fileName: string,
    data: Uint8Array,
): Promise<string> {
    const directory = getDroppedImportDirectory(storageDirectory);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const safeName = path.basename(fileName).replace(/[^A-Za-z0-9._-]+/g, '_');
    const filePath = path.join(directory, `${randomUUID()}-${safeName}`);
    await fs.writeFile(filePath, data, { flag: 'wx', mode: 0o600 });
    return filePath;
}

/** Delete a staged dropped file. Paths outside the staging directory are ignored. */
export async function removeDroppedImportSource(
    storageDirectory: string,
    filePath?: string,
): Promise<void> {
    if (!filePath) {
        return;
    }
    const directory = getDroppedImportDirectory(storageDirectory);
    if (!filePath.startsWith(`${directory}${path.sep}`)) {
        return;
    }
    await fs.rm(filePath, { force: true });
}

/**
 * Remove staging copies left behind by an earlier extension-host process.
 * Only old files are removed so another VS Code window can keep using a fresh
 * dropped source while it is still importing.
 */
export async function removeAbandonedDroppedImportSources(
    storageDirectory: string,
    now = Date.now(),
): Promise<void> {
    const directory = getDroppedImportDirectory(storageDirectory);
    let entries: Dirent[];
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (isMissingDirectoryError(error)) {
            return;
        }
        throw error;
    }

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }
        const filePath = path.join(directory, entry.name);
        try {
            const stat = await fs.stat(filePath);
            if (now - stat.mtimeMs >= ABANDONED_SOURCE_MAX_AGE_MS) {
                await fs.rm(filePath, { force: true });
            }
        } catch {
            // A concurrent import may have removed the file already.
        }
    }
}

function isMissingDirectoryError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT';
}
