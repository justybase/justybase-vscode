# JustyBase threat model

This document is the maintainable threat model for the JustyBase VS Code
extension and its companion extensions. It covers the trust boundaries listed
in the project quality roadmap (`SQ01`) and is verified against the current
implementation. Cross-cutting quality work is tracked in the
[Project Quality Improvement Roadmap](PROJECT_QUALITY_ROADMAP.md).

## Scope and assets

The extension handles data that must be treated as sensitive:

| Asset | Where it lives |
| --- | --- |
| Database credentials (passwords, tokens, key-pair secrets) | VS Code SecretStorage, process environment for MCP |
| Connection profiles and tunnel relay tokens | SecretStorage + non-secret global-state fast-start cache |
| SQL text, result rows, schema/metadata | Editor, result-panel webviews, disk-backed result spill, logs |
| Test-only reports, traces, screenshots | `artifacts/` (gitignored), sanitized projection |
| Packaged artifacts (VSIX) and native runtimes | Build output, release assets |

Out of scope: the database server's own security model, the operating-system
account, and any MCP client that the user chooses to connect.

## Trust boundaries

```text
VS Code (trusted host) ── postMessage ──▶ webviews (untrusted DOM)
VS Code (trusted host) ── stdio/HTTP ───▶ MCP server process (user SQL input)
VS Code (trusted host) ── paths ────────▶ local file runtimes (SQLite/Access/DuckDB)
VS Code (trusted host) ── SQL ──────────▶ database (read-only vs write)
VS Code (trusted host) ── artifacts ────▶ reports/traces/screenshots on disk
```

Webviews, model-provided SQL, and selected local paths are treated as
untrusted. The extension host is the authority for authorization and for
constructing SQL it executes.

## T1 — SecretStorage

**Threat:** credential disclosure through logs, the non-secret fast-start
cache, process arguments, repository files, or world-readable channels.

**Controls:**

- Connection profiles are stored through the SecretStorage compatibility
  layer (`src/compatibility/state.ts:64`, service keys
  `justybase-vscode-connections` with legacy `netezza-vscode-connections`
  reads).
- The non-secret fast-start cache strips passwords before writing global state
  (`src/core/connectionManager.ts:617`).
- MCP connection details, including the password, travel only through the
  child-process environment and are never written to disk
  (`src/mcp/mcpHttpServerManager.ts`, docs/MCP_SERVER.md).
- `.vscodeignore` keeps `packages/`, `scripts/`, `docs/`, and lockfiles out of
  the published VSIX.

**Residual risk:** a compromised VS Code extension host can read the secret
store; that is outside JustyBase's control. Extension code must never log
secret values (see `npm run lint` `no-console` restrictions).

## T2 — Untrusted webview messages

**Threat:** a webview (or injected content) sends malformed, oversized, or
spoofed messages that reach privileged host handlers, causing unauthorized
queries, path access, or state corruption.

**Controls:**

- Every result-panel message is validated at the host boundary with an
  exhaustive command union and per-field rules before it reaches a handler
  (`src/contracts/webviews/resultPanelRuntime.ts:219`,
  `parseResultPanelWebviewMessage` / `parseResultPanelHostMessage`).
- The webview validates host messages symmetrically
  (`media/resultPanel/protocol.ts:72`, `:224`).
- Webviews are created with `enableScripts: true` and a restricted
  `localResourceRoots`; generated HTML uses a per-load nonce and a
  `default-src 'none'` Content-Security-Policy (e.g.
  `src/views/resultPanelView.ts:531`, `src/views/securityPanelView.ts:436`).
- Adversarial coverage: `src/__tests__/resultPanelProtocol.test.ts` rejects
  non-record values, non-string commands, malformed indexes, wrong field
  types, unknown enum values, and `__proto__` payloads.

**Residual risk:** validation accepts additional unknown properties on a known
command (the record is passed through). Handlers only read declared fields, so
this is informational rather than exploitable, but new handlers must not trust
extra keys.

## T3 — Local-file authorization

**Threat:** SQL or a crafted profile causes the extension to read, write, or
attach an arbitrary absolute path outside what the user authorized.

**Controls:**

- Runtimes receive only absolute, product-authorized paths or the special
  `:memory:` target. The SQLite runtime rejects relative or empty paths and
  constrains `ATTACH` to a literal authorized path
  (`packages/sqlite-runtime/src/index.ts:24`, `:137`, `:201`).
- Product adapters own file pickers and workspace authorization before passing
  a path to a runtime (`docs/ARCHITECTURE.md` runtime boundaries).
- Access (`packages/access-file`) and DuckDB (`packages/duckdb-runtime`) follow
  the same instance-owned session model.

**Residual risk:** authorization is only as strong as the product adapter that
selects the path; new file surfaces must route through a picker/workspace check
and never accept a raw path from a webview message.

## T4 — Read-only bypass

**Threat:** SQL intended to mutate data (or acquire locks) is executed without
user confirmation, or a read-only connection is made to run writes.

**Controls:**

- Read-only intent propagates through execution as
  `ExecutionRequest.readOnly` into the backend query options
  (`packages/database-runtime/src/execution.ts:720`).
- AI/MCP planner access is gated by `buildSafeExplainSql`
  (`src/services/copilotTools/aiSqlSafety.ts`): exactly one statement, must
  start with `SELECT`/`WITH`, and rejects DML/DDL keywords, `SELECT ... INTO`,
  and `FOR UPDATE`/`FOR SHARE` locking clauses after stripping strings and
  comments.
- The MCP gate (`src/mcp/mcpReadOnlyGate.ts`) is applied by both user-SQL tools
  (`explain_sql`, `analyze_query_plan`) and therefore on both the stdio and
  HTTP transports, which share `createNetezzaMcpServer`
  (`src/mcp/mcpServerCore.ts:13`).
- Adversarial coverage: `src/__tests__/aiSqlSafety.test.ts`,
  `src/__tests__/mcp/mcpReadOnlyGate.test.ts`, and
  `src/__tests__/mcp/mcpToolRegistry.test.ts`.

**Residual risk:** Netezza-side read-only enforcement of arbitrary editor SQL
relies on the connection option and statement classification; the automatic
replay path is limited to one allow-listed, call-free read-only statement
(`src/core/execution/desktopExecutionBackend.ts`).

## T5 — Write and DDL confirmation

**Threat:** a destructive statement runs without the operator seeing the exact
SQL and consequences.

**Controls:**

- Destructive table operations require a modal confirmation that shows the
  generated statement (`src/commands/schema/tableCommands.ts`).
- Designers emit DDL only after a capability guard accepts the operation for
  the selected dialect (`packages/designer-core/src/designerOperationGuard.ts`,
  `packages/designer-core/src/designer.ts`).
- The security panel renders a generated statement for review before execution
  (`src/views/securityPanelView.ts:195`).
- Dialects that the generic wizard cannot express safely are gated off rather
  than emitting unsupported DDL (`netezza.alterTableWizard`,
  `netezza.compareSchema`).

**Residual risk:** confirmation is a UX control, not an authorization control; a
compromised host or an explicit test opt-in can still run writes.

## T6 — Artifact redaction

**Threat:** reports, traces, screenshots, backups, or exports leak SQL, row
values, credentials, or host details.

**Controls:**

- Extension Host traces are an allow-list projection of selected scalar fields;
  raw `error`, `sql`, and `rows` are never written, and `sourceUri` is stored
  only as a `sha256:` fingerprint
  (`src/activation/resultPanelRegression.ts:300`).
- The smoke gate asserts sanitization: `scripts/extensionHost/extensionHostSmoke.js:96`
  fails if a trace event carries `error`, `sql`, or `rows`, or a non-fingerprint
  `sourceUri`.
- Screenshots are opt-in and stored under `artifacts/` (gitignored); fixtures
  must be reviewed before external sharing (`SECURITY.md`).
- Generated reports and coverage artifacts live in gitignored paths.

**Residual risk:** reports contain command names and counters; screenshots can
contain SQL and result values and must never be published without review.

## T7 — MCP read-only gate (stdio and HTTP)

**Threat:** an external MCP client submits arbitrary SQL through the server.

**Controls:**

- The server exposes only catalog introspection, parser validation, and
  EXPLAIN-plan tools; all tools carry `readOnlyHint: true`
  (`src/mcp/mcpServerCore.ts:30`).
- Catalog queries are constructed internally by `CatalogIntrospection`; the
  only user-SQL entry points pass through the gate before execution.
- The HTTP transport binds `127.0.0.1` and creates a per-session server
  instance that uses the same gated tool definitions
  (`src/mcp/mcpServerEntry.ts`).
- The server refuses to start for non-Netezza connections.

## Verification map

| Boundary | Evidence |
| --- | --- |
| Webview messages | `src/__tests__/resultPanelProtocol.test.ts`, `npm run test:extension-host` |
| Read-only SQL (AI/MCP) | `src/__tests__/aiSqlSafety.test.ts`, `src/__tests__/mcp/*` |
| Local files | `npm run test:sqlite-runtime`, `npm run test:access:integration`, `npm run test:file:integration` |
| DDL / writes | `src/__tests__/tableCommands.test.ts`, `npm run test:designer-core`, `npm run test:extension-host:designer` |
| Artifacts | `scripts/extensionHost/extensionHostSmoke.js` sanitization assertions |
| Secrets | `src/__tests__/connectionManager.test.ts`, `npm run lint` |

## Open work

- Expand adversarial coverage to every webview protocol (SQ02); the result
  panel is the reference implementation.
- Add malformed-payload and read-only-bypass cases for remaining panels and
  dialects as they are promoted.
- Keep this model updated when a new trust boundary, file surface, or
  model-driven tool is added.
