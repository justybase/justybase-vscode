import {
  buildFilterHistoryScope,
  getFilterHistoryAvailability,
  getFilterHistoryTarget,
  moveFilterHistoryCursor,
  recordFilterHistorySnapshot,
} from "../../media/resultPanel/state";
import type { FilterHistorySnapshot } from "../../media/resultPanel/state";

function snapshot(globalFilter: string): FilterHistorySnapshot {
  return { globalFilter, columnFilters: [], sorting: [], filterScope: 'loaded' };
}

describe("result panel filter history", () => {
  it("records per-result transitions and supports undo/redo", () => {
    const resultSet = { resultSetId: "result-a", columns: [], data: [] };
    const scope = buildFilterHistoryScope("file:///a.sql", resultSet, 0);
    recordFilterHistorySnapshot(scope, snapshot(""));
    recordFilterHistorySnapshot(scope, snapshot("ALPHA"));
    recordFilterHistorySnapshot(scope, snapshot("ALPHA 1"));

    expect(getFilterHistoryTarget(scope, "undo")?.globalFilter).toBe("ALPHA");
    expect(moveFilterHistoryCursor(scope, "undo")).toBe(true);
    expect(getFilterHistoryAvailability(scope)).toEqual({ canUndo: true, canRedo: true });
    expect(getFilterHistoryTarget(scope, "redo")?.globalFilter).toBe("ALPHA 1");
    expect(moveFilterHistoryCursor(scope, "redo")).toBe(true);
    expect(getFilterHistoryAvailability(scope)).toEqual({ canUndo: true, canRedo: false });
  });

  it("isolates result identities and leaves the cursor unchanged until restore succeeds", () => {
    const first = buildFilterHistoryScope("file:///a.sql", { resultSetId: "first", columns: [], data: [] }, 0);
    const second = buildFilterHistoryScope("file:///a.sql", { resultSetId: "second", columns: [], data: [] }, 0);
    recordFilterHistorySnapshot(first, snapshot("one"));
    recordFilterHistorySnapshot(first, snapshot("two"));
    recordFilterHistorySnapshot(second, snapshot("other"));

    // A failed async database restore never calls moveFilterHistoryCursor.
    expect(getFilterHistoryAvailability(first).canUndo).toBe(true);
    expect(getFilterHistoryAvailability(second)).toEqual({ canUndo: false, canRedo: false });
    expect(getFilterHistoryTarget(first, "undo")?.globalFilter).toBe("one");
  });
});
