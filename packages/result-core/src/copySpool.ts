/**
 * Full-spool copy helper shared by Web and Electron.
 *
 * The API keeps the complete result on disk (QuerySessionManager) and serves
 * bounded pages (MAX_PAGE_SIZE = 10_000). The grids historically copied only
 * the loaded page. This helper loops the same filtered/sorted page endpoint
 * until `hasMore` is false, so "Copy all" respects the current view while
 * staying bounded and cancellable.
 *
 * No DOM, navigator, or vscode dependency — adapters decide how to write the
 * collected rows to their platform clipboard.
 */

export const COPY_SPOOL_BATCH_SIZE = 10_000 as const;

/**
 * Upper bound for a clipboard copy. Beyond this the caller should fall back
 * to the streaming export endpoint instead of materialising TSV in memory.
 */
export const MAX_COPY_SPOOL_ROWS = 200_000 as const;

export interface CopySpoolPage {
  readonly rows: readonly (readonly unknown[])[];
  readonly hasMore: boolean;
  readonly totalRows: number;
}

export interface CopySpoolProgress {
  readonly loadedRows: number;
  readonly totalRows: number;
}

export interface CollectFullSpoolOptions {
  /** AbortSignal from the caller's cancel affordance (Esc / Cancel button). */
  readonly signal?: AbortSignal;
  readonly batchSize?: number;
  readonly maxRows?: number;
  readonly onProgress?: (progress: CopySpoolProgress) => void;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error('Copy cancelled.');
  }
}

/**
 * Collects every filtered/sorted row from a paged spool fetcher.
 * The fetcher must honour the same `offset/limit` + view contract as
 * `POST /api/query/:id/page` (contiguous offsets, `hasMore` terminal flag).
 * An empty page always terminates the walk, even when `hasMore` is set.
 */
export async function collectFullSpoolRows(
  fetchPage: (offset: number, limit: number, signal?: AbortSignal) => Promise<CopySpoolPage>,
  options: CollectFullSpoolOptions = {},
): Promise<unknown[][]> {
  const batchSize = Math.min(
    COPY_SPOOL_BATCH_SIZE,
    Math.max(1, Math.floor(options.batchSize ?? COPY_SPOOL_BATCH_SIZE)),
  );
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? MAX_COPY_SPOOL_ROWS));
  const collected: unknown[][] = [];
  let offset = 0;

  for (;;) {
    throwIfAborted(options.signal);
    const page = await fetchPage(offset, batchSize, options.signal);
    throwIfAborted(options.signal);
    if (page.rows.length === 0) return collected;
    for (const row of page.rows) {
      if (collected.length >= maxRows) {
        throw new Error(
          `Result is too large to copy (${page.totalRows.toLocaleString()} rows). Use Export instead.`,
        );
      }
      collected.push([...row]);
    }
    offset += page.rows.length;
    options.onProgress?.({ loadedRows: collected.length, totalRows: page.totalRows });
    if (!page.hasMore) return collected;
  }
}
