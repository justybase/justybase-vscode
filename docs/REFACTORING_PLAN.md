# Refactoring Plan: VS Code, Web, and Future Electron

## Goal and Principles

Practical modularity means sharing SQL logic, database handling, metadata,
results, and the presentation of the main user workflows while retaining
product adapters. Production VS Code extensions preserve behavior, commands,
settings, and companion compatibility. Existing web/API implementations serve
to confirm portability. R0–R8 establish the portable backend and ownership
boundaries; R9 adds near-parity UI for the web, Electron, and VS Code without
creating one universal UI for every dialect-specific product feature.

This plan specifies the migration sequence; it is not a second quality
backlog. Statuses and completion evidence remain in the
[quality roadmap](PROJECT_QUALITY_ROADMAP.md). The
[architecture](ARCHITECTURE.md), [testing strategy](TESTING_STRATEGY.md),
[execution contract](EXECUTION_CONTRACT.md),
[metadata contract](METADATA_CACHE_CONTRACT.md), and
[migration preparation](SHARED_CODE_MIGRATION.md) apply. R9 maintains the
[cross-product UI parity matrix](CROSS_PRODUCT_UI_PARITY.md); that matrix is
the operational inventory, while this document defines the migration rules
and gates.

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
production files, 4,492 resolved internal edges, and zero cycles. The live
Netezza integration gate also passes on Linux; Windows and Remote-WSL remain
platform-specific evidence.

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
| ui-core, new | UI state transitions, ports, persistence envelopes, and capability descriptors | No React, DOM, Node, VS Code, Electron, drivers, or secrets |
| ui-react, new | Shared React components, tokens, layout, focus, and keyboard interaction | No Node, VS Code, Electron, drivers, or direct platform effects |
| database-runtime | Execution, cancellation, retry, limits, and cleanup | Database dependencies are passed explicitly |
| Dialect runtime | Driver, connection, catalog, and database behavior | No product dependencies |
| Electron adapter, new | Dev/test main-process lifecycle and loopback composition | No Electron APIs in shared packages; no installer or auto-update in R9 |
| VS Code adapter | Activation, commands, editors, secrets, and webviews | Preserve existing public entry points |
| API | Authorization, transport, and server-instance state | No extension dependencies |
| React/webview | Shared rendering, interactions, and presentation state | No drivers or secrets; platform effects go through adapters |

Imports flow from products toward engines/runtimes and contracts. The product
composition selects the driver. Factories and constructors receive concrete
dependencies; no DI container or global service locator is introduced.

A package is created together with the migrated implementation, its consumer,
and its tests. We do not create empty packages or a universal engine for all
SQL differences. R9 may share React presentation components across web,
Electron, and selected VS Code webviews, while editor integrations and
platform-specific capabilities remain adapter-owned.

The Electron development/test shell manages the backend in the main process,
while its renderer uses the same HTTP client boundary as Web after
main-owned authentication. Preload, IPC, lifecycle cleanup, and secret
redaction are implemented for this shell; installers, updates, and system
integration remain out of scope.

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
read-only policy. R9 now adds a separate Electron development/test shell;
there is still no production installer or system integration.

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

Status: implementation complete on Linux (2026-09-09). The live Netezza
integration gate passes on Linux; Windows and Remote-WSL checks remain
environment-specific evidence.

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
  `table-rendering.spec.ts` gate also passed previously (19/19). The real
  SQLite Extension Host result-panel, Table Designer, and authoring gates
  passed on Linux; the live Netezza gate passed with 13 suites / 153 tests.
  Windows-specific and Remote-WSL gates remain environment-specific and were
  not represented as locally passed.

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
  production files and 4,492 resolved internal edges, with zero configured
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
`npm run version:check`, `npm run build:companions`, the SQLite
`test:extension-host`, `test:extension-host:designer`, and
`test:extension-host:authoring` gates, and the live Netezza gate (13 suites,
153 passed tests; 2 suites skipped by the harness). Coverage was 71.82%
statements, 58.16% branches, 76.58% functions, and 72.42% lines. Windows and
Remote-WSL gates remain explicit follow-up evidence.

### R9 — Cautious cross-product UI parity rollout

Status: in progress. The shared `ui-core`/`ui-react` foundation, coverage
enforcement, authenticated Electron development/test shell, Web shared
composition, and opt-in Web/Electron/VS Code Result Panel vertical slices are now in
the working tree. Full first-tier parity remains open; `legacy` is still the
default until each slice passes all three product gates. R9 is a
strangler-style product-surface migration after the
R0–R8 refactoring closure. It targets near-parity for the main workflows in
the Web editor, the Electron development/test shell, and VS Code webviews. The objective is
shared behavior, layout, interaction vocabulary, and capability coverage;
pixel-perfect identity is not required where window, filesystem,
authentication, or editor semantics differ.

R9 does not authorize a big-bang rewrite or a universal renderer for every
dialect-specific feature. The existing renderer remains the fallback until the
corresponding slice has passed every product gate. Comparison uses shared
contracts, controlled fixtures, and traces; production SQL is never executed
twice merely to compare old and new UI paths.

#### R9.1 — Freeze the baseline and parity contract

1. Preserve any pre-existing working-tree changes in this plan and record the
   baseline environment: `git status`, relevant diff, Node/npm, OS, VS Code,
   and Chromium versions. Missing environment-specific tools are recorded as
   unavailable evidence, never treated as a passing gate.
2. Maintain the [cross-product UI parity matrix](CROSS_PRODUCT_UI_PARITY.md)
   from contributed commands, registered views, webviews, React routes, API
   routes, and capability descriptors. Every row names the state owner,
   resource owner, actions/shortcuts, loading/empty/error/cancel states,
   persistence and identity, capability/auth requirements, tests, and known
   differences.
3. Classify each surface as `shared`, `adapter-backed`, or
   `platform-specific`. A platform-specific limitation needs an explicit
   capability state, owner, documentation, and removal condition; it must not
   disappear silently from a product.
4. The mandatory first tier is: shell and workspace tabs, SQL editor/LSP,
   connections, query execution and cancellation, Result Panel/Data Grid,
   schema navigation, history, Explain, and common designer workflows.
5. The second tier is import/export, notebooks, visual query/ERD/ETL,
   database administration, and advanced analysis. The matrix records whether
   each is migrated or deliberately capability-gated.

#### R9.2 — Establish the shared UI boundary

1. Add `packages/ui-core` as `@justybase/ui-core`. It owns serializable UI
   state and transitions for shell/workspace, execution, metadata, and
   results, plus ports and capability descriptors. It may consume additive
   contracts and existing pure cores, but cannot import React, DOM, Node,
   VS Code, Electron, browser storage, drivers, or secrets.
2. Add `packages/ui-react` as `@justybase/ui-react`. It owns shared React
   components, design tokens, layout primitives, focus management, keyboard
   navigation, and loading/empty/error/cancel presentations. It cannot import
   VS Code, Electron, Node, database runtimes, or platform effects directly.
3. Define ports for storage, clipboard, dialogs/notifications,
   document open/save, command dispatch, navigation, capability discovery,
   editor/LSP, metadata, execution, and results. The result port supports
   paging, streaming chunks, cancellation, hydration, filtering, sorting,
   grouping, aggregation, pivot/alternate views, row detail, guarded edits,
   export, and stable `resultSetId` identity.
4. Extend `quality/architecture-rules.json`, the architecture checker and its
   negative tests, TypeScript/build configuration, and architecture docs for
   the UI and Electron layers. Do not add import exceptions or cycles to make
   the boundary pass.
5. Before the first R9 UI production file is added, extend the changed-code
   coverage enforcement: `quality/quality-baseline.json`, the diff scope in
   CI and `test:coverage:changed`, and the LCOV/package gates must cover
   `media`, `apps/web`, `apps/electron`, `packages/ui-core`, and
   `packages/ui-react`. If one root LCOV cannot represent all consumers, use
   separate package/app LCOV gates and aggregate their failures. The 80% line
   and 70% branch rule must be executable for these paths, not only stated in
   this plan.
6. Keep HTTP, WebSocket, webview, and companion contracts additive. New DTOs
   belong in `@justybase/contracts` and contain no credentials, driver
   instances, VS Code handles, or DOM objects.

#### R9.3 — Build adapters around one shared presentation

1. **Web/API:** map the existing API client, REST, and WebSocket events to
   `ui-core` controllers and `ui-react`; keep authentication, CSRF, file
   authorization, and user-scoped persistence in the API/web adapter. The
   current `Login` and `ConnectionForm` temporarily hold user-entered
   passwords in Web form state, so they are not treated as an Electron secret
   boundary until they are port-driven.
2. **Electron:** create only a development/test shell under `apps/electron`.
   The main process starts the existing API/server factory on loopback and
   owns start, stop, and cleanup. The renderer loads the same React bundle and
   uses the HTTP/WebSocket flow only after an Electron-owned authentication
   session exists. An `AuthPort`/secret broker over the preload boundary (or a
   main-process native credential dialog) keeps stored database passwords in
   the main process; the renderer receives only redacted profiles and opaque
   session/capability results. The shared Web form must not be reused for raw
   Electron connection secrets, and secrets may not enter renderer state,
   IPC payloads, persistence, logs, or URL values. The current
   `npm run test:electron` gate runs the Electron workspace Jest suite: its
   startup tests use an injected API factory/fetcher, and its smoke tests
   cover the broker, redaction, and IPC contracts. It does not launch a real
   Electron window, read `JUSTYBASE_*` environment variables, or verify
   process/resource cleanup through a close event. The following are future
   acceptance criteria for promoting the development shell to a full Electron
   smoke gate: start the API with an isolated data directory and explicit
   test-only `JUSTYBASE_MASTER_KEY`, `JUSTYBASE_ADMIN_USER`, and
   `JUSTYBASE_ADMIN_PASSWORD` values; log in using that provisioned
   admin/session; use controlled data; launch and close the window; and verify
   API shutdown plus timer, socket, session, and temporary-profile cleanup. A
   random master key alone does not provision a login. No installer,
   auto-update, or system integration is part of R9.
3. **VS Code:** host the migrated React components in webviews. The adapter
   translates webview messages and Extension Host commands to shared ports,
   preserving current host semantics, activation, secrets, workspace
   ownership, and public commands. Shared packages never import `vscode`.
4. Use capability descriptors and adapter-owned commands for filesystem
   access, document navigation, administration, native dialogs, dialect
   features, and guarded writes. Do not scatter product checks through JSX.
   Authentication and connection-secret capabilities must identify their
   owner and whether the renderer may collect only ephemeral login input or
   must delegate the prompt entirely to the host.
5. Keep tokens for spacing, typography, colors, focus, density, icons, tables,
   menus, dialogs, and status states in `ui-react`; product shells may add
   chrome but not change migrated interaction semantics.

#### R9.4 — Migrate vertical slices in risk order

Every slice follows the same order:
`characterization test → port/state extraction → adapter → Web → Electron →
VS Code → all-product tests → removal of the old path`. The `legacy/shared`
feature flag defaults to `legacy`; `shared` becomes the default only after the
slice passes all gates.

1. **Foundation:** create the ports, capability descriptors, tokens,
   persistence adapters, route/command mapping, feature flag, and Electron
   dev/test shell with lifecycle tests.
2. **Results first:** migrate Result Grid and tabs, Logs/result switching,
   filtering, sorting, grouping, aggregation, pivot/alternate views, row
   detail, copy/export, streaming, cancellation, disk-backed results,
   hydration, scroll restoration, zero-sized/empty/error states, and guarded
   edit. Retain the current desktop grid as fallback during the migration.
3. **Workspace/authoring:** migrate shell, documents/tabs, connections,
   Monaco/LSP authoring, history, and Explain. The VS Code adapter retains
   existing Extension Host semantics while the shared controller owns the
   portable transitions.
4. **Schema/designers:** migrate schema navigation and common table, index,
   and partition designer workflows, plus portable visual-query, ERD, and ETL
   components. `designer-core`, database-specific DDL, capability checks, and
   database operations remain adapter-owned where required.
5. **Second tier:** migrate import/export, notebooks, advanced analysis, and
   administration only when their contracts are portable. Otherwise expose a
   visible capability state with a documented owner and removal condition.
6. Remove the legacy renderer only for a slice that has passed Web, Electron,
   VS Code, browser/Extension Host, compatibility, lifecycle, and security
   gates. Do not introduce a second production SQL execution path.

#### R9.5 — State, compatibility, and resource safety

- Shared UI state stores identity, view configuration, and user choices only;
  never complete results, passwords, drivers, or VS Code handles.
- Keep distinct source, execution, result-set, and storage identities. Result
  persistence is keyed by stable `resultSetId`, uses versioned envelopes, and
  retains a legacy read fallback until all products have migrated and the
  documented cleanup window has elapsed.
- Web persistence is user-scoped, Electron persistence is profile-scoped, and
  VS Code persistence retains each feature's actual ownership. In particular,
  `QueryHistoryManager` currently stores history below
  `context.globalStorageUri`; `globalState` is used for legacy migration and
  saved-view/configuration values. A future workspace/profile scope change
  requires an explicit versioned migration, visibility review, and retention
  decision. Serializers may be shared; storage lifetime belongs to the product
  adapter.
- Every adapter owns and deterministically cleans up listeners, timers,
  workers, sockets, sessions, temporary files, and subscriptions. Shutdown and
  failed initialization are idempotent.
- Negative tests cover foreign result identities, malformed messages,
  unauthorized files, auth/CSRF failures, read-only write rejection,
  unavailable capabilities, reconnect, delayed/duplicate events, and no live
  resources after shutdown.

#### R9.6 — Verification and acceptance gates

| Moment | Required evidence |
| --- | --- |
| Baseline and every slice | `npm run check:architecture`, `npm run check-types`, `npm run lint`, `npm run lint:extended:check`, and focused tests; skipped environment gates are recorded, not passed. |
| Changed UI coverage enforcement | CI and local changed-coverage input include `media`, `apps/web`, `apps/electron`, `packages/ui-core`, and `packages/ui-react`; each changed UI file has an LCOV/package gate at least 80% lines and 70% branches. |
| `ui-core` / `ui-react` | Reducer, port, capability, persistence, React component, focus, keyboard, and accessibility tests, including loading/empty/error/cancel states; changed-code coverage must include the UI paths before their shared flag is enabled. |
| Result Panel | `npm run test:result-core`, Web tests, `test-harness/tests/table-rendering.spec.ts`, `npm run test:extension-host`, `JUSTYBASE_EXTENSION_HOST_REPEAT=20 npm run test:extension-host`, `npm run benchmark:data-grid`, and `npm run test:playwright:data-grid-performance`. |
| Workspace/LSP | `npm run test:web`, `npm run test:playwright:web-api`, `npm run test:extension-host:authoring`, parser/completion/parity tests, and a Web smoke against a controlled API. |
| Schema/designers/companions | `designer-core` tests, API/Web tests, `npm run test:extension-host:designer`, `npm run build:companions`, and the relevant companion verification gates. |
| Final R9 | `npm run verify:pr`, `npm run test`, `npm run test:playwright`, `npm run test:playwright:web-api`, `npm run docs:check`, `npm run version:check`, `npm audit --omit=dev --audit-level=high`, main/companion builds, and packaging. |
| Additional environments | Live database suites only with required variables; Windows and Remote-WSL are separate evidence, never default skips. |

High-risk changed code keeps at least 80% line and 70% branch coverage. The
lint warning baseline and global thresholds are not increased or weakened.
The changed-code gate is active for `ui-core`, `ui-react`, `apps/web`,
`apps/electron`, and migrated `media` files. It merges their LCOV reports,
fails when a changed executable file has no record, and enforces the stated
80% line and 70% branch thresholds. A green root-only coverage report is not
sufficient evidence for these paths.
Async tests assert ordering, duplicates, delayed messages, cancellation,
reconnect, disposal, and the absence of active resources after completion.

R9 is complete only when all first-tier surfaces use `ui-core` state/ports and
`ui-react` presentation in Web, Electron, and VS Code; platform differences
are capability-backed, documented, and tested; legacy paths are removed only
for migrated slices; architecture has no new exceptions or cycles; public
contracts remain compatible; and the parity, browser, Extension Host,
Electron, build, packaging, security, type, lint, and project gates pass.

The implementation rule for the entire R9 is: work only in the working tree,
never run `git commit` or `git push`, and keep generated/test artifacts
temporary and ignored until the user makes a separate release decision.

### R10 — Dockyard web workspace and test-harness login

Status: implementation complete for the Web Dockyard path and its controlled
test harness on Linux (2026-09-11); cross-product parity and non-Linux browser
evidence remain follow-up work. R10 starts after the R9 foundation is in place.
It replaces the Web editor's default shell with the web-only Dockyard adapter
while keeping `ui-core` and `ui-react` platform-neutral. Dockyard is used as a
retained-DOM layout engine; it is not treated as a verified AvalonDock/XAML
port.

#### R10.1 — Vendored layout boundary

1. Vendor upstream Dockyard below `vendor/dockyard`, pinned to commit
   `921b9a66cac88b07af6edb3ebd5cd47af500c900` (`0.1.0`), with its license,
   upstream record, checksum manifest, and third-party notice. Verify the
   upstream `build`, `test`, API-surface, and checksum checks without changing
   the vendored source.
2. Keep all Dockyard imports in `apps/web/src/dockyard/`. The adapter owns DOM
   content hosts, Dockyard models, browser listeners, subscriptions, and
   serialization; `ui-core` owns portable state/persistence contracts and
   `ui-react` remains unaware of Dockyard, the DOM, and browser storage.
3. Use stable content identities `query:<tabId>`, `connections`, `schema`,
   `inspector`, `history`, and `explain:<tabId>`. Map activation, reorder,
   close/cancel, hide, float, auto-hide, and dock-back to the Web workspace
   controller. `dispose()` must release hosts, listeners, subscriptions, and
   Dockyard resources, including failed initialization paths.

#### R10.2 — Web workspace and persistence

1. Each query is one Dockyard `LayoutDocument` containing its toolbar, Monaco
   editor, result view, statement tabs, Explain state, and empty/error/cancel
   states. Connections, schema, inspector, history, and per-tab Explain are
   dockable tools. Floating and auto-hide stay in the page; no
   `window.open` pop-outs are introduced.
2. The old `sidebar` preference is used as the explorer width and `editor_pct`
   remains the inner query/editor-result split. Existing `tabs`, grid state,
   and legacy layout keys remain readable during migration; new layout writes
   use a user-scoped, schema-versioned `WorkspaceStorage` envelope.
3. Persist only Dockyard JSON, stable content IDs, layout configuration, and
   the pinned Dockyard version/commit. Reject foreign, future, malformed, or
   unsafe snapshots; never persist credentials, result buffers, DOM nodes, or
   runtime handles. A rejected snapshot resets to the safe default layout.
   The previous shell is retained as a temporary initialization-recovery path
   until the Dockyard rollout is fully closed.
4. The Dockyard path is the default Web shell without a long A/B rollout.
   `VITE_UI_MODE=shared` remains an explicit R9 shared-composition probe;
   failure to initialize Dockyard presents a recoverable reload/reset state
   rather than blocking authentication or data access.

#### R10.3 — Controlled test login

1. Add the exact `Use test login data` button only to a test-mode frontend
   (`MODE=test` and `VITE_ENABLE_TEST_LOGIN=1`). `api.testLogin()` sends a
   bodyless `POST` and does not place an administrator password in React
   state, the DOM, URL, localStorage, logs, or the frontend bundle.
2. Register `POST /api/auth/test-login` only when `NODE_ENV=test` and
   `JUSTYBASE_ENABLE_TEST_LOGIN=1`. It uses the configured
   `JUSTYBASE_ADMIN_USER`/`JUSTYBASE_ADMIN_PASSWORD`, shares normal session,
   CSRF-cookie, and session-creation logic, and is absent in all other modes.
   The regular username/password form and login route remain unchanged.
3. `test:playwright:web-api` builds with the test flag and starts the API with
   the server-side flag. Specs use the button instead of repeating
   credentials. Documentation must make clear that this path is for local/CI
   harnesses only and must never be enabled in production.

#### R10.4 — Verification and acceptance gates

| Area | Required evidence |
| --- | --- |
| Static boundary | `npm run check:architecture`, `npm run check-types:web`, `npm run lint:extended:check`, and the Dockyard API-surface/checksum verification. |
| Test login | Web client/component tests; API route tests for bodyless login, matching cookies/session, and absence outside controlled test mode. |
| Dockyard lifecycle | Layout migration/validation tests plus adapter disposal tests covering hosts, listeners, subscriptions, stale content, and failed initialization. |
| Web workspace | `npm run test:web`, `npm run build:web`, and the deterministic Playwright flow covering login, query documents, reorder, float, auto-hide, dock-back, reload, history, Explain, modals, cancellation, and narrow viewport. |
| Final R10 | `npm run verify:pr`, `npm run docs:check`, `npm run version:check`, `npm audit --omit=dev --audit-level=high`, and the applicable browser/API/package gates. |

R10 is complete only when the Web Dockyard layout survives reload and user
scope changes without leaking non-layout data, the controlled test login is
unavailable outside test mode, all first-tier workspace interactions retain
their existing API/LSP semantics, and the adapter has deterministic teardown.

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
table-rendering, the deterministic `npm run test:playwright:web-api` smoke,
and web components. Metadata requires disk restart and both
SchemaProviders. Dialects require verify, integration, companion activation,
and packaging. Verify VS Code on Linux and Windows; Remote-WSL requires a
separate environment.

Order: R0 → R1 → R2 → R3 → R4 → R5 → R6 → R7 → R8 → R9 → R10. For R0–R8 and
backend/shared-code extractions, every slice follows:
behavior test → extraction → desktop facade → VS Code gate → API/web → removal
of the replaced path. R9 UI slices are the qualified exception and use the
product order in R9.4 (`Web → Electron → VS Code`) after the portable
state/port contract is characterized; this does not change desktop-first
ownership of execution, runtime, or secrets. Code used only by the API has the
appropriate API gate. Comparison of old and new is test-only, never by
executing production SQL twice. A facade enables returning to the previous
delegation, while data remains readable. Do not mask differences by updating
expectations, thresholds, or fixed sleeps.

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
