# Refactoring Plan: VS Code, Web, and Future Electron

## Goal and Principles

Practical modularity means sharing SQL logic, database handling, metadata,
and results while retaining product adapters. Production VS Code extensions
preserve behavior, commands, settings, and companion compatibility. Existing
web/API implementations serve to confirm portability. We are not building a
new Electron application, new web features, or a single GUI for all products.

This plan specifies the migration sequence; it is not a second quality
backlog. Statuses and completion evidence remain in the
[quality roadmap](PROJECT_QUALITY_ROADMAP.md). The
[architecture](ARCHITECTURE.md), [testing strategy](TESTING_STRATEGY.md),
[execution contract](EXECUTION_CONTRACT.md),
[metadata contract](METADATA_CACHE_CONTRACT.md), and
[migration preparation](SHARED_CODE_MIGRATION.md) apply.

## Baseline from the Analysis

- `sql-core` owns the Netezza parser and semantic validation; desktop facades
  and legacy implementations for other dialects still have consumers.
- `designer-core` already separates designer logic from products.
- `database-runtime` is a facade for shared helpers and does not import a
  driver. The instance-scoped `netezza-runtime`, `sqlite-runtime`, and
  `duckdb-runtime` packages own I/O, lifecycle, cancellation, and metadata as
  appropriate. The API has an adapter registry, while the desktop and DuckDB
  companion use the same sessions.
- The desktop metadata cache mixes model rules with VS Code, configuration,
  logging, prefetch, and disk concerns. The API has its cache and connections
  in module state.
- Result Panel concentrates state, transport, persistence, and rendering in
  large coordinators; splitting by line count does not solve this problem.
- Companions import the main extension's implementation. The React client
  binds transport to `window.location` and `document.cookie`.
- The graph report found no violations during the analysis, but it contained
  numerous explicit exceptions and cycles, including type cycles. The counts
  are updated by `architecture:report`; they are not a frozen criterion or a
  list of runtime cycles.
- The initial `test:quality-tools` run failed: the report CLI test could not
  read the JSON. Full product tests were not run at that time. R0 requires
  explaining the cause and collecting reliable results before production
  migration.

## Current closure status (2026-09-10)

The planned refactoring closure slice is implemented on Linux. CQ02 is closed
for the host view, API query use-cases, React workspace, schema provider, and
metadata-prefetch coordinator extractions; CQ06 is closed for the reviewed
resource/lifecycle seams, including explicit SQL-linter timer/cache/disposable
ownership. The architecture graph is clean: `exceptions` and
`cycleExceptions` are empty, and `npm run check:architecture` reports 1,367
production files, 4,490 resolved internal edges, and zero cycles.

The remaining items in the quality roadmap are separate product, coverage,
accessibility, security, live-database, and platform-specific follow-up work;
they are not silently promoted to complete by this closure.

## Target Boundaries

| Layer | Responsibility | Constraints |
| --- | --- | --- |
| contracts | Stable public and transport types | Platform-free; consumer compatibility |
| sql-core | Parsing, validation, and shared authoring mechanisms | No Node, VS Code, React, Electron, or drivers |
| designer-core | Models, capabilities, and pure DDL logic | I/O and rendering belong in adapters |
| result-core, new | Identity, state transitions, and shared data operations | No DOM, transport, or disk |
| metadata-core, new | Keys, merging, completeness, and invalidation | No connections, timers, or disk |
| database-runtime | Execution, cancellation, retry, limits, and cleanup | Database dependencies are passed explicitly |
| Dialect runtime | Driver, connection, catalog, and database behavior | No product dependencies |
| VS Code adapter | Activation, commands, editors, secrets, and webviews | Preserve existing public entry points |
| API | Authorization, transport, and server-instance state | No extension dependencies |
| React/webview | Rendering, interactions, and presentation state | No drivers or secrets |

Imports flow from products toward engines/runtimes and contracts. The product
composition selects the driver. Factories and constructors receive concrete
dependencies; no DI container or global service locator is introduced.

A package is created together with the migrated implementation, its consumer,
and its tests. We do not create empty packages or a universal engine for all
SQL differences. React and webviews retain separate components and editor
integrations.

The future Electron application will manage the backend in the main process,
while the renderer will use the same HTTP client and events as the web. For
now, we are preparing the backend factory, resource shutdown, address
configuration, and engine independence. Preload, IPC, installers, updates,
and system integration are out of scope.

## Implementation Stages

### R0 — Reliable Gates and Documentation

Related: CQ03 and quality/documentation management.

1. Explain the CLI failure: status, stderr, stdout completeness, and launch
   conditions. Fix the cause without weakening assertions.
2. Align the roadmap and migration documents with the current ownership of the
   Netezza parser.
3. Distinguish execution cycles from type cycles; every remaining exception
   must have an owner and a removal condition in the graph configuration.
4. Collect baseline gate results in artifacts outside version control;
   environment limitations and unrun tests do not count as passing.

Acceptance: correct quality tools, consistent documentation, and an explicit
gate status.

### R1 — Package Boundaries

Related: CQ03.

1. Add explicit constraints between shared packages; the `shared` layer alone
   does not define the permitted dependencies of individual engines.
2. Prohibit direct and indirect Node/driver imports from renderers.
3. Replace `packages/.../src/...` imports with public exports, starting with
   the existing SQL facades. Export only the surfaces that are needed.
4. Break small contract and protocol cycles through leaf modules.
5. Remove exceptions after removing the dependency, without automatically
   expanding the baseline.

Acceptance: boundary negative tests, no new exceptions, and correct product
builds.

### R2 — Runtime Pilot: SQLite, DuckDB, and the Netezza Boundary

Status: closed (2026-09-08). The web API has an
instance-scoped runtime registry, `@justybase/sqlite-runtime` shares a session
with the desktop, `@justybase/duckdb-runtime` shares a session with the API
and the DuckDB/File SQL companion, and `@justybase/netezza-runtime` is the
sole owner of the driver import in the production runtime path.
`@justybase/database-runtime` retains compatibility exports without a driver
dependency. Adapters still own the sandbox, secrets, path resolution, and
read-only policy. No Electron application has been created.

1. Share SQLite between the API and desktop while preserving their different
   path, value, and read-only-policy adapters.
2. Share DuckDB between the API and the DuckDB/File SQL companion through an
   explicit optional-module resolver, instance ownership, and a session with
   no path assumptions.
3. Move Netezza I/O into the dialect runtime and preserve the existing
   exports as compatibility facades; the driver is loaded in one module.
4. Replace database selection in the API with an instance registry and remove
   the Netezza/SQLite cycle through independent execution contracts.
5. The runtime receives a resolved path after the product has checked
   permissions, not a server-side StoredConnection. Preserve the file
   sandbox.
6. Base ports on DatabaseConnection/Command/DataReader; add new operations as
   consumers require them. Preserve explicit capabilities and lazy loading.

Acceptance: correct integrations, DuckDB activation and packaging, SQLite/
DuckDB/Netezza value and cancellation compatibility, lifecycle tests, and no
imports of product implementations from runtimes. The formal Windows gate
remains a release-CI task because the current environment is Linux/WSL.

The three closure gates below were completed on 2026-09-08; see
"R2 closure evidence" after the progress list.

Verification progress (2026-09-08, Linux):

- Netezza runtime: 7 tests covering cancellation before and during the
  connection, per-execution database selection, rollback on errors, and
  callback cleanup. Lazy driver loading and compatibility of optional
  configuration fields were restored.
- DuckDB runtime: 9 tests covering the queue, stale cancellation handles,
  closing during loading, catalog reset, concurrent connection, and instance
  ownership.
- API: 15 suites / 84 tests; the global DuckDB facade was removed, and
  runtime availability in Designer comes from the application registry.
- DuckDB/File SQL integrations: 10 / 20 tests respectively; `verify:duckdb`
  and VSIX packaging for DuckDB and the main extension completed successfully.
- Extension Host SQLite: the result panel and Table Designer passed through
  `xvfb-run -a` (an earlier sandbox Chromium startup failure no longer
  occurs).
- Extension Host Netezza (result panel) and companion activation passed.
- Quality-tool tests: 42 passed outside the sandbox; inside the sandbox, the
  child-process CLI test ends with EPERM. Documentation and version checks
  passed. The API/web build passed.
- Live Netezza integrations: 152 passed, 13 skipped, and 1 timeout in
  `netezzaSchemaRefresh.live.integration.test.ts` (catalog-object refresh
  retry, 600 s limit). The cause was an automatic retry during an intentional
  cooldown without starting a new refresh. The test now uses an explicit
  manual retry; the entire refresh suite passed again (4 passed, 2 skipped,
  about 14 s). The full live gate then passed: 13 suites, 153 passed tests,
  and 13 skipped tests (about 67 s).
- The first full desktop run revealed three suites with Netezza import and
  configuration regressions; after the fixes, all three suites passed (133
  tests). The next run passed 543 suites / 9,591 tests, but the branch
  coverage threshold stopped the gate (57.99% with 58% required). Three
  timeout contract tests (zero, positive, and negative) were added, covering
  two missing branches in the Netezza adapter. The rerun passed 543 suites /
  9,594 tests and the branch coverage threshold (58%). Full `verify:pr`
  completed with exit code 0: API 15 suites / 84 tests, web 3 suites / 22
  tests, types, lint, architecture, and final desktop/API/web builds all
  passed.

R2 closure evidence (2026-09-08, Linux):

1. Desktop DuckDB/File SQL lifecycle and cancellation are closed. The
   connection tracks in-flight native executions and only interrupts the
   session for the command at the head of the queue, so cancelling a stale
   command handle no longer kills the next command; `close()` invalidates
   the connection, drains in-flight commands, and only then closes the native
   session; File SQL removes its conversion temp directory when setup fails.
   Regression tests (all first reproduced failing/hanging on the previous
   code): stale-handle cancellation, close during execution, and temp-dir
   cleanup after failed setup. `test:duckdb:integration` 12/12,
   `test:file:integration` 21/21, `check-types:duckdb` and lint pass.
2. The public `SqliteSession` and `node:sqlite` initialization are verified:
   direct ownership/close tests (`packages/sqlite-runtime/__tests__/session.test.ts`)
   cover idempotent close, file-handle release, close after execution error,
   `:memory:` vs file, and `readBigInts` value mode; `test:sqlite-runtime`
   13/13. The real Extension Host runs the result-panel scenario on SQLite
   and the Table Designer gate, both through `xvfb-run -a` (exit 0).
3. A clean checkout without generated `dist/` installs and builds:
   `npm ci`, `npm install` in `extensions/duckdb`, `npm run build`,
   `npm run build:all`, `npm run package` (main VSIX), and
   `npm run package:duckdb` with the CI-style VSIX asset verification
   (`@duckdb/node-api` + platform binding) all pass; the Extension Host
   result-panel scenario also passes in the clean checkout.

The formal Windows gate remains a release-CI task on the current
Linux/WSL environment: `build-main.yml` (windows-latest build/package),
`duckdb-build.yml` (Windows matrix with per-platform binding verification),
and `result-panel-regression.yml` (Windows Extension Host).

### R3 — Shared Result Model and Result Panel

Related: CQ01, CQ04, CQ05.

Status: implementation complete on Linux (2026-09-09). The formal Windows
build/package and Extension Host checks remain release-CI evidence because this
workspace is Linux/WSL; they are not represented as locally passed.

1. Extract result-core: stable identity and pure state transitions.
2. Distinguish source, execution, result set, and storage session; index and
   timestamp are not new identities. Preserve `resultSetId` and the legacy
   fallback.
3. Preserve both protocols; adapters map them to the internal model.
4. Separate coordination, messages, persistence, table configuration, and
   interactions in the host/webview. Preserve the existing facades.
5. Extract shared filtering and aggregation after demonstrating compatibility
   for NULL, decimal, and large numbers. Switch the desktop first, then the
   web reducer.

The host/backend owns execution data; the renderer owns presentation state.
Preserve chunk sequences, offsets, hydration, versioning, and recovery.
Presentation state must not persist entire results as UI state.

Acceptance: two consumers of the shared model, a state and scroll matrix, and
no cycles in the migrated orchestration.

R3 implementation evidence (2026-09-09, Linux):

- `packages/result-core` now owns stable identity, the pure result-panel state
  reducer, portable query-event reduction, exact filtering and aggregation.
  `src/state/resultCoreStateAdapter.ts` bridges the desktop
  `ResultStateManager`; `apps/web/src/queryState.ts` and `apps/web/src/ResultGrid.tsx`
  are the second consumer path.
- Desktop and web persisted grid state use versioned envelopes keyed by
  `resultSetId`, retain the legacy fallback, and do not persist result rows as
  presentation state. Result identity keeps source, execution, result-set and
  storage-session roles distinct.
- The Result Panel graph extraction removed the migrated orchestration cycle;
  `npm run check:architecture` now passes with no configured layer/import or
  cycle exceptions.
- Pure reducer/operation tests, desktop state/scroll/grid tests, web tests and
  the real UI boundaries pass: `npm run test:result-core` (2 suites/15 tests),
  focused desktop Result Panel suites (171 tests plus 55 scroll assertions),
  `npm run test:web` (3 suites/22 tests), the SQLite Extension Host result-panel
  and designer gates, and Playwright `table-rendering.spec.ts` (19/19).
- `npm run verify:pr`, `npm run build`, `npm run build:all`,
  `npm run check-types`, `npm run lint:extended:check`, and the full coverage
  suite pass. The coverage run reports 544 suites/9,604 tests and remains above
  all configured thresholds.

### R4 — Metadata Rules

Related: CQ02, CQ06.

Status: implementation complete on Linux (2026-09-09). Windows and live
database checks remain environment-specific evidence and are not represented
as locally passed.

1. Extract metadata-core: keys, merging, completeness, indexes, and
   invalidation.
2. Preserve exact catalog names; SQL naming rules belong to the dialect.
   Replace unconditional uppercasing of API keys after a regression test for
   name collisions.
3. Separate the prefetch plan from I/O, UI progress, and persistence. Pass
   time into pure TTL rules; timers remain in adapters.
4. The API cache belongs to the instance and its owner/connection. Generation
   tracking discards stale responses. Preserve the current format and disk
   restoration.
5. Preserve full-snapshot replacement and refreshed-type merging, DB..TABLE,
   case sensitivity distinctions, and `dataType` through both SchemaProviders.

Acceptance: shared desktop/API rules, cache restart, VIEW refresh preserving
TABLE, and SQL025/026 working through both adapters.

R4 implementation evidence (2026-09-09, Linux):

- `packages/metadata-core` owns tagged/encoded keys, dialect identifier
  policies, TTL classification, completeness, object-type merge, indexes,
  prefetch planning, scoped invalidation, and generation guards. Its focused
  suite passes 12 tests, including `DB..TABLE`, quoted/unquoted Netezza
  collisions, exact TTL boundaries, refreshed-record precedence, partial
  columns, and per-scope invalidation.
- Desktop adapters delegate stale TTL, prefetch freshness, table-like merge,
  deferred index rebuild, snapshot completeness, and Netezza user identifier
  folding to the shared rules. Existing v1/v2/v3 disk payloads and lazy column
  restoration remain in the desktop disk adapter without a format change.
- API metadata state is owned by `buildServer` through one
  `ApiMetadataService`; keys include owner and connection, non-Netezza case is
  preserved, Netezza quoted names remain distinct, and generation checks block
  late invalidated responses. Schema tree, REST metadata, HTTP LSP completion,
  diagnostics, and WebSocket LSP all use that service.
- Verification passed: `npm run check:architecture`, root `npx tsc --noEmit`,
  metadata-core type/build/tests, the focused metadata suites (242 tests),
  `npm run test:metadata-cache:integration` (19 tests), prefetch/column suites
  (90 tests), and the complete API workspace suite (89 tests). Existing
  restart, VIEW-preserving merge, `FORMAT_TYPE`/LSP `type` propagation, and
  SQL025/SQL026 tests remain green.

### R5 — Execution Orchestration and Resources

Related: CQ02, CQ06, and the execution contract.

1. Separate execution from the editor, messages, history, and authorization.
2. Move the shared single/batch/stream lifecycle into database-runtime with a
   factory for connection providers, configuration, logging, and events.
3. Preserve separate read-only and replay policies: read-only does not mean
   safe repeatability. Do not replay writes or streams after their first
   delivery.
4. Replace global maps with instance state. The desktop singleton may be a
   facade over the instance created during activation.
5. Define the owners of readers, commands, connections, timers, workers,
   files, and subscriptions. Disposing a subscription does not mean
   cancelling or releasing results.
6. Cleanup is idempotent even after an error. Preserve the error cause; remove
   empty catches from migrated paths without exposing secrets.

Acceptance: one terminal execution status, no stale callbacks, a preserved
retry contract, cleanup, and isolation between two backend instances.

Status: completed 2026-09-09.

Closure evidence:

- `@justybase/contracts` defines the additive request, statement, context,
  lifecycle-event, failure and summary model. Events have a monotonic sequence;
  failed/cancelled statements may retain partial row and limit progress.
- `@justybase/database-runtime/execution` owns the instance-scoped execution
  map, phase transitions, one terminal summary, timeout/cancellation, one safe
  reconnect attempt, callback retirement and LIFO resource cleanup. Backend
  methods are bound to their instance, and disposing one orchestrator cannot
  affect another.
- Desktop single, sequential-batch and streaming paths use the same
  orchestrator through `DesktopExecutionBackend`. The adapter retains VS Code,
  history, macros, notices and connection acquisition; the runtime retains
  ordering, retry and terminal-state decisions. The API uses an application-
  owned orchestrator and maps its events to the existing HTTP/WebSocket wire
  protocol without changing that protocol.
- Read-only classification and replay safety remain separate. Replay requires
  a broken persistent connection, no delivered rows, the explicit retry
  policy, and one unambiguous call-free read-only statement. Cancellation
  observed before, during or immediately after reconnect prevents replay.
- `StreamingManager` and the desktop execution coordinator are activation-
  owned instances behind compatibility facades. Their maps and cleanup timers
  are disposed during deactivation. API rate limiting, execution jobs and
  cleanup timers are server-instance state and are drained on close.
- Focused verification covers event order, exactly-once terminal emission,
  observer failure/detachment, timeout, cancellation races, partial streaming
  failure, safe/unsafe retry, cleanup failures and order, persistent/transient
  connections, disposal and two-instance isolation. Architecture passes
  without widening the fingerprinted desktop/companion cycle: desktop imports
  the narrow execution subpath and the adapter uses a structural chunk port.

### R6 — Companions Independent of Core Internals

Status: closed (2026-09-09). All ten optional companions now build against
portable contracts, shared packages, and the public core activation API. Their
production source graph has no edge into `src`; the activation helper is owned
by `@justybase/vscode-companion-adapter`; and the seven designer webviews use
pure DDL builders from `@justybase/designer-core`.

1. Replace `src` imports with contracts, packages, or public core services.
2. Separate pure dialect knowledge, runtime, and activation; do not migrate
   all parsers to a universal implementation.
3. The activation helper belongs to the VS Code adapter. Preserve API v1,
   identifiers, commands, settings, method optionality, and registration.
4. Remove companion imports from webviews; put DDL in pure modules and route
   I/O through the host.
5. Order after DuckDB: Access, PostgreSQL, MySQL, MSSQL, ClickHouse, Db2,
   Oracle, Snowflake, Vertica. Each companion has separate acceptance.

Companion acceptance: no imports of core implementation, activation, packaging,
integrations, and explicitly described live-environment gaps.

Closure evidence (2026-09-09, Linux):

- `@justybase/contracts` owns the companion API v1 surface, database service
  ports, advanced-feature contracts, and designer webview DTOs. Desktop
  facades remain only for compatibility; companions consume the public
  contracts and service ports.
- `@justybase/vscode-companion-adapter` owns VS Code activation and API v1
  validation. All ten companion activation paths use it, preserving extension
  identifiers, dialect registration, declared commands, and optional API
  behavior.
- `@justybase/database-utils`, `@justybase/dialect-utils`,
  `@justybase/file-runtime`, and `@justybase/tabular-import-runtime` own the
  extracted neutral helpers and runtime pieces. `@justybase/designer-core`
  owns the Db2, MySQL, and PostgreSQL pure DDL builders used by both desktop
  webviews and companions.
- Session-monitor providers receive injected service ports; no companion
  provider imports the desktop connection manager or desktop helper modules.
  Maintenance DDL lookup is host-provided, so a separately bundled companion
  never consults a private desktop registry.
- `npm run check:architecture` passes with no configured layer/import or cycle
  exceptions and with the companion-boundary negative check enabled. No
  `extensions/*` production edge targets `src/*`.
- `npm run build:companions`, all ten `verify:<dialect>` packaging paths, and
  the companion activation/register smoke pass. The full deterministic root
  suite passes serially: 545 suites, 9,621 tests, one snapshot.

### R7 — Current API and React

Related: CQ02, CQ06.

Status: implementation complete on Linux (2026-09-10). The route groups,
instance-owned API context, shutdown path, user-scoped React workspace, and
configurable API client are migrated while preserving the existing HTTP,
WebSocket, cookie-authentication, and CSRF contracts.

1. Split routes into auth/admin, connections, queries, results/export,
   metadata, designer, and LSP. Preserve authorization and validation hooks.
2. Extract use cases, instance composition, and backend shutdown.
3. Split React into document, connection, execution, and persistence
   controllers; App remains the composition root. Add cleanup on tab close and
   logout.
4. Make the API client a factory for HTTP/WebSocket addresses and the CSRF
   adapter; preserve cookie authentication. Keep the client in the product
   until there is a second consumer.

Acceptance: compatible web functionality, configurable host, and no mutable
state shared between API instances.

R7 implementation evidence (2026-09-10, Linux):

- `apps/api/src/routes/` owns auth/admin, connections, queries, results/export,
  metadata, designer, and LSP transport. `queryUseCases.ts` owns query,
  edit, and import planning/execution behind an explicit dependency context;
  `applicationContext.ts` composes per-server stores, runtimes, jobs,
  sessions, metadata, rate limiting, and idempotent shutdown; `main.ts` drains
  the Fastify server on SIGINT/SIGTERM.
- `apps/web/src/api.ts` exposes a client factory with injectable HTTP and
  WebSocket origins and CSRF adapter while retaining cookie credentials.
  Workspace documents, execution transitions, connection rules, and
  persistence are covered by focused controllers; persisted keys are scoped
  to the authenticated user and legacy keys migrate without overwriting or
  deleting an unverified copy.
- Regression evidence: the full `npm run verify:pr` gate passed on Linux,
  including 547 root suites / 9,637 tests, API 18 suites / 97 tests, web 9
  suites / 45 tests, type checks, architecture, lint, coverage, and final
  desktop/API/web builds. Coverage was 71.82% statements, 58.16% branches,
  76.58% functions, and 72.42% lines. The real Playwright
  `table-rendering.spec.ts` gate also passed previously (19/19). Live database
  and Windows-specific gates remain environment-specific and were not
  represented as locally passed.

### R8 — Closure

1. Remove replaced implementations after all consumers have migrated. Legacy
   SQL for other dialects retains an owner and a removal condition.
2. Remove old exceptions; ratchet and document the remaining debt.
3. Organize the Access data generator/checksum (CQ07).
4. Update workspaces, builds, packaging, and versions using the existing
   scripts.
5. Tie capabilities to tests and documentation without promoting database
   support.
6. Describe the actual public entry points and the owners of state and
   resources.

Acceptance: a new product does not require imports from VS Code internals;
existing products use real shared implementations.

R8 implementation evidence (2026-09-10, Linux):

- Optional-dialect SQL authoring for ClickHouse, Db2, MSSQL, MySQL, Oracle,
  PostgreSQL, Snowflake, and Vertica now lives in the platform-neutral
  `@justybase/dialect-utils` package. The extension files remain compatibility
  facades, while `src/core/sqlAuthoringRegistry.ts` consumes the shared
  implementations directly.
- Explain, query-profile, stage-workflow, and import-wizard contracts are
  additive members of `DatabaseAdvancedFeatures`. The desktop composition root
  resolves providers through `src/core/connectionFactory.ts`; runtime
  implementations stay in the owning dialect packages. Snowflake's staged
  import/export and wizard planner use the provider seam without changing the
  public companion API v1.
- The 23 stale desktop-to-companion layer exceptions and the remaining
  fingerprinted cycle exceptions were removed. The current graph has 1,367
  production files and 4,490 resolved internal edges, with zero configured
  exceptions and zero cycles. The architecture checker and companion-boundary
  negative check remain blocking gates; the former cycle areas were closed by
  leaf contracts, narrow ports, neutral connection-factory ownership, and a
  host-provided Netezza maintenance callback.
- Access index-code data is reproducible from the pinned
  `JustyBase.UCanAccessCs` commit and six source checksums. The generator has a
  deterministic `--check` gate, the generated file is registered as excluded
  generated data for hand-written size/coverage metrics, and Access keeps its
  independent workspace version policy.
- Public entry points remain explicit: `@justybase/contracts` owns portable
  contracts, `src/core/connectionFactory.ts` owns provider lookup and required
  capability errors, dialect packages own database I/O, and adapters own
  activation, secrets, transport, and resource lifetime.

Final verification (2026-09-10, Linux) passed with `npm run test:quality-tools`
(45/45), `npm run check:architecture`, `npm run check-types`, `npm run lint`,
`npm run lint:extended:check` (62 accepted baseline warnings, 0 errors),
`npm run test:fast` (540 suites, 8,175 tests), `npm run verify:pr` including
coverage (547 suites, 9,637 tests), API (18 suites, 97 tests), web (9 suites,
45 tests), and desktop/API/web builds, plus `npm run docs:check` and
`npm run version:check`. Coverage was 71.82% statements, 58.16% branches,
76.58% functions, and 72.42% lines. Live database, Windows, and any
environment-specific Extension Host gates not run in this audit remain
explicit follow-up evidence.

## Compatibility and Verification

Public companion APIs, wire messages, and HTTP preserve their meaning. The
internal model does not require replacing `data` with `rows` or renumbering
the transport. New required fields and union variants require a compatibility
review. DTOs contain no secrets, driver objects, or VS Code handles. Persistent
format migration is a separate change.

| Area | Scenarios |
| --- | --- |
| SQL | DB..TABLE, quoting, procedures, malformed SQL, SQL025/026, Unicode, completion |
| Execution | Cancel before start/fetch/render/finalize, reconnect, no write replay, partial rows, one terminal state |
| Results | Logs/source/result switching, pin/close, refresh, revival, streaming, disk, empty, zero-sized layout |
| Scroll | Non-zero vertical and horizontal offsets, stable ID, and virtualizer anchor after restore |
| Metadata | VIEW/TABLE merge, case sensitivity, invalidation during load, restart, partial snapshot |
| Values | NULL, decimal, bigint, dates, binaries, aggregation, and export |
| Isolation | Two users and two backends, foreign results and inaccessible files |
| Companions | Public activation, missing driver/capability, packaged VSIX |
| Security | Read-only MCP on both transports, API auth, sandbox, and message validation |

Every stage: the nearest tests, types, lint, and architecture checks. Stage
integration: `npm run verify:pr`, `npm run docs:check`,
`npm run version:check`. SQL additionally requires sql-core, parity, parser,
Extension Host authoring, and the LSP benchmark; MSSQL/Oracle construction
must remain below 2000 ms. Results require Extension Host, Playwright
table-rendering, and web components. Metadata requires disk restart and both
SchemaProviders. Dialects require verify, integration, companion activation,
and packaging. Verify VS Code on Linux and Windows; Remote-WSL requires a
separate environment.

Order: R0 → R1 → R2 → R3 → R4 → R5 → R6 → R7 → R8. Every extraction follows:
behavior test → extraction → desktop facade → VS Code gate → API/web → removal
of the replaced path. Code used only by the API has the appropriate API gate.
Comparison of old and new is test-only, never by executing production SQL
twice. A facade enables returning to the previous delegation, while data
remains readable. Do not mask differences by updating expectations, thresholds,
or fixed sleeps.

## Definition of Done

- Production VS Code preserves behavior and compatibility.
- SQL, results, and metadata have shared owners used by the products.
- Runtime and orchestration do not import products; companions do not import
  core internals.
- Renderers do not depend on Node/drivers; the backend has isolated
  create/close operations.
- Migrated boundaries are acyclic, with no active architecture exceptions;
  remaining product, coverage, accessibility, security, and platform debt is
  tracked separately in the quality roadmap.
- Compatibility, cleanup, and packaging tests confirm operation; gaps are
  explicit.
- Documentation describes the actual state without declaring Electron ready.
