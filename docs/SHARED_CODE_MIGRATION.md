# Shared-code migration preparation and first compatibility slice

The preparation stage established the boundaries and the first compatibility
slice now adds a real `@justybase/sql-core/validation` entrypoint. Runtime
implementations, result messages, cache serialization and companion APIs remain
active at their existing paths. The validation entrypoint deliberately keeps
the legacy parser behind an injected backend until the pure parser dependency
closure is moved.
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
| `packages/sql-core` | LSP protocol libraries and exact `src` SQL/LSP/registry bridges; not yet a standalone pure engine |
| Other `packages` | contracts and shared helpers; designer-core is pure, database-runtime/access-file own Node I/O |
| `apps/api` | contracts, sql-core, database-runtime and API modules |
| `apps/web` | contracts, shared pure logic and web modules; desktop imports forbidden |
| `extensions` | own modules, contracts/shared helpers, public core activation API, exact legacy desktop implementation bridges |

## First SQL validation slice

`@justybase/sql-core/validation` defines the platform-neutral diagnostic,
position, schema-provider and validation-result shapes. The desktop LSP handler,
desktop linter and web/API LSP core cross this boundary through compatibility
adapters. The adapter preserves the existing `ValidationError` shape, parser
session ownership, incremental validation cache, SQL025/SQL026 metadata flow,
LSP severity conversion and suggested-fix mapping.

The current backend is intentionally the legacy `SqlValidator`. This is a
reversible strangler step: parity tests compare the direct legacy result with
the boundary result before the parser implementation is relocated. The next
slice may replace only the injected backend with the pure Netezza parser; it
must not change consumers or wire contracts.

Required checks for this slice are:

- `npm run test:sql-core` for the package boundary;
- `sqlCoreValidationParity.test.ts` for diagnostic and scope parity;
- parser, linter, API and Extension Host authoring suites;
- `npm run check:architecture` with no new exceptions or cycles.

The complete exception inventory is `quality/architecture-rules.json`, not a
second manually maintained list. Categories are companion-to-desktop services,
desktop-to-companion registries, media-to-companion DDL and sql-core-to-desktop
authoring. Each exact edge has a reason, accountable maintainer role and removal
condition. The SQL facade also has one exact Node LSP entry-point exception.
Removing an edge requires removing its stale exception in the same slice.

The existing cycle inventory, identified by its configured anchor, is:

| Anchor | Area |
| --- | --- |
| `apps/api/src/netezza.ts` | API execution |
| `extensions/snowflake/src/snowflakeImportPlanner.ts` | desktop/companion integration |
| `media/resultPanel/diskBackedGrid.ts` | Result Panel orchestration |
| `media/resultPanel/hostContracts.ts` | Result Panel types/protocol |
| `media/visualQueryBuilder/VisualQueryBuilderApp.tsx` | visual builder |
| `packages/access-file/src/accessFileSession.ts` | Access file runtime |
| `packages/contracts/src/connectionDetails.ts` | shared contract types |
| `src/commands/validationCommands.ts` | validation commands |
| `src/contracts/database/index.ts` | desktop dialect contracts |
| `src/core/resultDataProvider/types.ts` | result storage contracts |
| `src/dialects/netezza/sql/authoring.ts` | Netezza authoring |
| `src/export/exportManager.ts` | export |
| `src/services/copilotService.ts` | Copilot services |
| `src/sqlParser/BaseSqlParser.ts` | parser |

Exact members and internal-edge fingerprints live in `cycleExceptions` and the
report. New cycles or changed components fail. Breaking a component is planned
work: inspect the reduced graph, remove the old entry and record only remaining
debt with a removal condition. Do not accept enlarged components automatically.
The report includes type-only imports; these cycles are not all runtime cycles.
It excludes tests, declarations, generated output and non-TypeScript assets,
and cannot prove absence of dependencies hidden behind nonliteral loaders.

## Companion public entry points and compatibility

Core activation returns `JustyBaseLiteApi` v1 from `src/api/publicApi.ts`.
`src/api/companionActivation.ts` exposes `activateCoreExtension()` and
`CORE_EXTENSION_ID`; it activates the core and validates version/registration
methods. Existing imports of this helper are recorded bridges, not permission
to add arbitrary `src` imports. New companions should resolve the public core
exports through VS Code activation and consume portable types from contracts.

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
by its source module. The architecture report's companion-to-desktop edges
provide the full list of such entry points and their consumers.

Keep v1 signatures, optionality, activation behavior and
`registerDatabaseDialect` semantics unchanged. Contracts evolve additively:
existing payloads must remain accepted and existing fields retain meaning.
Adding a required field or union variant that breaks exhaustive consumers needs
a separate compatibility design, not an automatic declaration of “additive”.
Keep facades until every consumer of that slice has migrated. Never serialize
driver objects, VS Code handles or credentials into a new shared result type.

Result webview messages and API `QueryEvent` are distinct existing protocols.
No field rename, required stable-ID retrofit or shared transport switch occurs
here. Preserve legacy timestamp identity fallback, row offsets, chunk sequence
and authoritative hydrate semantics. Cache/disk schema changes require explicit
versioning, migration/reset and restart evidence under
[Metadata cache contract](METADATA_CACHE_CONTRACT.md).

## Contract duplication audit

These are candidates for later canonical ownership, not interchangeable aliases.
No new exported DTO is needed for this preparation; adding speculative copies
would enlarge the duplication before mappings have been proven.

| Concept | Existing definitions | Future canonical definition / compatibility obligation |
| --- | --- | --- |
| Query result and columns | `src/types/index.ts`: `QueryResult`, `ResultSet`, `ColumnDefinition`; `apps/web/src/queryState.ts`: `ResultState`; contracts `QueryColumn`, `QueryPageResponse`; public API `ConnectionQueryResult` | Portable result DTO in contracts, state/operations in result-core. Preserve desktop `data` versus API `rows`, column `type`/`scale`, flags, affected rows and storage counts through explicit adapters. |
| Streaming chunks | `src/core/streaming/StreamingManager.ts`: `StreamingChunk`; `src/contracts/webviews/resultPanelContracts.ts`: append/hydrate messages; contracts `QueryRowsEvent` | Canonical internal chunk contract after first/last, partial/cancelled, total counts and ordering mappings are tested; do not equate callback chunks with wire events. |
| Query events | `packages/contracts/src/webApi.ts`: `QueryEvent`; desktop execution lifecycle and webview command unions | `QueryEvent` remains canonical for HTTP/WebSocket. A result-core event model needs explicit translation and one terminal event per logical execution. |
| Source/result identity | `src/state/resultSetIdentity.ts`, `ResultSet.resultSetId`; media `ResultSetScope`/`GridScrollState`; API `queryId`, `statementIndex`, `sessionId` | Future contracts source/result ID types and result-core identity rules. IDs are not tab indices, timestamps, storage-session IDs or interchangeable URI strings; adapters retain URI normalization and legacy fallback. |
| SQL diagnostics | `src/sqlParser/types/index.ts`: `ValidationError`; sql-core `CoreDiagnostic`; contracts `SqlDiagnostic`; desktop quality/LSP mappings | Public range/severity/code DTO in contracts, parser diagnostics in sql-core. Preserve offset and line conventions, rule-code mapping, ranges and suggested fixes. |
| Metadata columns | parser `ColumnInfo`; contracts `MetadataColumn`; desktop `MetadataColumnItem`; `ColumnDefinition` | Portable metadata column DTO in contracts and model in metadata-core. Preserve `dataType`, keys, qualification, aliases; map `FORMAT_TYPE` and LSP `type` explicitly. SQL025/026 must work through both schema providers. |
| Capabilities and authoring | `packages/contracts/src/database/index.ts`; `src/contracts/database/index.ts`; `src/sql/authoring/types.ts` | contracts owns portable capabilities/profiles; dialect package owns SQL implementation. Desktop parsing hooks and shared profiles differ: verify structural compatibility before replacing facades. |
| Query/metadata/result services | desktop `StreamingManager`, `MetadataCache`, `ResultStateManager`; API `QuerySessionManager`; web `api.ts` and `queryState.ts` | Small injected service ports below; product adapters retain secrets, I/O, state lifetime and transport. |

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
   parser/linter implementation in sql-core. The first vertical slice is
   parser-backed validation for a document plus injected schema metadata:
   input SQL/profile/schema -> parse -> diagnostics -> desktop compatibility
   facade. Move the smallest coherent dependency closure; retain public exports
   and diagnostics mappings. Completion remains on its facade until its slice.
2. Use SQLite and DuckDB as the first dialect packs, splitting pure authoring
   from runtime/driver registration without changing companion registration.
3. Extract the shared result identity/reducer and pure operations to result-core.
4. Connect API/web to that model through explicit event/storage adapters.
5. Extract metadata model and merge/invalidation semantics.
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
