# Architecture overview

JustyBase is a layered monorepo with two runtime products and a shared contract
surface.

```text
VS Code extension ──┐
                     ├─ packages/contracts ─ packages/sql-core ─ database-runtime
Web React editor ─ apps/api ────────────────────────────────────────┘
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

## Dependency direction

Keep dependencies flowing downward: contracts → platform-neutral core/runtime →
API or desktop adapters → UI. Avoid cycles between result-panel facades,
messages, tabs, and grid persistence. New cross-platform behavior belongs in a
shared package only when it is free of VS Code APIs and has contract tests in
both consumers.
