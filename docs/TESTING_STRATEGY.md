# Testing strategy

Testing is layered so fast feedback catches local regressions while the real
Extension Host catches protocol, renderer, and lifecycle failures.

The cross-project priorities, baselines, and acceptance criteria are tracked in
the [Project Quality Improvement Roadmap](PROJECT_QUALITY_ROADMAP.md). This file
is the canonical policy for choosing test layers and defining stateful or live
test behavior.

## Gates

| Layer | Scope | Command |
| --- | --- | --- |
| Static | TypeScript, contracts, API, web | `npm run check-types`, `npm run check-types:api`, `npm run check-types:web` |
| Lint | Blocking desktop rules plus ratcheted workspace baseline | `npm run lint`, `npm run lint:extended:check` |
| Quality tooling | Versioned baseline/report and changed-code gate helpers | `npm run test:quality-tools`, `npm run quality:report` |
| Unit | Parsers, state machines, providers, utilities | `npm run test:validate` |
| API/web | Fastify routes and React behavior | `npm run test:api`, `npm run test:web` |
| Integration | Local SQLite/DuckDB/Access and configured databases | matching `test:*:integration` script |
| Browser | Bundled webview rendering and recovery | `npm run test:playwright` |
| Extension Host | Real VS Code activation, commands, webview protocol | `npm run test:extension-host` |

The PR baseline is `npm run verify:pr`. Live proprietary databases are nightly
or manual because they require credentials and controlled infrastructure.
`npm run test:coverage` enforces the global floors from
`quality/quality-baseline.json`; on a pull request, the CI unit job also runs
the changed high-risk gate against the pull request base commit. Locally, the
equivalent is `npm run test:coverage:changed` after fetching `origin/master`.

## Change risk and required layers

Every behavior change needs the lowest-cost direct test. Medium- and high-risk
changes also need evidence at the nearest real runtime boundary.

| Risk | Typical changes | Minimum evidence |
| --- | --- | --- |
| Low | Pure utility, copy, non-behavioral documentation | Unit test when behavior changes; `docs:check` for public documentation |
| Medium | Provider, parser, metadata mapping, isolated panel behavior | Direct branch tests, nearest integration/DOM test, coverage review |
| High | Execution, streaming, cancellation, persisted state, authentication, database writes, migrations, shared contracts | Unit/state-machine tests plus real browser, Extension Host, API, or database evidence; failure, cleanup, and compatibility cases |

A mocked happy path is not sufficient for high-risk behavior. The test set must
cover identity, transitions, invalidation, recovery, disposal, and resource
cleanup.

## Coverage and regression policy

Coverage is a risk indicator, not a substitute for behavioral assertions.

- The initial root floors are 71% statements, 58% branches, 76% functions, and
  72% lines. These floors may only move upward.
- Changed high-risk code should reach at least 80% line and 70% branch coverage.
- Generated files must be excluded explicitly rather than lowering thresholds.
- Prioritize migration, activation, views, commands, editors, imports, and
  exports; their baseline is materially below parser and dialect coverage.
- Review uncovered conditions in touched code. Do not add trivial assertions
  only to improve a percentage.

Extended lint follows the same ratchet: the recorded baseline may not increase,
and each cleanup phase lowers the allowed value. The current frozen baseline is
70 warnings (57 `media`, 7 `apps`, 6 `packages`, and 0 `extensions`). The next
cleanup target is zero warnings; the Phase 1B milestone of 100 warnings has
been met.

## Stateful UI contract

Every stateful webview or React surface must document and test:

1. the stable identity of the state owner;
2. which fields are persisted and where;
3. transitions that preserve state;
4. events that invalidate or migrate state;
5. behavior after hide/reveal, reload/revival, and disposal;
6. loading, empty, error, cancellation, retry, and partial-success states;
7. cleanup of timers, listeners, workers, pending requests, and temporary data.

Test the pure state transition first, the bundled DOM/component behavior next,
and a real browser or Extension Host boundary for high-risk lifecycle behavior.
Use observable readiness or protocol acknowledgements instead of fixed sleeps.

## Result-panel scroll contract

Scroll behavior is a protocol contract, not an implementation detail. The
deterministic Extension Host scenario must cover:

1. a wide, virtualized result with enough rows to leave the initial viewport;
2. a non-zero vertical scroll anchor and non-zero horizontal offset;
3. switching to Logs and back to the same result set;
4. switching to a different source and back;
5. hydrate/render settling and debounced scroll persistence;
6. an assertion on both axes, preferably the virtualizer anchor, with a pixel
   tolerance only as a fallback;
7. stable result identity distinct from the Logs identity.

The current fixture uses 12 deterministic rows crossed with itself (144 rows),
drives `scrollResult({ rowIndex: 75, scrollLeft: 320 })`, and captures a
sanitized viewport snapshot. Unit tests additionally verify stable-ID lookup,
legacy timestamp fallback, and rejection of cached state belonging to another
result identity. If the grid persistence algorithm changes, update both levels.

The complete matrix also includes sorting, filters, grouping, expansion, column
order/width/visibility/pinning, formatting, and alternate/disk-backed views.
Exercise Logs/result switching, multiple result sets, multiple sources, panel
hide/reveal, webview revival, pin/close index shifts, refresh, new execution,
active streaming, cancellation with partial data, disk-backed data, empty data,
and initially zero-sized layouts. Prefer an exact virtualizer-anchor assertion;
use pixel tolerance only when no stable anchor is available.

## Execution and asynchronous ordering

Streaming and asynchronous UI tests must include more than normal ordering:

- missing, duplicate, delayed, and out-of-order messages or chunks;
- cancellation before start, during fetch, during render, and during finalize;
- retry/reconnect with `retrying` followed by exactly one terminal `success` or
  `error` status for the logical execution (never an `error` before retry);
- conservative replay safety: only one proven, call-free read-only statement
  may retry, never a write, executable macro, function/sequence expression,
  ambiguous/multi-statement payload, or a stream after its first delivered
  chunk;
- disposal or source switch while work is pending;
- late callbacks that must not update a new/disposed owner;
- row-limit, zero-row, partial-result, multi-statement, and multi-result cases;

The desktop Result Panel enforces this transport matrix with stable result-set
identity, row offsets, monotonic chunk sequences, and authoritative hydrate
recovery. Its scheduled Linux race gate runs the real Extension Host scenario
20 times and retains a per-iteration report plus aggregate summary.
- final assertions that no request, timer, listener, worker, command, or session
  remains active.

## Web, API, and accessibility

React behavior requires component-level jsdom tests in addition to reducer
tests. Cover editor tabs/preferences, connection forms, schema navigation,
result-grid state, dialogs, error/cancellation paths, and restoration after
reload. Playwright covers the bundled application/webview and real keyboard
behavior; Extension Host tests remain the authority for VS Code lifecycle and
message integration.

High-traffic surfaces require automated accessibility checks and keyboard-only
flows. Serious or critical accessibility violations fail the gate. Verify
accessible names, focus entry/return, modal focus containment, Escape/Enter,
grid selection/copy, high-contrast themes, zoom, and reduced-motion behavior.

## Live test hygiene

Live suites must be explicitly selected, fail when required environment
variables are missing, create uniquely named fixtures, and drop them in
`finally`. Unit Jest configurations install a network guard; live configurations
replace it with their database setup. Tests must not call a real driver from a
unit mock—inject a client/transport seam instead.

Conditional CI jobs may decide not to select a credentialed suite when secrets
are unavailable. Once a user or workflow explicitly invokes that suite, missing
configuration is an error rather than a passing skip. Local/container runtimes
such as SQLite, DuckDB, Access, PostgreSQL, MySQL, MSSQL, and ClickHouse should
provide deterministic PR coverage where practical; controlled credentialed
systems provide scheduled contract coverage.

Artifacts are temporary and sanitized. Keep screenshots, traces, exports, and
benchmark output outside source control; inspect screenshots before sharing.

## Flake, stress, and teardown policy

- Do not hide a deterministic failure with retries. Capture trace/artifacts and
  fix the readiness, identity, or cleanup condition.
- Track skipped tests and require an owner/reason for every non-configuration
  skip.
- The full Jest suite must exit naturally. A forced worker exit is a failure of
  the test infrastructure even when assertions pass. The unit network guard
  rejects sockets asynchronously so driver timeout cleanup can run; tests must
  still inject a client/transport seam instead of attempting a real connection.
- Run the Result Panel Extension Host scenario repeatedly on a schedule; 20
  iterations is the standard race-stress value.
- Benchmark on stable runners using multiple samples. Investigate sustained
  three-run median regressions above 15% while preserving existing absolute
  budgets such as the parser construction limit.

## Evidence and maintenance

For a high-risk pull request, record:

- the changed contract or state matrix;
- commands and environments used;
- relevant coverage or benchmark result;
- cleanup and failure-path evidence;
- compatibility, migration, and documentation impact.

When a test becomes the regression contract for a production incident, add the
scenario to the relevant runbook and the quality roadmap rather than relying on
an issue or commit message as its only explanation.
