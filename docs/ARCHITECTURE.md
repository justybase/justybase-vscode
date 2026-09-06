# Architecture overview

JustyBase is a layered monorepo with two runtime products and a shared contract
surface.

Cross-cutting architecture debt, enforcement work, and measurable exit criteria
are tracked in the
[Project Quality Improvement Roadmap](PROJECT_QUALITY_ROADMAP.md). This document
describes the intended structure; the automated architecture check determines
which parts are currently enforced.

The current dependency map, contract audit, service proposal and ordered
migration gates are in [Shared-code migration preparation](SHARED_CODE_MIGRATION.md).
The first SQL validation boundary is now implemented as a compatibility slice:
`@justybase/sql-core/validation` owns the platform-neutral types and
orchestration seam, while the legacy parser remains behind an explicit
desktop/API adapter until the pure parser closure is extracted.
This does not create empty packages or an Electron application.

## Target ownership

Arrows below mean “imports”; product composition roots select and inject
implementations. A pure engine never imports an adapter or driver.

```text
VS Code adapter / API backend / future Electron backend
    -> Node database-runtime -> dialect-<kind>-runtime -> driver
    -> pure SQL / metadata / result engines -> contracts
Desktop webview / React renderer -> pure engines and contracts
React renderer -> HTTP client -> API backend
```

| Logic | Target owner |
| --- | --- |
| Parser, linter, completion and SQL scope | `@justybase/sql-core` |
| Metadata model and pure merge/invalidation rules | future `@justybase/metadata-core` |
| Result reducer, identity and pure data operations | future `@justybase/result-core` |
| Execution, cancellation, retry and runtime resource cleanup | `@justybase/database-runtime` |
| Database-specific driver and Node I/O | future `@justybase/dialect-<kind>-runtime` |
| Database-specific SQL grammar and authoring | future `@justybase/dialect-<kind>` |
| Stable public and transport types | `@justybase/contracts` |
| Secrets, filesystem, transport, editor integration and lifecycle | product adapter |
| DOM/TanStack webviews and React components | separate desktop and React renderers |

These are ownership decisions, not a claim that extraction is complete.
`designer-core` already owns pure designer logic; `access-file` is a Node file
runtime. `sql-core` still bundles desktop sources through explicit debt bridges;
the validation subpath is the first exception-free extraction seam, not yet the
final parser implementation.
Pure engines receive schema providers, dialect profiles and other services as
arguments. Existing registries remain at their current compatibility seams;
new process-global registries combining products and dialects are prohibited.
Composition-root review enforces that lifetime/ownership rule; an import graph
alone cannot detect every global singleton.

The future Electron main process will host/manage the backend; its React
renderer will use the same HTTP client as web. Backend startup, authentication,
port selection and shutdown belong to that later composition-root slice.
Electron APIs must stay in its adapter, never in a shared package.

## Runtime boundaries

- `src/extension.ts` is the desktop composition root. Deferred registrations
  are loaded after activation and are skipped in tests.
- `src/core/connectionFactory.ts` and `DatabaseDialect` isolate database
  implementations. Shared providers must not assume Netezza behavior.
- `src/sqlParser`, the dialect lexer/parser, and LSP providers form the SQL
  authoring pipeline. `packages/sql-core` exposes the platform-neutral subset;
  it must never import `vscode`.
- `apps/api` owns authentication, per-user storage, query jobs, WebSockets, and
  disk-spooled sessions. `apps/web` consumes contracts through REST/LSP and
  renders Monaco/TanStack views.

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
rendering, filtering, virtualization, and scroll persistence.

Every result now receives a stable `resultSetId`. Execution timestamps remain
useful metadata and are retained for backwards compatibility, but they are not
an identity: Logs can move to index zero, pinned results can shift indices, and
two executions can share a millisecond. Grid state therefore writes keys in
`source:index:resultSetId` form, reads legacy timestamp keys, and stores the ID
in cached scroll state.

The real Extension Host bridge exposes a bounded diagnostic snapshot. The
`scrollResult` action drives production virtualization; the snapshot reports
both scroll axes, dimensions, virtualizer anchor, and the first rendered row
fingerprint. This makes source/tab/hydration races observable without exposing
SQL or row values in sanitized CI artifacts.

## Desktop execution lifecycle

`src/core/queryRetrySafety.ts` owns conservative replay classification for
single, sequential-batch, and streaming desktop execution.
`src/core/batchQueryExecutor.ts` owns the logical batch lifecycle. A reconnect
keeps the original execution ID and may emit `retrying`, but the lifecycle
emits exactly one terminal status: `success`, `error`, or `cancelled`.

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
metadata state cannot survive a terminated execution.

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
| `companions` | `extensions/*/src` | `contracts`, `shared`, `companions` |

The direction table is intentionally stricter than the current runtime graph.
Existing integration bridges are listed as individual `source`/`target`
exceptions with a `reason`, `owner` and `removeWhen`; there is no `desktop ↔ companions`
layer-wide allowance. The current exceptions cover the sql-core reuse of the
desktop parser/LSP implementation, companion adapters that still consume
desktop services, desktop registries that load optional companion providers,
and the small media-to-companion designer bridges. These are migration targets,
not permission to add another bridge without review.

`ARCH001` reports a forbidden direction or platform import,
`ARCH002` reports an unresolved internal import, `ARCH003` reports a new or
changed strongly connected component, and `ARCH004` reports invalid or stale
configuration. Existing cycles are represented by exact node lists and a
SHA-256 fingerprint of their internal edges in `cycleExceptions`. A new edge
inside one of those components changes the fingerprint and fails the check;
new components fail as well. This preserves the Result Panel cycle guard while
leaving the planned decomposition work to its owning CQ item.

The regression suite in
[`scripts/architecture-check.test.mjs`](../scripts/architecture-check.test.mjs)
covers resolution, layer rejection, unresolved imports, cycle fingerprints,
explicit exceptions, production-file filtering, malformed configuration, and
the complete current graph. Run `npm run check:architecture` for the blocking
fail-closed gate.

`pureSources` covers contracts and `*-core` packages, including future
metadata/result engines. Register each future pure dialect package in that
list when its first implementation is added. Pure packages cannot import a
shared Node runtime, even through an alias. External imports require an exact
approved specifier; Node built-ins (bare and `node:`), VS Code, React and
Electron are rejected. This also rejects existing or new database drivers
without relying on a driver-name blacklist. The existing SQL facade's
`vscode-languageserver/node` import is a single source-scoped
`pureExternalExceptions` debt entry. No new import may inherit it.
Shared packages reject `vscode` and `electron`; Node runtimes may use Node and
drivers. Companions may import their own implementation, shared contracts and
shared engines/runtime helpers, but cannot import another companion directly.

Exceptions require exact paths and become errors when stale. Cycle node lists
and fingerprints remain unchanged in this preparation. Use
`npm run architecture:report --silent` for JSON containing the current edge
map, layer counts, complete cycle list, exceptions and diagnostics. It returns
a failure exit code on violations and never rewrites the baseline. The same
checker runs in the PR Quality Checks job and at the start of `verify:pr`.

Persisted UI state and webview messages are architecture boundaries as well as
implementation details. New persisted formats require a schema version,
migration/reset behavior, and stable ownership identity. High-traffic webview
protocols require exhaustive discriminated unions plus runtime validation at
untrusted boundaries.
