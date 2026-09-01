# Result-panel Extension Host runbook

This is the deterministic end-to-end gate for the SQL editor result panel. It
starts a fresh VS Code Extension Host, activates the real core extension,
executes production commands, and drives filtering, grouping, disk-backed
queries, source switching, refresh, pinning, and export through the webview
message protocol. The same runner also has a separate SQL authoring smoke
suite for the real editor providers.

## Local SQLite gate

Build and run the mandatory database-free scenario from the repository root:

```bash
npm run test:extension-host
```

The runner creates a temporary SQLite database, SQL file, VS Code profile, and
artifact directory. The fixture is fixed (12 rows) and is removed with the
temporary directory after a successful run. Set
`JUSTYBASE_EXTENSION_HOST_KEEP_ARTIFACTS=1` to retain diagnostics after a
successful run. A failed run retains its temporary directory automatically.

On a headless Linux or WSL2 shell, use a virtual display if the installed
Electron build requires one:

```bash
xvfb-run -a npm run test:extension-host
```

To repeat the complete source-switch/race sequence in a local or nightly run,
set `JUSTYBASE_EXTENSION_HOST_REPEAT` to a value from 1 through 100. Twenty
iterations is the recommended race stress value:

```bash
JUSTYBASE_EXTENSION_HOST_REPEAT=20 npm run test:extension-host
```

Repeated runs write one report and trace per iteration plus a versioned
`*-repeat-summary.json`; artifacts are not overwritten. All requested
iterations run even when one fails, and the command returns a failure after
the aggregate report is written. A weekly Linux workflow runs the recommended
20-iteration gate. Pull requests retain the single Linux/Windows scenario.

The command is intentionally not contributed in `package.json`. The
`justybase.test.extensionHostScenario` command exists only while
`NODE_ENV=test` and `JUSTYBASE_RESULT_PANEL_TRACE=1` are set inside the test
Extension Host.

## Filter performance gate

The real Extension Host filter benchmark exercises a temporary SQLite result
with 4,000 rows and 32 columns through the production SQL command and webview
message bridge:

```bash
npm run test:extension-host:filter-performance
```

It records cold and warm inline searches, a rapid typing burst, and clearing
the filter. Each operation must apply exactly once and report the configured
200 ms quiet period. The generated report contains timings only; the fixture,
SQL file, profile, and artifacts are temporary and are removed after a
successful run. Set `JUSTYBASE_EXTENSION_HOST_KEEP_ARTIFACTS=1` to retain the
sanitized report.

## Netezza run

The same scenario and assertions can be run against a development Netezza.
All required variables must be present; an explicitly requested run with a
missing variable fails as a configuration error and is never silently skipped.

```bash
export NZ_DEV_HOST=...
export NZ_DEV_PORT=5480
export NZ_DEV_USER=...
export NZ_DEV_PASSWORD=...
export NZ_DEV_DATABASE=...
export NZ_DEV_SCHEMA=...          # optional
npm run test:extension-host:netezza
```

The test creates a uniquely named quoted table, inserts only the fixture rows,
and drops it in `finally`. It does not update or delete a durable user table.
Credentials are read only from the process environment and never written to a
report or trace.

## SQL authoring smoke

Run the provider and command checks in a fresh Extension Host without a
database connection:

```bash
npm run test:extension-host:authoring
```

The suite activates the real extension and checks command registration,
Plain Text-to-SQL editor creation, document symbols, formatting, semantic
tokens, references, hover, rename, signature help, and the
Settings webview command in three scenarios: editor lifecycle,
navigation/refactoring, and command/settings surface.

## Scenario map

The single deterministic scenario covers these protocol boundaries:

- saved `file:` SQL with two statements, Logs-first ordering, streaming chunks,
  and a second result tab;
- disk-backed `window`, `count`, `distinct`, aggregation, and group queries;
- global Unicode filter, column filter, database distinct/filter, and five
  database aggregation functions;
- one- and two-column database grouping with a sanitized SQL fingerprint;
- refresh, CSV/JSON/Markdown export, DML/rows-affected, empty result, SQL
  error/retry path, and multiple `untitled:` sources;
- result-set/source switching, pinning, and the stale-source guard;
- final host and webview pending-request counts, including filter, grouping,
  aggregation, disk, sync, and bridge watchdogs.

The webview driver sends `testBridge` messages through the same channel as
normal result-panel traffic. It does not mutate the webview's private state.
Each operation waits for the host handler, the host response, and the webview
application of that response.

## Artifacts and trace

The runner writes two bounded JSON files:

- `<engine>-result-panel-report.json` — scenario status, row counts, protocol
  command names, sanitized phases, and duration;
- `<engine>-result-panel-trace.json` — sequence/timestamp/origin plus bounded
  lifecycle counters and phase names.

The optional screenshot mode writes renderer captures separately from JSON
diagnostics:

```bash
npm run test:extension-host:screenshots
npm run test:extension-host:authoring:screenshots
```

The files are written below `artifacts/extension-host/screenshots/` by default:

```text
screenshots/<suite>/<engine>/iteration-1/01-result-grid.png
screenshots/<suite>/<engine>/iteration-1/03-settings.png
screenshots/<suite>/<engine>/iteration-1/manifest.json
```

Use `JUSTYBASE_EXTENSION_HOST_ARTIFACT_DIR` to place the complete artifact
tree elsewhere. Screenshots are captured from the VS Code Chromium renderer
through CDP, so they include the workbench and webviews but not the native
window frame or title bar. Screenshot mode is opt-in and automatically keeps
the local artifacts after a successful run. The result-panel GitHub Actions
workflow exposes the same option as the `capture_screenshots` manual input.

Screenshots can contain visible SQL and result values. Use them only with
controlled fixtures, especially for the Netezza variant, and review them
before sharing or uploading outside a trusted CI artifact.

The trace writer uses an explicit field allow-list and omits errors, SQL,
records, driver payloads, and secrets. Do not add raw payloads to trace events.
CI retains these files with the `result-panel-extension-host-*` artifact name.

## Companion Extension Host smoke

Activation and dialect registration for each configured companion can be checked
with:

```bash
npm run test:extension-host:companions
```

This validates core + companion activation, dialect registration, and every
command declared by the companion manifest. Provider-specific live SQL remains
in the existing provider integration suites; it requires that provider's own
environment and is not part of the mandatory SQLite pull-request gate.

## Playwright webview complement

The static webview fixture is deterministic and tests the actual bundled DOM:

```bash
npx playwright install --with-deps chromium
npx playwright test --config=test-harness/playwright.config.ts \
  test-harness/tests/table-rendering.spec.ts
```

It asserts rendered row counts and records after global/column filtering,
opens the grouping panel and verifies grouped rows, covers hidden-view recovery,
and exercises the Logs-before-streamed-rows protocol plus missing-shell hydrate
recovery. This suite complements the Extension Host gate; an external live
Netezza workspace is not a substitute for either deterministic check.

## WSL2 and Remote-WSL

WSL2 and Remote-WSL are different Extension Host placements. Run the SQLite
command inside WSL2 as a local host check. When the deployment uses the VS Code
Remote-WSL extension, repeat it after opening the repository through Remote-WSL
so the extension, filesystem, and Electron host all run in the intended mode.
Keep those results separate in diagnostics; a successful WSL2 shell run does
not prove Remote-WSL behavior.
