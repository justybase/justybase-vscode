# Execution Contract

This document defines the behavioral contract for query execution in JustyBaseLite-netezza. It serves as the single source of truth for how queries flow through the system, what the result shapes look like, and how cancellation, retries, and streaming work.

## Execution Modes

### 1. Single Query (`singleQueryExecutor.ts`)

**Entry points:**
- `runQueryRaw(options)` — returns structured `QueryResult`
- `runQuery(...)` — legacy JSON wrapper around `runQueryRaw`
- `runExplainQuery(...)` — captures NOTICE messages for Netezza EXPLAIN output
- `runQueryWithCatalog(...)` — temporarily switches database catalog for cross-db queries

**Flow:**
```
runQueryRaw
  → resolveQueryVariables (${var..} substitution)
  → resolveConnectionName
  → clear stale document cancellation flag (document-bound execution only)
  → getConnectionForDocument (persistent or new)
  → streamingManager.executeAndFetch
  → log to history
  → return QueryResult
```

**Retry logic:** On `isConnectionBrokenError`, closes the persistent connection and retries once using the same flow.

**Cancellation note:** single-query execution now clears stale `StreamingManager` cancellation state at the start of a new document-bound run so a previously cancelled execution does not poison the next single-statement run.

### 2. Batch Sequential (`batchQueryExecutor.ts → runQueriesSequentially`)

**Purpose:** Execute multiple SQL statements one-at-a-time over a single connection.

**Flow:**
```
for each query:
  → queryStartCallback (UI: "executing query N/M")
  → streamingManager.executeAndFetch
  → queryEndCallback (success/error/cancelled)
  → logQueryToHistoryAsync
  → resultCallback (partial results to UI)
```

**Key behaviors:**
- Cancellation is checked before each statement and after each execution
- On error, `handleBatchRetry` attempts a reconnect + resume from the failed statement index
- `yieldAfterStatement` pauses briefly after every 5th fast statement to prevent UI starvation
- A single statement can emit multiple `QueryResult` objects when `executeAndFetch(...)` returns multiple internal result sets
- For broken-connection recovery with structured logging, `queryEndCallback` can emit `error` then `retrying` then `success` for the same execution id

### 3. Batch Streaming (`batchQueryExecutor.ts → runQueriesWithStreaming`)

**Purpose:** Execute multiple statements with progressive chunk delivery for real-time UI updates.

**Flow:** Same as sequential, but uses `streamingManager.executeWithStreaming` which delivers data via `onChunk` callback.

## StreamingManager (`StreamingManager.ts`)

Singleton exported from `queryCancellation.ts`, implemented in `src/core/streaming/StreamingManager.ts`. Manages command lifecycle, cancellation, and data delivery.

### Command Registration

| Method | Purpose |
|--------|---------|
| `registerCommand(uri, cmd, sessionId)` | Track an executing command |
| `unregisterCommand(uri)` | Remove after completion |
| `isActive(uri)` | Check if a command is executing |
| `getCommand(uri)` | Retrieve the active command |
| `getActiveUris()` | List all active document URIs |

All URIs are normalized via `normalizeUriKey` for Windows drive-letter case insensitivity.

### Cancellation Protocol

```
User clicks "Cancel"
  → markCancelled(documentUri)
    → cancelledUris.add(normalizedKey)
    → state.isCancelled = true

During execution:
  → isCancelled(documentUri) checked on each row read
  → if cancelled: consumeRestAndCancel(reader, cmd, ...)
    → cancelFirst=true: cmd.cancel() + reader.close()
    → if close fails: fall back to drain loop
    → if drain times out (5s): prompt user for DROP SESSION
    → if user picks "Keep Waiting": extended drain (15s)
    → if extended drain fails: log warning, give up
  → cmd.cancel() called as final step
```

**Important:** `clearCancelled(uri)` must be called at the start of each new document-bound execution sequence to reset stale cancellation flags.

### Row Limits

```
finalRowLimit = maxRows ?? limit (from getQueryConfig)
```

When reached:
- `executeAndFetch`: stops reading, calls `consumeRestAndCancel(cancelFirst=true)`, sets `limitReached=true`
- `executeWithStreaming`: same behavior, sends partial chunk before stopping

### Long Query Alert

If `netezza.longQueryAlertThreshold` is > 0 (default: 10 minutes), a `setTimeout` warning is registered at execution start and cleared in the `finally` block.

## Result Shapes

### QueryResult (single query)

```typescript
interface QueryResult {
  columns: { name: string; type?: string; scale?: number }[];
  data: unknown[][];
  rowsAffected?: number;
  limitReached?: boolean;
  message?: string;      // For DDL/DML with no result set
  sql?: string;          // The executed SQL
}
```

**Invariants:**
- `columns.length === 0` means DDL/DML (no result set) → `message` is set
- `data.length === 0` is valid (zero-row SELECT) → `columns` is still populated
- `limitReached === true` means the server had more rows than `finalRowLimit`
- `rowsAffected` comes from `cmd._recordsAffected`, -1 treated as "unknown"

### StreamingChunk (progressive delivery)

```typescript
interface StreamingChunk {
  columns: { name: string; type?: string; scale?: number }[];
  rows: unknown[][];
  isFirstChunk: boolean;
  isLastChunk: boolean;
  totalRowsSoFar: number;
  limitReached: boolean;
}
```

**Invariants:**
- `columns` is non-empty only on `isFirstChunk === true`
- Final chunk always has `isLastChunk === true` (even if `rows` is empty)
- Zero-row results produce exactly 1 chunk: `{isFirstChunk: true, isLastChunk: true, rows: []}`
- `totalRowsSoFar` is cumulative across all chunks
- Streaming only covers the first result set for a statement; additional result sets are not progressively streamed

### InternalResultSet (multi-result-set)

```typescript
interface InternalResultSet {
  columns: ColumnDefinition[];
  rows: unknown[][];
  limitReached: boolean;
}
```

- `executeAndFetch` returns `InternalResultSet[]` — one per result set
- `executeWithStreaming` only handles the first result set (Netezza convention)

## Type Detection (`resultColumnMetadata.ts`)

Column type resolution follows this priority:

1. **getDeclaredTypeName** (if available) → normalize → return
2. **getColumnMetadata** → check `declaredTypeName` → normalize → return
3. **Character type enrichment** (VARCHAR/NVARCHAR/CHAR/NCHAR):
   - Extract base type from `getTypeName`
   - Find length from: metadata → getTypeLength → schemaTable.ColumnSize → typeMod → declared name
   - Format as `TYPE(length)`
4. **Fallback:** `getTypeName` → normalize

**Numeric scale** is only returned for numeric/decimal/integer/float types (via `NUMERIC_SCALE_TYPE_ALIASES` set). Sources: column metadata → `schemaTable.NumericScale`.

## Retry Protocol

**Conditions for retry:**
- Error matches `isConnectionBrokenError` (TCP reset, ECONNRESET, etc.)
- Not already a retry attempt (`_isRetry === false`)
- Document has a persistent connection (`keepConnectionOpen`)

**Retry flow:**
1. Close the persistent connection (`closeDocumentPersistentConnection`)
2. Re-execute from the failed statement index (batch) or from scratch (single)
3. `queryEndCallback` receives `'retrying'` status

## UI States

| State | Trigger | User Sees |
|-------|---------|-----------|
| **Idle** | No active execution | Empty result panel or previous results |
| **Loading** | `executeReader` pending | Spinner/progress indicator |
| **Partial Results** | Streaming chunks arriving | Progressive row rendering |
| **Complete** | `isLastChunk === true` or `executeAndFetch` returns | Full result grid |
| **Limit Reached** | `limitReached === true` | Result grid + "limit reached" badge |
| **Error** | Exception during execution | Error message in panel |
| **Cancelled** | `markCancelled` + drain complete | "Query cancelled" message |
| **Retrying** | Broken connection detected | "Reconnecting..." message |

## Result Panel Hydration and Export Contract

### Active-source streaming behavior

1. First chunk for the active source causes a full hydrate so the webview receives complete result-set metadata.
2. Subsequent chunks for the same active source are sent incrementally via `appendRows`.
3. Last chunk for the active source is followed by `streamingComplete`, including `totalRows` and `limitReached`.
4. Zero-row streamed results still hydrate as a real result set and still end with `streamingComplete`.

### Inactive-source streaming behavior

1. Background sources buffer streamed rows in `ResultStateManager`.
2. Incremental `appendRows` and `streamingComplete` messages are not sent for inactive sources.
3. Buffered background results become visible on the next hydrate when the source becomes active.

### Cancellation and partial-result behavior

1. `ResultStateManager.cancelExecution(sourceUri, currentRowCounts)` marks result sets as cancelled and truncates buffered rows to the counts reported by the webview when provided.
2. Partial results kept after cancellation remain exportable.
3. Export hydration must ignore stale row indices that no longer exist after truncation rather than throwing.

### Multi-result export behavior

1. Excel multi-sheet export uses `ExportManager.hydrateExportData(...)` as the authoritative hydration step.
2. Empty result sets are skipped.
3. Result-set order, sheet names, and `isActive` flags are preserved for hydrated export items.
4. Column filtering and requested row ordering are preserved per sheet, while stale row indices are ignored.

### Hydration observability

1. Full result-panel hydrate sends emit a structured `result_panel.hydrate` perf event.
2. Event metadata includes hydrate reason, active source, result-set count, total row count, and executing-source count.
3. Payload size is bucketed as `xs`, `s`, `m`, `l`, or `xl` based on serialized MessagePack bytes.
4. After the webview completes a hydrate render pass, it reports `result_panel.first_paint` back to the host with duration, payload size, active source, row counts, and execution state.
5. The host keeps a rolling local sample window for `result_panel.first_paint` so dogfooding sessions can be summarized without parsing raw logs.
6. `netezza.showResultPanelPerformanceStats` is the maintainer-facing entry point for reviewing that rolling first-paint baseline.
7. `netezza.clearResultPanelPerformanceStats` resets that local baseline before a fresh profiling session.
8. Large-payload regressions should be treated as a Phase 4 concern even if correctness tests still pass.

### Result-panel execution state UX

1. The loading overlay remains the blocking affordance while the active source is executing.
2. A lightweight status banner communicates non-blocking execution state for the active source when extra attention is needed: retrying, error, or cancelled. Successful completion should not add a redundant line above the grid.
3. Cancelled executions should explicitly tell the user that partial results may still be available.
4. Error state should remain visible even when the active result set is not the Logs tab.
5. When a source is active but has no buffered results yet, the grid surface should render an explicit empty-state card instead of a synthetic placeholder log.
6. Non-tabular completion states such as DDL success, empty result sets, and invalid render data should render recovery-oriented state cards with short next-step guidance.
7. Banner copy should include the active source label where possible and distinguish between zero-row success, partial-error success, and cancellation with or without retained rows.
8. Result-set tabs should expose lightweight status cues for error, cancelled-partial, and empty-result states so users can navigate to the right surface without relying on the grid banner.
9. Error views should offer a direct recovery path back to `Logs` in addition to Copilot/error details, so diagnostic flow does not depend on manual tab hunting.
10. Row View is a supported record/details surface and should stay reactive to selection changes plus active-result switches, rather than behaving like a static side panel.
11. A dedicated Value Viewer should be available for individual cells with long or structured content, instead of forcing users to inspect everything through Row View or truncated grid cells.

### Disk-backed results (SQLite spill)

See [SQL_RESULTS_FILTERING.md](./SQL_RESULTS_FILTERING.md) for how **Loaded rows**, **All rows + LIMIT**, and **disk-backed** filtering relate.

1. Host spill triggers at `min(memoryRowThreshold, rowThreshold)` (defaults: **25 000** / **500 000**). This is independent of the webview stream cap (`DISK_BACKED_WEBVIEW_STREAM_CAP` = **250 000**).
2. When spill activates during streaming, the host clears `ResultSet.data`, subsequent chunks insert directly into SQLite, and the webview receives `diskBackedActivate` with a first page plus a ~600-row scroll window.
3. While still streaming above the webview cap but before/after spill, the webview may receive `rowCountUpdate` instead of full `appendRows` payloads.
4. After streaming completes, disk-backed sources must **not** be fully re-hydrated into the webview when `node:sqlite` is available.
5. Filters, sort, global search, aggregations, and export operate on the full SQLite store via `DiskQuerySpec` (not the visible window only).
6. Disk-backed grouping uses lazy SQL `GROUP BY` tree expansion (`queryDiskGroups`); group/leaf pages load in 600-row windows with scroll-triggered pagination.
7. Optional idle spill (`idleSpillMinutes`, default **0** = disabled) moves eligible in-memory result sets to SQLite after inactivity; hiding the panel can spill inactive sources immediately when enabled.

## Key Configuration

| Setting | Default | Purpose |
|---------|---------|---------|
| `netezza.queryTimeout` | 0 (none) | Server-side query timeout in seconds |
| `netezza.queryRowLimit` | 100000 | Maximum rows to fetch |
| `justybase.results.diskBackedResults.memoryRowThreshold` | 25000 | Host RAM spill trigger |
| `justybase.results.diskBackedResults.rowThreshold` | 500000 | Hard upper spill bound |
| `justybase.results.diskBackedResults.idleSpillMinutes` | 0 | Idle spill (0 = off) |
| `netezza.longQueryAlertThreshold` | 10 | Minutes before showing "long query" warning |
