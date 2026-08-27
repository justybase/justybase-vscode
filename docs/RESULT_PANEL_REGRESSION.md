# Result panel regression notes

The complete Extension Host workflow is documented in the
[Result-panel Extension Host runbook](RESULT_PANEL_EXTENSION_HOST_RUNBOOK.md).
This page keeps the focused protocol-regression notes and historical baseline.

The Untitled result-panel race is covered at three boundaries. The tests use the
same source URI and message ordering as the production path, without putting SQL,
rows, credentials, or connection details in diagnostic output. Version 3.16.41 is
a known affected baseline: its webview silently ignores streamed rows when the
authoritative Logs/result-set shell has not reached the client first.

## Fast deterministic checks

```bash
npm run check-types
npx jest --runInBand \
  src/__tests__/resultPanelTrace.test.ts \
  src/__tests__/resultPanelMessageHandler.test.ts \
  src/__tests__/integration/resultPanelView.test.ts \
  src/__tests__/resultPanelHydrateDedup.test.ts
npm run build
npx playwright test --config=test-harness/playwright.config.ts \
  test-harness/tests/table-rendering.spec.ts \
  --grep "hidden|Untitled"
```

The Playwright fixture exercises a real bundled webview. `?protocol=1` starts with
only the Logs result set, then delivers the first and final tabular chunks.
`?protocol=missing-shell` reproduces the affected 3.16.41 client state: tabular
rows arrive for result-set index 1 while the client has no Logs shell. The webview
must request authoritative state and render the returned Logs and data grid. The
hidden/observer case covers the zero-geometry initialization path.

## Real Extension Host

```bash
npm run test:extension-host
```

On a headless Linux/WSL2 shell, wrap it in `xvfb-run -a` (Windows runs the
command directly).

This launches a disposable VS Code Extension Host with a fresh user-data directory,
activates the built extension, creates a real editor through Ctrl+N's workbench
command, inserts SQL, and invokes the production `netezza.runQuery` command. It
does this twice and verifies the reused `untitled:Untitled-1` lifecycle before also
running a deterministic host-streaming scenario. The test-only orchestration
command is registered only when `NODE_ENV=test`; it is not contributed to the
normal command palette. Override the VS Code build with
`RESULT_PANEL_VSCODE_TEST_VERSION=1.103.2` when comparing versions.

The mandatory command always uses the deterministic SQLite fixture. Netezza is
an explicit local-only variant and requires all `NZ_DEV_HOST`, `NZ_DEV_PORT`,
`NZ_DEV_USER`, `NZ_DEV_PASSWORD`, and `NZ_DEV_DATABASE` variables; see the
Extension Host runbook for its isolated-table cleanup contract.

Set `JUSTYBASE_RESULT_PANEL_TRACE=1` to collect the bounded host trace. The trace
contains protocol phases such as `start_execution`, `hydrate_posted`,
`webview.append_received`, and `webview.append_applied`; at most 2,000 records
are retained. It intentionally excludes SQL text, row values, passwords, and
driver payloads.

## Platform matrix

Run the deterministic Jest and webview checks on Linux/WSL2 and Windows. The
Extension Host check should run on both `ubuntu-latest` and `windows-latest` (or
locally on those systems). A WSL2 check is a separate environment from Remote-WSL:
run the command inside WSL2 and repeat it through the VS Code Remote-WSL host when
that deployment is in scope.

The matrix uses a database-free host scenario first. For a driver-backed check,
run the existing DuckDB integration suite with its normal environment:

```bash
npm run test:duckdb:integration
```

Then repeat the same Untitled query manually or through the query command. If a Netezza
development instance is available, repeat it with the `NZ_DEV_*` variables used by
the live integration tests; never add those values to the repository.

When comparing a suspected regression, run the same matrix against the v3.16.41
artifact and the candidate change. Preserve the Output Channel trace and the exact
platform/host mode with the test result. A green natural Extension Host run does
not replace the deterministic missing-shell recovery test because the delivery
race depends on host/webview scheduling.
