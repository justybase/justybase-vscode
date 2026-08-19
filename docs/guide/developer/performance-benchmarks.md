---
title: Data Grid performance benchmarks
description: Measure Result Panel import, export, search, and local SQLite paths with repeatable data and explicit boundaries.
audience: developer
category: Developers
status: Supported
last_verified: 2026-08-19
product_version: 3.16.35
---

# Data Grid performance benchmarks

This suite is a regression instrument for the desktop Result Panel and Import Wizard. It is not a customer-facing SLA and it does not benchmark the Web Editor in the first phase. The result format is versioned as `data-grid.v1` so a future Web Editor adapter can report comparable operation/stage/case identifiers without changing the desktop measurements.

## Scope and matrix

The deterministic generator uses a fixed seed and locale-independent values. It includes numbers, text, dates, timestamps, booleans, `NULL`, long text, and predictable `needle-start`, `needle-middle`, and missing-search cases.

| Profile | Rows × columns | Purpose |
| --- | ---: | --- |
| `small` | 1,000 × 8 | Fast smoke and optional live-import sample |
| `inline` | 10,000 × 8 | Normal in-memory grid and inline search |
| `worker-boundary-19999` | 19,999 × 8 | Just below the worker threshold |
| `worker-boundary-20000` | 20,000 × 8 | Just at the worker threshold |
| `large` | 100,000 × 16 | Worker cold/warm, SQLite, import stream, and exports |
| `wide` | 10,000 × 32 | Reserved for width-sensitive additions |

The Node/Jest matrix currently measures CSV preview/type analysis/validation/SQL generation, full import-stream preparation and consumption, CSV/CSV.GZ/CSV.ZST/JSON/XLSX/XLSB exports, inline search, worker cold and warm search, and SQLite `queryRows()` plus `countRows()`. XML, SQL, Markdown, Parquet, and XPT are registered as `SKIP` cases until they become part of the reference export matrix.

The Playwright matrix loads the real `dist/media/resultPanel.js`, the real `searchWorker.js`, deterministic browser data, and the Result Panel DOM. It measures first grid render, search-hit positions, clearing, the 19,999/20,000 switch, cold/warm worker behavior, rapid-query ordering, and host payload preparation for full and filtered CSV exports. File writing by the host is intentionally outside the payload-preparation metric.

## Metrics and boundaries

Every measured record contains warm-up/sample timings, median, P95, minimum, maximum, row/byte throughput, input/output sizes where available, validation, status, and environment metadata (Node, OS, CPU, memory, Chromium, viewport, worker count, and commit).

- **UI time** is measured in the browser from the operation event to the observable Result Panel state. It includes debounce, worker messaging, and the grid update when that is part of the operation.
- **Worker time** includes structured-clone/load time for a cold worker and excludes the load for a warm worker.
- **Host payload time** ends when the webview posts the export request. Dialogs, database re-execution, file writing, compression in the host, and clipboard work are separate concerns.
- **SQLite time** is local disk-backed query work. It does not include inserting the benchmark fixture; insertion and disposal are setup/cleanup.
- **Network/database time** is not part of local Result Panel search. The optional live case measures the actual file → Netezza import → `COUNT(*)` path and always drops its unique table in `finally`.

Throughput is calculated using the median duration. P95 is a tail-latency signal, not an average. Compare only the same operation, stage, profile, mode, format, and compatible environment.

## Running the suites

```bash
npm run benchmark:data-grid
npm run benchmark:data-grid:live
npm run test:playwright:data-grid-performance
```

The first command runs the local deterministic Jest suite. The live command is a separate opt-in entry point and is `SKIP` when any of `NZ_DEV_HOST`, `NZ_DEV_PORT`, `NZ_DEV_DATABASE`, `NZ_DEV_USER`, or `NZ_DEV_PASSWORD` is absent. The Playwright command builds the bundles, starts a static fixture server, and saves traces on failure.

Current reports are written to ignored `Benchmark/data-grid.v1.results.json` and `Benchmark/data-grid.v1.results.md`. Playwright traces are written below `test-results/data-grid-performance/`.

## Warm-ups, samples, baselines, and alerts

Local measurements use two warm-ups and eight samples. Fixture creation, input-file creation, worker setup for warm runs, and SQLite insertion are outside the timed section. The live suite uses two warm-ups and a small configurable sample count (`DATA_GRID_PERF_LIVE_SAMPLES`, default 3) because each sample performs a remote import and cleanup.

`Benchmark/baselines/data-grid.v1.json` is intentionally empty until three stable Ubuntu/Node 22/Chromium runs are available. A missing or incompatible baseline produces `BASELINE_PENDING`; it does not pretend to be a pass. With a compatible baseline, a median regression over 20% or a P95 regression over 25% produces `WARN`. Warnings are reported without failing normal CI. Set `DATA_GRID_PERF_ENFORCE=1` for release/nightly validation to turn those warnings into a failure after the report is written.

Do not compare a laptop run to a Linux baseline, a different Node major, a different Chromium major, or a different worker count. Populate the baseline only after investigating machine noise and repeating three stable runs.

## Adding a case

1. Add a profile or deterministic value to `Benchmark/dataGridPerformance/data.ts` and document its boundary.
2. Give the operation a stable `operation`, `stage`, `caseId`, `gridMode`, and `format`; do not encode timestamps or machine names in the case ID.
3. Keep setup and cleanup outside the timed section. Validate headers, row counts, decompression, or workbook readability in the same test.
4. Add the browser equivalent only when the operation is observable in a real webview; do not replace the real bundle with a mock implementation.
5. Record a note when a format is registered but deliberately skipped. Never silently drop a matrix cell.

## Troubleshooting

- `BASELINE_PENDING` means the profile/environment has no compatible baseline, not that the operation is healthy or unhealthy.
- A worker cold result includes data loading; compare it with worker warm only when the user workflow actually reuses loaded data.
- A slow XLSX/XLSB result may be writer finalization or workbook serialization. It is not the same as CSV payload preparation.
- A search count mismatch is a correctness failure and should be fixed before interpreting timings.
- If Playwright cannot load `dist/media/resultPanel.js`, run the build first or use the dedicated Playwright script. If the browser emits errors, inspect the retained trace and the fixture console capture.
- For live Netezza failures, verify the five required variables, schema privilege, table cleanup, and whether the driver accepted the generated external stream SQL. Credentials must remain in the environment, never in a fixture or report.

## What the benchmark does not measure

The first phase does not measure Web Editor rendering, database query planning, network throughput for normal Result Panel queries, VS Code paint scheduling outside Chromium, OS file-picker latency, clipboard transfer, user think time, or production telemetry. It also does not claim that a deterministic synthetic distribution represents every customer dataset.

See [Data Grid and Result Exploration](guide/user/data-grid/), [Import and export](guide/user/import-export/), and [Performance and reliability](guide/user/performance-reliability/) for user-facing boundaries.
