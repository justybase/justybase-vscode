import { collectFullSpoolRows, COPY_SPOOL_BATCH_SIZE, MAX_COPY_SPOOL_ROWS } from '../src/copySpool';

function pagedFetcher(allRows: unknown[][]) {
  return async (offset: number, limit: number) => ({
    rows: allRows.slice(offset, offset + limit),
    hasMore: offset + limit < allRows.length,
    totalRows: allRows.length,
  });
}

describe('collectFullSpoolRows', () => {
  it('collects every page with contiguous offsets', async () => {
    const all = Array.from({ length: 25_000 }, (_, index) => [index + 1]);
    const progress: number[] = [];
    const collected = await collectFullSpoolRows(pagedFetcher(all), {
      onProgress: progressState => progress.push(progressState.loadedRows),
    });
    expect(collected).toHaveLength(25_000);
    expect(collected[0]).toEqual([1]);
    expect(collected[24_999]).toEqual([25_000]);
    expect(progress[progress.length - 1]).toBe(25_000);
    expect(COPY_SPOOL_BATCH_SIZE).toBe(10_000);
  });

  it('returns an empty spool without fetching further pages', async () => {
    const fetchPage = jest.fn(async () => ({ rows: [], hasMore: false, totalRows: 0 }));
    await expect(collectFullSpoolRows(fetchPage)).resolves.toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('rejects beyond the clipboard bound with an export fallback hint', async () => {
    const all = Array.from({ length: 10 }, (_, index) => [index]);
    await expect(collectFullSpoolRows(pagedFetcher(all), { maxRows: 5 })).rejects.toThrow(/Use Export instead/);
    expect(MAX_COPY_SPOOL_ROWS).toBeGreaterThan(0);
  });

  it('rejects immediately when already aborted and surfaces in-flight failures', async () => {
    const all = [[1], [2]];
    const preAborted = new AbortController();
    preAborted.abort(new Error('Copy cancelled.'));
    const fetchPage = jest.fn(async () => ({ rows: all, hasMore: false, totalRows: 2 }));
    await expect(collectFullSpoolRows(fetchPage, { signal: preAborted.signal })).rejects.toThrow(/cancelled/i);
    expect(fetchPage).not.toHaveBeenCalled();

    const failing = jest.fn(async () => { throw new DOMException('Aborted', 'AbortError'); });
    await expect(collectFullSpoolRows(failing)).rejects.toThrow('Aborted');
  });

  it('honours an abort signal between pages', async () => {    const all = Array.from({ length: 30_000 }, (_, index) => [index]);
    const controller = new AbortController();
    const collected = collectFullSpoolRows(pagedFetcher(all), {
      signal: controller.signal,
      onProgress: progress => {
        if (progress.loadedRows >= 10_000) controller.abort(new Error('Copy cancelled.'));
      },
    });
    await expect(collected).rejects.toThrow(/cancelled/i);
  });
});
