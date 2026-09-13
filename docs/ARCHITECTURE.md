# Architecture overview

JustyBase is a layered monorepo with VS Code, Web/API, and Electron
development/test products plus shared contract and presentation surfaces.

Cross-cutting architecture debt, enforcement work, and measurable exit criteria
are tracked in the
[Project Quality Improvement Roadmap](PROJECT_QUALITY_ROADMAP.md). This document
describes the intended structure; the automated architecture check determines
which parts are currently enforced.

The [refactoring plan](REFACTORING_PLAN.md) orders further extraction for
production VS Code, the existing web/API, and the Electron development/test
adapter. It does not replace the quality backlog.

The current dependency map, contract audit, service proposal and ordered
migration gates are in [Shared-code migration preparation](SHARED_CODE_MIGRATION.md).
The SQL boundary is now implemented as a platform-neutral Netezza core:
`@justybase/sql-core` owns the lexer, parser, semantic validator, incremental
validation primitives, authoring helpers, quality rules and validation model.
Desktop and API adapters compose metadata, transport, editor lifecycle and
incremental-cache state around that core while preserving their existing public
shapes. Public results and wire contracts remain unchanged. The R9 working
tree now contains non-empty `ui-core`, `ui-react`, and Electron
development/test packages; the Electron shell is not a production installer
or release target.

Desktop SQL compatibility facades consume named `sql-core` subpaths for the
parser base/rules, Netezza parser/lexer/identifier patterns and source scanning.
The package builds a single implementation bundle with public wrappers so
CommonJS and native ESM consumers share token, lexer and class identity.
`test:sql-core` exercises built entrypoints as well as source tests; raw package
source paths are not public exports.

Contract leaf types (`DatabaseKind` and Result Panel selection statistics) no
longer import their public barrels. Their original exports remain compatible
while the two former type cycles have been removed.

## Target ownership

Arrows below mean “imports”; product composition roots select and inject
implementations. A pure engine never imports an adapter or driver.

```text
VS Code adapter / API backend / Electron main backend
    -> Node database-runtime / dialect-<kind>-runtime -> driver or Node database API
    -> pure SQL / metadata / result engines -> contracts
Desktop webview / Web / Electron React renderer -> `ui-react` -> pure engines and contracts
Web / Electron SQL editor -> `ui-monaco` -> `sql-core` authoring API
React renderer -> `@justybase/api-client` -> API backend
```

| Logic | Target owner |
| --- | --- |
| Parser, linter, completion and SQL scope | `@justybase/sql-core` |
| Metadata model and pure merge/invalidation rules | `@justybase/metadata-core` |
| Result reducer, identity and pure data operations | `@justybase/result-core` |
| Execution, cancellation, retry and runtime resource cleanup | `@justybase/database-runtime` |
| Database-specific driver and Node I/O | `@justybase/sqlite-runtime`, `@justybase/duckdb-runtime`, `@justybase/netezza-runtime` |
| Database-specific SQL grammar and authoring | future `@justybase/dialect-<kind>` |
| Stable public and transport types | `@justybase/contracts` |
| Cross-product HTTP/CSRF/WebSocket workspace transport | `@justybase/api-client` |
| Secrets, filesystem, transport, editor integration and lifecycle | product adapter |
| Shared React presentation and tokens | `@justybase/ui-react`; effects enter through product ports |
| Monaco editor/LSP registration and marker mapping | `@justybase/ui-monaco`; transport and lifecycle remain adapter-owned |
| Product-specific DOM/webview/window integration | VS Code, Web, or Electron adapter |

These are ownership decisions, not a claim that every future engine already
exists. `designer-core`, `result-core`, and `metadata-core` already own pure
designer, result, and metadata rules; `access-file` is a Node file runtime.
`sql-core` is platform-neutral and does not bundle desktop sources. The API LSP adapter owns metadata bridging and transport composition;
the desktop adapter owns VS Code integration and stateful cache orchestration.
Pure engines receive schema providers, dialect profiles and other services as
arguments. Existing registries remain at their current compatibility seams;
new process-global registries combining products and dialects are prohibited.
Composition-root review enforces that lifetime/ownership rule; an import graph
alone cannot detect every global singleton.

`@justybase/sqlite-runtime` owns instance-scoped SQLite sessions, streamed query
execution, cancellation, metadata access and deterministic shutdown. It accepts
only an absolute path already authorized by its product adapter (or `:memory:`)
and has no knowledge of API users, storage roots or VS Code. The API adapter
keeps the per-user filesystem sandbox, rewrites literal `ATTACH` targets through
that sandbox and injects its SQLite read-only policy. Runtime instances are
owned by the API runtime registry; closing a profile or server cancels active
work before closing files.

`@justybase/duckdb-runtime` owns the platform-neutral DuckDB instance/session
protocol. Its module resolver is injected by the product so the optional native
package can live in the API deployment or the DuckDB companion extension. The
runtime distinguishes cached file instances from owned in-memory instances,
serializes catalog selection with execution, bounds materialization, and drains
active operations before shutdown. API sandbox and ATTACH authorization remain
in the API adapter; File SQL view/conversion setup remains in the companion.

`@justybase/netezza-runtime` is the sole production owner of the Netezza driver
import. It exposes an instance-scoped connection/command/reader lifecycle and
metadata helpers while accepting resolved credentials from a product adapter.
The API adapter decrypts secrets and supplies stable profile identities; the
desktop dialect and MCP composition roots use the exported factory. The
compatibility exports in `@justybase/database-runtime` re-export this surface
without importing the driver themselves.

The Electron main process hosts/manages the embedded backend; its React
renderer uses the same `@justybase/api-client` transport as Web after
main-owned authentication. Backend startup, authentication, port selection and
shutdown belong to the Electron composition root. Electron only supplies its
transport policy (`same-origin` credentials and renderer-specific error
wording); it does not fork HTTP, CSRF, download, event validation, or reconnect
logic. The shared package has no React, Node, VS Code, or Electron dependency,
and all product-specific composition remains in the Web provider or Electron
adapter.

## Shared API transport boundary

`@justybase/api-client` is the single client-side owner for the authenticated
workspace API surface. It contains the typed REST methods, JSON/error handling,
CSRF bootstrap and cookie handling, export downloads, WebSocket URL derivation,
query-event validation, sequence de-duplication, and bounded reconnect policy.
Its dependency direction is `api-client -> contracts`; browser globals and
injected `fetch`/`WebSocket` are ports rather than framework dependencies.

`apps/web/src/api.ts` intentionally contains only the React context/provider
and the compatibility factory export. `apps/electron/src/renderer/api.ts`
contains only Electron's transport configuration and compatibility types. This
keeps the two composition roots free to differ in credentials and wording while
making route additions and protocol fixes one shared change. The package has
isolated transport tests, while the Web and Electron suites continue to test
their adapter-specific contracts.

## Runtime boundaries

- `src/extension.ts` is the desktop composition root. Deferred registrations
  are loaded after activation and are skipped in tests.
- `src/core/connectionFactory.ts` and `DatabaseDialect` isolate database
  implementations. Shared providers must not assume Netezza behavior.
- `src/sqlParser`, the dialect lexer/parser, and LSP providers form the desktop
  authoring pipeline. `packages/sql-core` owns the Netezza parser, native
  validation, authoring and quality subset and exposes platform-neutral types;
  it must never import VS Code, LSP Node libraries, Node built-ins or drivers.
- `apps/api/src/sqlCoreLsp.ts` composes the same core with API metadata and LSP
  transport DTOs. Metadata bridges and WebSocket/HTTP protocol state stay in
  the API product layer.
- `apps/api` owns authentication, per-user storage, query jobs, WebSockets, and
  disk-spooled sessions. Its per-server database runtime registry selects
  Netezza, SQLite or DuckDB adapters and owns their resource cleanup; secrets
  remain inside the Netezza adapter rather than generic query options.
  `apps/web` consumes contracts through REST/LSP and renders Monaco/TanStack
  views.

`@justybase/metadata-core` owns platform-neutral metadata keys, identifier
policies, TTL classification, snapshot completeness, object-type merging,
lookup-index construction, prefetch decisions, and generation rules. Desktop
keeps VS Code cache layers, catalog queries, progress, disk formats, and
hydration in its adapter. The API creates one `ApiMetadataService` per server
instance; its keys include the authenticated owner and connection identity, and
generation checks prevent an invalidated request from repopulating the cache.
Netezza user identifiers fold according to Netezza rules, while catalog values
remain exact. Other dialects use case-preserving keys unless their adapter
provides a different policy.

## Shared designer boundary

`packages/designer-core` is the browser-safe, platform-neutral home for
capability guards, reviewed SQL builders, and catalog-row normalization used by
the web editor, API snapshot adapters, desktop webviews, and companion
extensions. It may depend on `packages/contracts`, but must not import VS Code,
React, Node built-ins, or database drivers. `apps/web/src/ObjectDesigner.tsx`
owns React rendering while its controller and model keep state transitions and
target selection separate from presentation. API snapshot services retain
connection I/O and fingerprinting; pure SQLite/DuckDB parsing is reusable from
the shared package.

The boundary is validated at three levels: `packages/designer-core` unit tests
cover capability guards, dialect profiles, SQL builders, and catalog parsing;
API/web tests cover the consuming workspace packages; and
`npm run test:extension-host:designer` opens the production desktop designer
against a temporary SQLite database. `npm run check:architecture` rejects
platform imports from shared packages, with its own regression tests in
`scripts/architecture-check.test.mjs`. The cycle intentionally does not add a
new public contract: existing exports remain additive-compatible across
desktop, API, and web consumers.

## Result-panel state and identity

The desktop result panel has a host state machine and a webview state machine.
The host streams rows (`appendRows`), sends authoritative hydrates, and keeps
disk-backed rows in SQLite when thresholds are exceeded. The webview owns grid
rendering, virtualization and presentation persistence. The platform-neutral
`@justybase/result-core` owns identity, structural state transitions and pure
filter/aggregation operations; `src/state/resultCoreStateAdapter.ts` bridges
the desktop resource-owning manager, while the web query adapter consumes the
same portable event reducer. Storage, transport, DOM and VS Code lifecycle
remain product-specific.

Every result now receives a stable `resultSetId`. Execution timestamps remain
useful metadata and are retained for backwards compatibility, but they are not
an identity: Logs can move to index zero, pinned results can shift indices, and
two executions can share a millisecond. Desktop grid state stores the stable ID
alongside the source/index projection and reads the legacy timestamp fallback;
the web grid uses a versioned `resultSetId` envelope with the legacy key as a
read fallback. Cached scroll state also carries the ID.

The real Extension Host bridge exposes a bounded diagnostic snapshot. The
`scrollResult` action drives production virtualization; the snapshot reports
both scroll axes, dimensions, virtualizer anchor, and the first rendered row
fingerprint. This makes source/tab/hydration races observable without exposing
SQL or row values in sanitized CI artifacts.

## Desktop execution lifecycle

`@justybase/database-runtime/execution` owns the product-neutral single/batch/
stream lifecycle: monotonic event order, statement attempts, cancellation,
timeout, reconnect eligibility, terminal state and resource cleanup. Desktop
code imports this narrow subpath so execution does not pull the runtime's
legacy Netezza compatibility facade into the desktop dependency graph.

`src/core/execution/desktopExecutionBackend.ts` is the VS Code adapter. It owns
connection acquisition, notices, timing and the structural bridge to the
activation-owned `StreamingManager`; history, macros and UI callbacks remain
in the single/batch product adapters. `src/core/batchQueryExecutor.ts` no longer
owns a parallel lifecycle. A reconnect keeps the original execution ID and may
emit `retrying`, while the shared lifecycle emits exactly one terminal status:
`success`, `error`, or `cancelled`, followed by the compatibility
`batch-completed` event carrying the same summary.

Automatic replay after a broken persistent connection is deliberately
conservative. It is limited to one allow-listed, call-free read-only statement
after macro expansion. Writes, DDL, calls, executable macros, function/sequence
expressions, multi-statement or ambiguous SQL are not replayed because their
database outcome may be unknown. Streaming execution is
eligible only until its first chunk crosses the consumer boundary; after that,
partial rows remain visible and the failure is terminal to prevent duplicates.
The execution-generation guard is checked around chunk delivery so a retired
execution cannot update a replacement owner. Every cancellation path invokes
statement-failure cleanup before leaving the batch so transaction-scoped
metadata state cannot survive a terminated execution. Resources registered by
an execution are released once in reverse registration order; cleanup errors
are retained in the summary and do not replace an earlier database cause.

`StreamingManager` and `QueryExecutionCoordinator` are created during
extension activation. Compatibility exports delegate to those instances; maps
and timers are disposed on deactivation. The API similarly owns one
orchestrator, rate limiter and query-job registry per `buildServer` instance
and drains them when the server closes.

## Dependency direction

Dependencies point from consumers to providers: UI/adapters → core/runtime →
contracts. Avoid cycles between result-panel facades,
messages, tabs, and grid persistence. New cross-platform behavior belongs in a
shared package only when it is free of VS Code APIs and has contract tests in
both consumers.

The repository-wide gate is configured in
[`quality/architecture-rules.json`](../quality/architecture-rules.json). It
parses production TypeScript with the Compiler API and resolves relative paths,
`tsconfig` aliases, workspace package names, literal `require()` calls,
dynamic imports (including import attributes), import-equals declarations,
import types, and `.js` specifiers pointing at TypeScript sources. It scans only
the production roots below; tests, mocks, declarations, `dist`, and
`node_modules` are excluded. A TypeScript source resolved outside those roots
is reported as `ARCH002`, rather than being treated as an asset. Invalid
forbidden-import regexes and any `tsconfig` parse diagnostics are `ARCH004`, so
alias resolution never silently falls back to a less strict configuration.

| Layer | Production roots | Allowed dependency targets |
| --- | --- | --- |
| `contracts` | `packages/contracts/src` | `contracts` |
| `shared` | `packages/*/src` (with the more-specific contracts root assigned to `contracts`) | `contracts`, `shared` |
| `desktop` | `src` | `contracts`, `shared`, `desktop` |
| `media` | `media` | `contracts`, `shared`, `desktop`, `media` |
| `api` | `apps/api/src` | `contracts`, `shared`, `api` |
| `web` | `apps/web/src` | `contracts`, `shared`, `web` |
| `electron-main` | `apps/electron/src/main` | `contracts`, `shared`, `api`, `electron-main` |
| `electron-preload` | `apps/electron/src/preload` | `contracts`, `electron-preload` |
| `electron-renderer` | `apps/electron/src/renderer` | `contracts`, `shared`, `electron-renderer` |
| `companions` | `extensions/*/src` | `contracts`, `shared`, `companions` |

The direction table is intentionally stricter than the current runtime graph.
There is no layer-wide `desktop ↔ companions` allowance, and the `exceptions`
array is empty, so no layer-direction exception is currently active. Companion
production code has no edge into `src`; optional capabilities are reached
through the contracts in `DatabaseAdvancedFeatures` and provider lookup in
`src/core/connectionFactory.ts`. The migrated designer webviews consume pure
`designer-core` DDL. Any future integration bridge must be reviewed as an
explicit, exact exception rather than added as a general allowance.

`ARCH001` reports a forbidden direction or platform import,
`ARCH002` reports an unresolved internal import, `ARCH003` reports a new or
changed strongly connected component, and `ARCH004` reports invalid or stale
configuration. Existing cycles, when intentionally retained during a staged
migration, are represented by exact node lists and a SHA-256 fingerprint of
their internal edges in `cycleExceptions`. The current configuration has no
layer/import exceptions and no cycle exceptions. The current graph contains
1,397 production files and 4,564 resolved internal edges and reports zero
cycles. The former R3/R8 cycles were closed through leaf modules, narrow ports,
neutral connection-factory ownership, and a host-provided maintenance
callback. Future forbidden edges or cycles fail the check.

The regression suite in
[`scripts/architecture-check.test.mjs`](../scripts/architecture-check.test.mjs)
covers resolution, layer rejection, unresolved imports, cycle fingerprints,
explicit exceptions, production-file filtering, malformed configuration, and
the complete current graph. Run `npm run check:architecture` for the blocking
fail-closed gate.

`pureSources` covers contracts, `*-core` packages, and the portable
`ui-monaco` browser boundary, including future metadata/result engines.
Register each future pure dialect package in that list when its first
implementation is added. Pure packages cannot import a
shared Node runtime, even through an alias. External imports require an exact
approved specifier; Node built-ins (bare and `node:`), VS Code, LSP libraries,
and Electron are rejected. `ui-react` is the deliberate pure presentation
exception: its exact React import is documented in
`quality/architecture-rules.json`; it still cannot import Node, VS Code,
Electron, database runtimes, or drivers. `ui-monaco` is a separate pure
browser package whose only editor dependency is the explicitly approved
`monaco-editor`; it does not import React, Electron, VS Code, or database
runtimes. This also rejects existing or new database drivers without relying
on a driver-name blacklist.
Shared packages reject `vscode` and `electron`; Node runtimes may use Node and
drivers. Companions may import their own implementation, shared contracts and
shared engines/runtime helpers, but cannot import another companion directly.

`packageDependencies` further restricts cross-package edges inside `shared`.
Every production package must declare a boundary when this map is enabled;
adding a package without one fails as `ARCH004`. Package restrictions cannot be
bypassed by a legacy layer exception. Internal imports within a package remain
subject to cycle checks.

`browserSources` starts a value-import traversal from web and media sources,
including worker modules. Every reachable external import must appear in the
exact `browserExternalImports` list; Node built-ins, VS Code and Electron remain
forbidden even if listed. Importing a shared Node runtime is also forbidden,
including through aliases or re-export facades. Explicit type-only references
are erased for this traversal but remain in the full dependency/cycle graph.
Mixed type/value imports are traversed. The check does not inspect dependency
internals in node_modules, so approving a library still requires checking its
browser entry point; nonliteral loaders and JavaScript assets remain outside
this TypeScript graph's proof.

Exceptions require exact paths and become errors when stale. Cycle node lists
and fingerprints are updated only when an intentional migration changes the
graph. Use
`npm run architecture:report --silent` for JSON containing the current edge
map, layer counts, complete cycle list, exceptions and diagnostics. It returns
a failure exit code on violations and never rewrites the baseline. The same
checker runs in the PR Quality Checks job and at the start of `verify:pr`.

Persisted UI state and webview messages are architecture boundaries as well as
implementation details. New persisted formats require a schema version,
migration/reset behavior, and stable ownership identity. High-traffic webview
protocols require exhaustive discriminated unions plus runtime validation at
untrusted boundaries.
