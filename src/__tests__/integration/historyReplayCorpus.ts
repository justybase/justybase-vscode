/**
 * Replay corpus from the extension's own query history (local measurement only).
 *
 * Reads `query-history*.msgpack.gz` files named in an environment variable,
 * keeps successful statements for one database, removes repeated text and
 * returns them in memory as replay files. Paths are synthetic (`history/<n>.sql`)
 * so reports carry no connection, host or file names. Nothing is written.
 *
 * `worksheets: true` groups consecutive statements of one connection that ran
 * less than {@link WORKSHEET_GAP_MS} apart into one file (`worksheet/<n>.sql`),
 * approximating the editor tab they were written in. Repeated text is removed
 * within a worksheet only.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { gunzipSync } from 'zlib';
import { decode } from '@msgpack/msgpack';
import type { QueryHistoryEntry, StorageData } from '../../core/history/types';
import type { ReplayFile } from '../../knowledge/joinRankingReplay';

export const WORKSHEET_GAP_MS = 30 * 60 * 1000;

export async function loadHistoryReplayCorpus(
    files: readonly string[],
    database: string,
    options: { worksheets?: boolean } = {},
): Promise<ReplayFile[]> {
    const entries: QueryHistoryEntry[] = [];
    for (const file of files) {
        const data = decode(gunzipSync(await fs.readFile(file))) as StorageData;
        entries.push(...(data.entries ?? []));
    }
    const successful = [...entries]
        .sort((left, right) => left.timestamp - right.timestamp)
        .filter((entry) => entry.status !== 'error' && entry.status !== 'cancelled' && !entry.errorMessage)
        .filter((entry) => (entry.database ?? '').toUpperCase() === database.toUpperCase())
        .filter((entry) => (entry.query ?? '').trim().length > 0);
    const keyOf = (entry: QueryHistoryEntry): string => (entry.query ?? '').trim().replace(/\s+/gu, ' ').toUpperCase();

    if (!options.worksheets) {
        const seen = new Set<string>();
        const corpus: ReplayFile[] = [];
        for (const entry of successful) {
            if (seen.has(keyOf(entry))) continue;
            seen.add(keyOf(entry));
            corpus.push({ relPath: `history/${corpus.length + 1}.sql`, text: (entry.query ?? '').trim(), mtimeMs: entry.timestamp });
        }
        return corpus;
    }

    const worksheets: QueryHistoryEntry[][] = [];
    for (const entry of successful) {
        const current = worksheets[worksheets.length - 1];
        const previous = current?.[current.length - 1];
        if (
            previous
            && previous.connectionName === entry.connectionName
            && entry.timestamp - previous.timestamp < WORKSHEET_GAP_MS
        ) {
            current.push(entry);
        } else {
            worksheets.push([entry]);
        }
    }
    return worksheets.map((worksheet, index) => {
        const seen = new Set<string>();
        const statements = worksheet.filter((entry) => {
            const key = keyOf(entry);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        return {
            relPath: `worksheet/${index + 1}.sql`,
            text: statements.map((entry) => (entry.query ?? '').trim().replace(/;\s*$/u, '')).join(';\n'),
            mtimeMs: worksheet[worksheet.length - 1].timestamp,
        };
    });
}

/** `JOIN_REPLAY_HISTORY` holds one or more history files separated by the path delimiter. */
export function historyReplayFilesFromEnv(): string[] {
    return (process.env.JOIN_REPLAY_HISTORY ?? '')
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean);
}
