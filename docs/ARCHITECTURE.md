# Architecture overview

JustyBase is a layered monorepo with two runtime products and a shared contract
surface.

Cross-cutting architecture debt, enforcement work, and measurable exit criteria
are tracked in the
[Project Quality Improvement Roadmap](PROJECT_QUALITY_ROADMAP.md). This document
describes the intended structure; the automated architecture check determines
which parts are currently enforced.

```text
VS Code extension ──┐
                     ├─ packages/contracts ─ designer-core ─ database-runtime
Web React editor ─ apps/api ──────── sql-core ────────────────────────┘
```

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

Keep dependencies flowing downward: contracts → platform-neutral core/runtime →
API or desktop adapters → UI. Avoid cycles between result-panel facades,
messages, tabs, and grid persistence. New cross-platform behavior belongs in a
shared package only when it is free of VS Code APIs and has contract tests in
both consumers.

The current `check:architecture` gate protects `contracts`, `sql-core`,
`database-runtime`, and `designer-core` from direct `vscode` imports; it also
blocks React, Node, and database-driver imports from `designer-core`. It does
not yet prove the full dependency direction or detect repository-wide cycles.
Until CQ03 in the
quality roadmap is complete, reviewers must inspect new cross-layer imports and
Result Panel dependencies explicitly.

Persisted UI state and webview messages are architecture boundaries as well as
implementation details. New persisted formats require a schema version,
migration/reset behavior, and stable ownership identity. High-traffic webview
protocols require exhaustive discriminated unions plus runtime validation at
untrusted boundaries.
