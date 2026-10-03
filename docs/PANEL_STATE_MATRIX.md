# Panel state and recovery matrix

This page documents the state contract for stateful webview panels, as required
by [TESTING_STRATEGY.md](TESTING_STRATEGY.md). It follows roadmap item `FQ02`
and is currently focused on Edit Data, Import Wizard, Migration Wizard, and
(already documented elsewhere) the Result Panel.

## Required states

Every stateful panel documents and tests:

1. the stable identity of the state owner;
2. which fields are persisted and where;
3. transitions that preserve state;
4. events that invalidate or migrate state;
5. behavior after hide/reveal, reload/revival, and disposal;
6. loading, empty, error, cancellation, retry, and partial-success states;
7. cleanup of timers, listeners, workers, and temporary data.

## Edit Data

| Aspect | Contract |
| --- | --- |
| State owner | One `EditDataProvider` panel per table; host state is created per panel in `src/views/editDataProvider.ts`. |
| Persisted | Nothing durable. Uncommitted row edits live only in the webview and are lost on reload. |
| Loading | `setLoading` toggles a global busy state and disables the toolbar. |
| Empty | The grid renders an empty state when no rows match the filter. |
| Error | `setError` replaces the grid for the failed load; Refresh retries. |
| Cancellation | None; changing the filter starts a new load and the previous generation is discarded. |
| Race/identity | Per-panel `loadGeneration` guard discards stale load results (newer request wins). |
| Disposal | `onDidDispose` marks the panel disposed and invalidates in-flight loads; `postMessage` failures are swallowed. |
| Save | Reentrant save is rejected while one save is in flight; a failed batch attempts `ROLLBACK`. |
| DDL safety | Column names and type expressions are validated before interpolation; invalid input is rejected. |
| Unsaved changes | The in-panel Close action confirms before discarding edits; a failed reload keeps the working grid and shows a banner. The VS Code tab close cannot be vetoed. |
| Evidence | `src/__tests__/editDataProvider.test.ts` (stale load, dispose, overlapping save, rollback, DDL validation, close). |

## Import Wizard

| Aspect | Contract |
| --- | --- |
| State owner | `ImportWizardMessageHandler` per panel; sessions owned by `ImportWizardService` keyed by `sessionId`. |
| Persisted | Nothing durable; clipboard snapshots live under `globalStorageUri/clipboard-imports/<uuid>` and are swept in activation and on dispose. |
| Loading | Webview shows a loading placeholder until `sessionInitialized`. |
| Empty | Explicit empty preview/columns/warnings states. |
| Error | `executionFailed` renders an error status; session/validation errors now surface instead of rejecting. |
| Cancellation | Background validation can be cancelled; the terminal `cancelled` progress is delivered before the callback is removed. Import execution is aborted cooperatively through an `isCancelled` predicate (shared batch path and Netezza streaming) and stops between batches/rows. |
| Partial success | `executionFinished` renders `success:false` as an error state. |
| Disposal | Session disposed, background validation cancelled, clipboard directory removed; import aborts when the panel closes. |
| Invalidation | The target catalog reloads on `onDidInvalidate`/`onDidExternalRefresh` for the active connection. |
| Evidence | `src/__tests__/importWizardMessageHandler.test.ts`, `src/__tests__/importWizardService.test.ts`, `src/__tests__/backgroundValidationService.test.ts`, `src/__tests__/batchImportCancellation.test.ts`. |

## Migration Wizard

| Aspect | Contract |
| --- | --- |
| State owner | Singleton `MigrationWizardView`; request/plan/source context in host memory. |
| Persisted | Nothing durable; `loadSession` resets a previous plan. |
| Loading | Distinct `analyzing` state disables Analyze/Count/Execute and labels the button. |
| Empty | Plan placeholder until analysis completes. |
| Error | `state.error`/`executionFailed` surface analysis and execution failures; malformed messages are caught at the boundary. |
| Cancellation | Panel dispose sets an `isCancelled` token checked between row pulls, so the transfer aborts instead of writing the rest of the table; the result reports a cancelled phase. |
| Reentrancy | Analyze/Count/Execute reject overlapping work while any of `analyzing`/`counting`/`executing` is set. |
| Disposal | `dispose` marks the view disposed, unsubscribes catalog/metadata listeners, and stops posting to the webview. |
| Invalidation | The source catalog reloads on `onDidInvalidate`/`onDidExternalRefresh` for the source connection. |
| Cleanup | Per-migration temp log directory removed in `finally`; source/target connections closed in the migration service. |
| Evidence | `src/__tests__/migrationWizardView.test.ts`, `src/__tests__/migrationService.test.ts`. |

## Open work

- Serialize volatile webview state so panels can be restored after a VS Code
  window reload (the in-panel close already warns about unsaved changes).
- Extend this matrix to every remaining stateful panel as it is audited.
- Surface messages that arrive during an import transition instead of silently
  dropping them (deliberate short-window race guard today).
