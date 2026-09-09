# Shared-code migration: Netezza validation boundary

The preparation stage established the boundaries and the migration now has a
platform-neutral `@justybase/sql-core` entrypoint. The Netezza lexer, grammar,
parser runtime, semantic validator, authoring helpers and quality rules are
owned by sql-core. Desktop and API adapters retain their public facades,
metadata/transport composition and stateful cache lifecycles while delegating
Netezza analysis to the same native backend.
Target ownership is defined in [Architecture](ARCHITECTURE.md); test selection
and lifecycle requirements remain governed by [Testing strategy](TESTING_STRATEGY.md).

## Reproducing the baseline

The repository-wide checker and its edge/cycle baseline existed before this
preparation. Keep changes to `scripts/architecture-check.mjs` and
`quality/architecture-rules.json` reviewable independently of later code moves.
Do not regenerate exceptions to make a migration pass.

Run `npm run check:architecture`, `npm run test:quality-tools`, and
`npm run architecture:report --silent`. The JSON report contains all production
files, exact resolved edges with import forms/locations, layer-to-layer counts,
strongly connected components with edge fingerprints, and the configured debt
entries with owners and removal conditions. Redirect it to a temporary artifact
when comparing revisions; do not commit volatile graph/timing reports.

| Current consumer | Current dependencies and debt |
| --- | --- |
| `src` | contracts/shared packages, desktop modules, exact companion registry bridges |
| `media` | shared packages, desktop protocol/types, media modules, exact companion designer bridges |
| `packages/contracts` | its own public types/helpers; existing type cycle is fingerprinted |
| `packages/sql-core` | Platform-neutral Netezza lexer/parser, semantic validation, authoring and quality rules |
| Other `packages` | contracts and shared helpers; designer-core is pure, database-runtime owns shared execution plus compatibility exports, and sqlite/duckdb/netezza-runtime/access-file own Node I/O |
| `apps/api` | contracts, sql-core, database-runtime, sqlite-runtime, duckdb-runtime, netezza-runtime and API modules |
| `apps/web` | contracts, shared pure logic and web modules; desktop imports forbidden |
| `extensions` | own modules, contracts/shared helpers, public core activation API, exact legacy desktop implementation bridges |

## Runtime extraction in R2 (closed 2026-09-08)

The three database-specific Node runtimes now have explicit ownership:

- `@justybase/sqlite-runtime` owns the Node `node:sqlite` session and is used by
  both the API adapter and the desktop SQLite connection facade.
- `@justybase/duckdb-runtime` owns the structural DuckDB module resolver,
  instance ownership, catalog serialization, bounded result streaming and
  cancellation. The API supplies its sandbox resolver; the DuckDB companion
  supplies the optional native module and retains File SQL view setup.
- `@justybase/netezza-runtime` owns the only production import of
  `@justybase/netezza-driver`, stateful API lifecycle and metadata helpers. The
  desktop dialect and MCP use its factory, while `@justybase/database-runtime`
  re-exports compatibility helpers without importing the driver.

All three packages accept resolved product configuration rather than API store
objects, credentials are decrypted only in the API adapter, and shutdown drains
active operations in the API managers. Netezza uses a fresh connection per
execution (including a per-query database override); the manager retains a
target fingerprint rather than credentials. The future Electron main process can instantiate the same
runtime packages without importing VS Code or React.

Closure evidence for R2 (lifecycle/cancellation in desktop DuckDB and File
SQL, direct `SqliteSession` ownership/close tests plus real Extension Host
SQLite runs, and a clean-checkout build/package verification) is recorded in
`REFACTORING_PLAN.md` under "R2 closure evidence".

## Execution orchestration in R5 (closed 2026-09-09)

`@justybase/database-runtime/execution` is the canonical lifecycle owner for
desktop single/batch/stream execution and API query jobs. It consumes additive
contracts from `@justybase/contracts` and exposes an injected backend port; it
does not know about VS Code, editors, web sockets, credentials, history or UI
messages. Product adapters map lifecycle events to their existing protocols.

The shared owner guarantees monotonic event sequence, at most one reconnect,
one terminal summary, callback retirement, cancellation checks around
reconnect, and idempotent reverse-order cleanup. Replay safety is stricter than
read-only authorization and requires no rows to have crossed the delivery
boundary. Failed streams retain partial row/limit metadata without replaying
already delivered data. Desktop activation and API server construction own
their mutable registries and timers; compatibility singletons are forwarding
facades only.

## Netezza validation boundary

`@justybase/sql-core/validation` defines the canonical diagnostic, position,
scope, statement-boundary and validation-result shapes. Desktop validation
profiles are aliases of the contracts package model. The desktop adapter in
`src/sqlParser/sqlCoreAdapter.ts` and the API adapter in
`apps/api/src/sqlCoreLsp.ts` cross this boundary explicitly. They preserve the
existing validation result shape, incremental-cache ownership, SQL025/SQL026
metadata flow, LSP severity conversion and suggested-fix mapping.

The current Netezza semantic backend is the package-owned
`NetezzaSqlSemanticValidator`. Full, parse-result, and incremental validation
all call it directly. `SqlCoreBackedValidator` implements the shared
`SqlValidationService` without inheriting from or constructing the legacy
`SqlValidator`; the latter remains the fallback for non-Netezza dialects and
the parity oracle for the migration corpus. Desktop compatibility facades
retain their result shape and incremental cache owner.

Required checks for this slice are:

- `npm run test:sql-core` for the package boundary;
- `sqlCoreValidationParity.test.ts` for diagnostic, scope and direct
  `validateIncremental` boundary parity;
- parser, linter, API and Extension Host authoring suites;
- `npm run check:architecture` with no new exceptions or cycles.

The complete exception inventory is `quality/architecture-rules.json`, not a
second manually maintained list. The Result Panel orchestration cycle was
removed in R3. The remaining categories are desktop-to-companion registries.
Companion production code no longer has an edge into `src`, and migrated
webviews no longer import companion DDL. Each remaining exact edge has a
reason, accountable maintainer role and removal condition. There is no
sql-core-to-desktop or SQL LSP facade exception. Removing an edge requires
removing its stale exception in the same slice.

The existing cycle inventory, identified by its configured anchor, is:

| Anchor | Area |
| --- | --- |
| `media/visualQueryBuilder/VisualQueryBuilderApp.tsx` | visual builder |
| `packages/access-file/src/accessFileSession.ts` | Access file runtime |
| `src/commands/schema/types.ts` | desktop core migration target |
| `src/commands/validationCommands.ts` | validation commands |
| `src/core/resultDataProvider/types.ts` | result storage contracts |
| `src/export/exportManager.ts` | export |
| `src/services/copilotService.ts` | Copilot services |

Exact members and internal-edge fingerprints live in `cycleExceptions` and the
report. New cycles or changed components fail. Breaking a component is planned
work: inspect the reduced graph, remove the old entry and record only remaining
debt with a removal condition. Do not accept enlarged components automatically.
The report includes type-only imports; these cycles are not all runtime cycles.
It excludes tests, declarations, generated output and non-TypeScript assets,
and cannot prove absence of dependencies hidden behind nonliteral loaders.

## Companion public entry points and compatibility

Core activation returns `JustyBaseLiteApi` v1 from `src/api/publicApi.ts`.
The VS Code-specific `activateCoreExtension()` adapter and
`CORE_EXTENSION_ID` now live in `packages/vscode-companion-adapter`; it
activates the core and validates version/registration methods. Companions
consume this adapter and portable types from `@justybase/contracts`; they do
not import a desktop `src` implementation. The enforced companion boundary is
`npm run check:companion-boundaries`, included in `npm run check:architecture`.

| Public API members | Responsibility |
| --- | --- |
| `version`, `registerDatabaseDialect`, `listRegisteredDatabaseDialects` | v1 handshake and dialect registration |
| `createConnectedDatabaseConnectionFromDetails` (optional) | connected/tunnel-aware runtime creation |
| `openFileSqlSession`, `openFileSqlWorkspaceSession` | File SQL editor/profile integration |
| `listSavedConnections`, `getActiveConnectionDetails`, `getConnectionSummary` (optional) | connection discovery and editor binding |
| `executeActiveConnectionSql`, `executeActiveConnectionSqlQuery` (optional) | active editor execution |
| `executeConnectionSql`, `executeConnectionSqlQuery` (optional) | named-profile execution |

The public `@justybase/contracts` barrel exports database connections,
capabilities, dialect traits, authoring and advanced-feature types. A desktop
implementation imported directly by an addon is technical debt even if exported
by its source module. The architecture report's exact desktop-to-companion
edges provide the full list of remaining registry consumers.

Keep v1 signatures, optionality, activation behavior and
`registerDatabaseDialect` semantics unchanged. Contracts evolve additively:
existing payloads must remain accepted and existing fields retain meaning.
Adding a required field or union variant that breaks exhaustive consumers needs
a separate compatibility design, not an automatic declaration of “additive”.
Keep facades until every consumer of that slice has migrated. Never serialize
driver objects, VS Code handles or credentials into a new shared result type.

The v1 `getActiveConnectionDetails` method retains its historical
credential-bearing `ConnectionDetails` result for compatibility with already
published companions. New shared DTOs must continue to omit credentials; a
credential-free replacement requires a coordinated major-version rollout for
the core extension and all companions.

### Tabular import ownership

`@justybase/tabular-import-runtime` currently owns the platform-neutral
analysis, descriptor, sampling, and row-reading behavior used by the Snowflake
planner. The desktop importer remains the compatibility/product implementation
for Netezza and the other companion import paths, while the API keeps its
request/upload and database-execution-specific import path. These consumers
are intentionally staged rather than presented as a completed whole-repository
migration. A future consolidation must first compare CSV/XLSX/XLSB quoting,
header, type-inference, limits, and error behavior, then migrate consumers and
remove the old paths with the corresponding product gates.

Result webview messages and API `QueryEvent` are distinct existing protocols.
No field rename, required stable-ID retrofit or shared transport switch occurs
here. Preserve legacy timestamp identity fallback, row offsets, chunk sequence
and authoritative hydrate semantics. Cache/disk schema changes require explicit
versioning, migration/reset and restart evidence under
[Metadata cache contract](METADATA_CACHE_CONTRACT.md).

## Contract duplication audit

These entries describe canonical ownership or compatibility obligations; they
are not interchangeable aliases. The result-model and metadata-rule slices now
have concrete `@justybase/result-core` and `@justybase/metadata-core`
implementations; the other future packages remain migration targets.

| Concept | Existing definitions | Future canonical definition / compatibility obligation |
| --- | --- | --- |
| Query result and columns | `src/types/index.ts`: `QueryResult`, `ResultSet`, `ColumnDefinition`; `apps/web/src/queryState.ts`: `ResultState`; contracts `QueryColumn`, `QueryPageResponse`; public API `ConnectionQueryResult` | Portable result DTO remains in contracts; state, identity, event reduction and pure operations are now owned by `@justybase/result-core`. Preserve desktop `data` versus API `rows`, column `type`/`scale`, flags, affected rows and storage counts through explicit adapters. |
| Streaming chunks | `src/core/streaming/StreamingManager.ts`: `StreamingChunk`; `src/contracts/webviews/resultPanelContracts.ts`: append/hydrate messages; contracts `QueryRowsEvent` and `ExecutionRowsEvent` | `ExecutionRowsEvent` is canonical only inside the shared execution lifecycle. Callback chunks and product wire events remain explicit adapter boundaries; first/last, partial/cancelled, total counts and ordering mappings are tested. |
| Query events | `packages/contracts/src/webApi.ts`: `QueryEvent`; `packages/contracts/src/queryExecution.ts`: `ExecutionEvent`; desktop execution lifecycle and webview command unions | `ExecutionEvent` is canonical for internal orchestration and guarantees one terminal summary. `QueryEvent` remains the existing HTTP/WebSocket protocol; result-core receives an explicit adapter mapping. |
| Source/result identity | `src/state/resultSetIdentity.ts`, `ResultSet.resultSetId`; media `ResultSetScope`/`GridScrollState`; API `queryId`, `statementIndex`, `sessionId` | `@justybase/result-core` owns source, execution, result-set and storage-session identity rules. IDs are not tab indices, timestamps, storage-session IDs or interchangeable URI strings; adapters retain URI normalization and legacy fallback. |
| SQL diagnostics | `@justybase/sql-core/validation`: `ValidationError`, `ValidationResult`, `Scope`, `StatementBoundary`; contracts `SqlDiagnostic`; desktop quality/LSP mappings | Shared structural validation types are canonical in sql-core; adapters retain only runtime, qualification and transport-specific mappings. Preserve offset and line conventions, rule-code mapping, ranges and suggested fixes. |
| Metadata columns | parser `ColumnInfo`; contracts `MetadataColumn`; desktop `MetadataColumnItem`; `ColumnDefinition` | Portable metadata column DTO in contracts and metadata rules in `@justybase/metadata-core`. Preserve `dataType`, keys, qualification, aliases; map `FORMAT_TYPE` and LSP `type` explicitly. SQL025/026 must work through both schema providers. |
| Capabilities and authoring | `packages/contracts/src/database/index.ts`; `src/contracts/database/index.ts`; `src/sql/authoring/types.ts` | contracts owns portable capabilities and validation profiles; desktop authoring keeps only its quality-rule specialization while dialect packages own SQL implementation. |
| Query/metadata/result services | shared `ExecutionOrchestrator`; desktop activation-owned `StreamingManager`, `MetadataCache`, `ResultStateManager`; API server-owned execution jobs; web `api.ts` and `queryState.ts` | The orchestrator owns execution state/retry/cleanup through injected ports. Product adapters retain secrets, database acquisition, I/O, state lifetime and transport. |

## Proposed product service ports

This typed design sketch is not a new exported API. Request/response types
below refer to the existing names in `@justybase/contracts`; `ResultRef` and
`ExportArtifact` illustrate adapter-local identities/handles pending the result
slice. Implement only the port needed by a real migration. Clients receive
individual services, not a singleton product service locator.

```ts
type Dispose = () => void;
type ResultRef = { queryId: string; statementIndex: number };
type ExportArtifact = { downloadUrl: string; expiresAt?: number };

interface SqlAuthoringService {
  completion(request: SqlCompletionRequest): Promise<SqlCompletionResponse>;
  diagnostics(request: SqlDiagnosticsRequest): Promise<SqlDiagnosticsResponse>;
  format(request: SqlFormatRequest): Promise<SqlFormatResponse>;
}
interface MetadataService {
  columns(connectionId: string, database: string, schema: string,
    table: string): Promise<MetadataColumn[]>;
  invalidate(connectionId: string): Promise<void>;
}
interface QueryExecutionService {
  preview(request: QueryStartRequest): Promise<QueryPreviewResponse>;
  start(request: QueryStartRequest): Promise<QueryStartResponse>;
  cancel(queryId: string, scope: 'statement' | 'batch'): Promise<void>;
  subscribe(queryId: string, onEvent: (event: QueryEvent) => void,
    onError: (error: Error) => void, afterSequence?: number): Dispose;
}
interface ResultStorageService {
  page(result: ResultRef, request: QueryPageRequest): Promise<QueryPageResponse>;
  release(result: ResultRef): Promise<void>;
}
interface ExportService {
  export(result: ResultRef, request: QueryExportRequest): Promise<ExportArtifact>;
}
interface ConnectionService {
  list(): Promise<ConnectionProfileSummary[]>;
  save(profile: ConnectionProfileInput): Promise<ConnectionProfileSummary>;
  remove(connectionId: string): Promise<void>;
}
```

The pure result reducer is a separate `state + event -> state` engine, not a
storage service or transport client. Query cancellation is an explicit backend
operation; disposing a subscription only removes listeners. Adapters translate
errors, enforce authorization, own pending operations and release sessions on
product shutdown. Metadata caches are scoped by connection/database/schema and
user where applicable; no cross-user singleton may hold credentials or results.

Web uses HTTP plus the existing event transport. Future Electron reuses that
HTTP client against its managed backend; Electron lifecycle APIs do not enter
these interfaces. VS Code uses an in-process compatibility adapter with editor
and secret-storage integration. A future download handle must be scoped to the
authenticated owner; it is not a raw server filesystem path.

## Migration order and comparison gates

1. Replace the legacy backend behind the validation boundary with the Netezza
   parser/linter implementation in sql-core. The completed vertical slice is
   parser-backed validation and authoring for a document plus injected schema
   metadata: input SQL/profile/schema -> parse -> diagnostics/quality/authoring
   -> desktop or API compatibility facade. Keep the smallest coherent
   dependency closure, public exports and diagnostics mappings intact.
2. Use SQLite and DuckDB as the first dialect packs, splitting pure authoring
   from runtime/driver registration without changing companion registration.
3. Extracted the shared result identity/reducer and pure operations to
   `@justybase/result-core`, with desktop and web adapters.
4. Keep API/web event and storage boundaries explicit; the web query adapter
   now consumes the shared portable reducer without changing the wire protocol.
5. Extracted metadata keys, identifier policies, TTL, completeness,
   merge/invalidation, indexes, and prefetch decisions to
   `@justybase/metadata-core`; desktop disk/catalog adapters and the API
   per-server metadata service retain their product-specific ownership.
6. Migrate companions one at a time with their own activation/runtime evidence.
7. Only then prepare the Electron composition root.

Every slice switches desktop through its compatibility adapter first and runs
VS Code gates before API/web are switched. For the first SQL slice, keep a
baseline fixture corpus with expected diagnostic codes, severities, messages,
ranges and fixes; compare old and extracted implementations against that same
corpus before deleting the old implementation. Include Netezza `DB..TABLE`,
qualified/relaxed names, procedures and string bodies, malformed SQL, typed and
untyped metadata, and both metadata schema-provider paths. Never normalize away
codes, offsets, column types or stable identity to make parity pass.

Use `validator.test.ts`, `identifierRoleCollector.test.ts`,
`completionEngine.test.ts`, `metadataCacheAdapter.test.ts` and
`lspSchemaProvider.test.ts` as existing authoring anchors. Run parser construction
guards and `benchmark:lsp` for SQL changes; preserve hard dialect budgets and
the performance policy in the testing strategy.

For results, freeze pure state transitions first using
`resultStateManager.test.ts`, `resultPanelStateContract.test.ts`,
`resultPanelProtocol.test.ts`, web `queryState.test.ts` and API
`querySessions.test.ts`. Compare ordered events, stable identities, total/partial
rows, retries/cancellation and cleanup before DOM work. Then exercise the full
persisted/async UI matrix in the testing strategy, followed by bundled browser,
Extension Host and React boundaries. No new reducer tests can prove migration
parity before a reducer is actually extracted.

## Repeatable verification and completion

Use Node >=22.12 and root `npm ci` with the lockfile; install companion
dependencies through `npm run install:<dialect>` where provided. All commands
below run from the root; do not commit generated bundles, profiles or reports.

| Scope | Gates |
| --- | --- |
| Preparation tooling/docs | `check:architecture`, `test:quality-tools`, `docs:check`, `version:check` |
| Desktop/shared/API/web baseline | `npm run verify:pr` (architecture, type checks, lint, unit/coverage, API/web tests, builds) |
| Companions | `npm run verify:access`, `verify:db2`, `verify:duckdb`, `verify:oracle`, `verify:postgresql`, `verify:snowflake`, `verify:mssql`, `verify:mysql`, `verify:clickhouse`, `verify:vertica` (lint/types/build, not live tests) |
| Companion registration | `npm run test:extension-host:companions` |
| SQL extraction | `npm run test:parser`, `test:completion-parity`, `test:extension-host:authoring`, `benchmark:lsp`; dialect construction tests |
| Result extraction | `npm run test:extension-host`, `npm run test:playwright -- test-harness/tests/table-rendering.spec.ts`, API/web tests |
| Metadata extraction | `npm run test:metadata-cache:integration`, schema-provider and authoring tests |
| Dialect runtime extraction | matching `test:<dialect>:integration`, companion verify and packaging gates |

Use `xvfb-run -a` for Extension Host gates on headless Linux. Live suites require
their documented environment and fixtures; missing configuration is not a pass.
The PR workflow already runs architecture checking in its Quality Checks job;
repository branch protection must require that job (a repository setting, not
something this source change can assert). Tooling changes remain separate from
production migrations in review.

Preparation acceptance requires target ownership, exact debt/graph inventory,
compatibility policy, first vertical slice and comparison criteria documented;
the checker and negative tests passing in PR; and the existing desktop, API,
web and companion gates passing without behavior changes. Record commands and
environment limitations in the implementation handoff. Documentation or a
passing import graph alone is not evidence of runtime parity. Do not begin a
production move while its prerequisite gates remain unresolved.
