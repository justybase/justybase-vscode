# Architecture overview

JustyBase is a VS Code extension with optional database companion extensions.
The monorepo keeps reusable contracts, SQL logic, runtimes, result state, and UI
components in shared packages. Those package boundaries remain intentional,
even when VS Code is their only current product consumer: platform-neutral
implementations stay testable and product adapters keep ownership of host APIs,
I/O, storage, transport, and lifecycle.

Cross-cutting architecture debt and measurable exit criteria are tracked in the
[Project Quality Improvement Roadmap](PROJECT_QUALITY_ROADMAP.md). The current
dependency map, contract audit, and migration history are in
[Shared-code migration preparation](SHARED_CODE_MIGRATION.md).

## Target ownership

Dependencies below mean “imports.” Composition roots select and inject
implementations; a pure engine never imports a product adapter or driver.

```text
VS Code extension host / webviews -> shared contracts, engines, runtimes, and UI
Companion extensions              -> shared contracts, engines, and runtimes
Shared engines                    -> contracts
```

| Logic | Target owner |
| --- | --- |
| Parser, linter, completion and SQL scope | `@justybase/sql-core` |
| Metadata model and pure merge/invalidation rules | `@justybase/metadata-core` |
| Result reducer, identity and pure data operations | `@justybase/result-core` |
| Execution, cancellation, retry and runtime resource cleanup | `@justybase/database-runtime` |
| Database-specific driver and Node I/O | `@justybase/sqlite-runtime`, `@justybase/duckdb-runtime`, `@justybase/netezza-runtime` |
| Database-specific SQL grammar and authoring | `packages/dialect-utils` and dialect adapters |
| Stable public types | `@justybase/contracts` |
| Shared React presentation and tokens | `@justybase/ui-react`; effects enter through product ports |
| Shared UI state and capabilities | `@justybase/ui-core` |
| Secrets, filesystem, VS Code integration and lifecycle | Desktop/companion product adapters |

These are ownership decisions, not a claim that every future engine already
exists. `designer-core`, `result-core`, and `metadata-core` own pure designer,
result, and metadata rules. Existing registries remain at their compatibility
seams; new process-global registries combining products and dialects are
prohibited. Composition-root review enforces lifetime and ownership rules; an
import graph alone cannot detect every global singleton.

## Runtime boundaries

- `src/extension.ts` is the desktop composition root. Deferred registrations
  load after activation and are skipped in tests.
- `src/core/connectionFactory.ts` and `DatabaseDialect` isolate database
  implementations. Shared providers must not assume Netezza behavior.
- `src/sqlParser`, the dialect lexer/parser, and LSP providers form the desktop
  authoring pipeline. `packages/sql-core` owns the Netezza parser, native
  validation, authoring, and quality subset; it must never import VS Code,
  LSP Node libraries, Node built-ins, or drivers.
- `@justybase/metadata-core` owns platform-neutral metadata keys, identifier
  policies, TTL classification, snapshot completeness, object-type merging,
  lookup-index construction, prefetch decisions, and generation rules. The
  desktop owns catalog queries, cache layers, disk formats, and hydration.
- `@justybase/sqlite-runtime` owns instance-scoped SQLite sessions, streamed
  query execution, cancellation, metadata access, and deterministic shutdown.
  Product adapters authorize paths before passing them to the runtime.
- `@justybase/duckdb-runtime` owns the DuckDB instance/session protocol,
  serialization, bounded materialization, cancellation, and instance
  ownership. File SQL conversion and view setup remain in the companion.
- `@justybase/netezza-runtime` is the sole production owner of the Netezza
  driver import. Desktop dialect and MCP composition roots use its factory;
  credentials and connection lifetimes remain adapter-owned.

## Shared designer boundary

`packages/designer-core` is the platform-neutral home for capability guards,
reviewed SQL builders, and catalog-row normalization used by desktop webviews
and companion extensions. It may depend on `packages/contracts`, but must not
import VS Code, React, Node built-ins, or database drivers. UI rendering and
connection I/O remain in product adapters.

`npm run test:designer-core` covers capability guards, dialect profiles, SQL
builders, and catalog parsing. The production desktop designer is covered by
`npm run test:extension-host:designer`; `npm run check:architecture` rejects
platform imports from shared packages.

## Result-panel state and identity

The desktop result panel has a host state machine and a webview state machine.
The host streams rows, sends authoritative hydrates, and keeps disk-backed rows
in SQLite when thresholds are exceeded. `@justybase/result-core` owns
identity, structural state transitions, and pure filter/aggregation
operations. `src/state/resultCoreStateAdapter.ts` bridges the
resource-owning result manager; `packages/ui-core` and `packages/ui-react`
provide shared state and presentation. Storage, transport, DOM, and VS Code
lifecycle remain in desktop adapters.

Every result receives a stable `resultSetId`. Execution timestamps remain
metadata and are retained for backwards compatibility, but they are not an
identity: Logs can move to index zero, pinned results can shift indices, and
two executions can share a millisecond. Grid state stores the stable ID with
the source/index projection and reads the legacy timestamp fallback.

## Desktop execution lifecycle

`@justybase/database-runtime/execution` owns the product-neutral single,
batch, and stream lifecycle: monotonic event order, statement attempts,
cancellation, timeout, reconnect eligibility, terminal state, and resource
cleanup. Desktop code imports this narrow subpath so execution does not pull
the runtime's legacy Netezza compatibility facade into the dependency graph.

`src/core/execution/desktopExecutionBackend.ts` is the VS Code adapter. It owns
connection acquisition, notices, timing, and the bridge to the
activation-owned `StreamingManager`; history, macros, and UI callbacks remain
in the single/batch product adapters. Automatic replay is limited to one
allow-listed, call-free read-only statement before any row delivery. Every
execution releases resources once in reverse registration order.

`StreamingManager` and `QueryExecutionCoordinator` are created during
extension activation. Compatibility exports delegate to those instances; maps
and timers are disposed on deactivation.

## Dependency direction and enforcement

Dependencies point from consumers to providers: UI/adapters → core/runtime →
contracts. Keep the existing separation between shared React components and
VS Code webview adapters. Avoid cycles between result-panel facades, messages,
tabs, and grid persistence. New cross-platform behavior belongs in a shared
package only when it is free of VS Code APIs and has contract tests.

[`quality/architecture-rules.json`](../quality/architecture-rules.json)
defines the five repository-wide import layers: contracts, shared packages,
desktop extension, webviews, and companion extensions. The check resolves TypeScript
aliases and workspace package names, rejects forbidden directions and
unresolved internal imports, and detects cycles. Run `npm run
check:architecture` for the blocking fail-closed gate.

`ui-react` is an intentional React presentation package. It may depend on
React, but not on Node, VS Code, database runtimes, or drivers. Shared packages
declare their allowed package dependencies explicitly. Browser-source checks
cover the VS Code webviews under `media/`; no web application is part of the
workspace.
