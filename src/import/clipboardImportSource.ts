import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ClipboardImportSource {
    filePath: string;
    directoryPath: string;
}

/** Delete clipboard snapshots left behind by a previous extension host process. */
export async function removeAbandonedClipboardImportSources(
    storageDirectory: string,
): Promise<void> {
    const importsDirectory = path.join(storageDirectory, 'clipboard-imports');
    let entries: Dirent[];
    try {
        entries = await fs.readdir(importsDirectory, { withFileTypes: true });
    } catch (error) {
        if (isMissingDirectoryError(error)) {
            return;
        }
        throw error;
    }

    for (const entry of entries) {
        await fs.rm(path.join(importsDirectory, entry.name), {
            recursive: true,
            force: true,
        });
    }
    await fs.rm(importsDirectory, { recursive: true, force: true });
}

function isMissingDirectoryError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT';
}

/** Store a private, session-scoped text snapshot for the file-based importer. */
export async function createClipboardImportSource(
    storageDirectory: string,
    text: string,
): Promise<ClipboardImportSource> {
    if (!text.trim()) {
        throw new Error('The clipboard is empty. Copy tabular data and try again.');
    }

    const directoryPath = path.join(storageDirectory, 'clipboard-imports', randomUUID());
    await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const filePath = path.join(directoryPath, 'clipboard.txt');
    await fs.writeFile(filePath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { filePath, directoryPath };
}

export async function removeClipboardImportSource(directoryPath?: string): Promise<void> {
    if (!directoryPath) {
        return;
    }
    await fs.rm(directoryPath, { recursive: true, force: true });
}
