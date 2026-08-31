# Web Editor ↔ VS Code Extension — Parity Audit & Backlog

Last updated: 2026-08-31

This document is the **feature-by-feature parity audit** between the two products shipped
from this repository:

- **Desktop** — the VS Code extension (`src/`, `media/`, `extensions/`, 158 core palette commands).
- **Web** — `apps/web` (React + Monaco + TanStack) + `apps/api` (Fastify server) running the
  shared SQL core.

> This is a **living backlog**, not a status board frozen in time. When a backlog item is
> implemented, move it to **Done** and bump the date.
>
> Companion implementation references: `docs/LSP_FEATURE_MATRIX.md` (LSP transport),
> `docs/EDITOR_CAPABILITY_MATRIX.md` (desktop editor capability status),
> `docs/WEB_EDITOR.md` (how to run the web editor).
> Cross-cutting readiness and quality gates are owned by
> `docs/PROJECT_QUALITY_ROADMAP.md`; parity status alone does not make a feature
> production-ready.

---

## 1. Why parity is much closer than it looks

The web backend runs in Node and **reuses the real desktop SQL core instead of a regex port**:

- `apps/api/src/lspProtocol.ts` → `@justybase/sql-core` `NetezzaWebLspCore`
  (`packages/sql-core/src/runtime.ts`), which re-bundles the actual extension code:
  Chevrotain parser (`DocumentParseSession`), `SqlValidator`, `LspCompletionEngine`,
  `LspSchemaProvider`, `MetadataBridge`, `netezzaSqlAuthoring.validation`.
- Completion and diagnostics in the web therefore already carry the same parser-backed
  behavior as the desktop, including SQL003/004/007/025/026 and completion ranking.
- Query execution, metadata listing and export reuse `@justybase/database-runtime`,
  `@justybase/spreadsheet-tasks` and the same operator contracts.

**Consequence:** most remaining "parity" work lives in the *web surface* (API+UI) and in
*shimming* the other desktop LSP handlers into `sql-core`, not in re-implementing SQL logic.

---

## 2. Legend

### Parity status

| Status | Meaning |
| ------ | ------- |
| ✅ **Parity** | Web has a functionally equivalent feature. |
| 🟡 **Partial** | Feature exists but is reduced / uses a different (simpler) path. |
| ❌ **Missing** | Not present in web. |
| n/a | Not applicable to a browser environment (explicitly out of scope). |

### Effort (for the missing/partial backlog items)

| Size | Rough scope |
| ---- | ----------- |
| S | hours — pure wiring of an existing shared component |
| M | 1–3 days |
| L | 1–2 weeks |
| XL | multi-week, cross-cutting |

### Backlog priority
P0 = safety/regression risk, P1 = high value for cost, P2 = nice-to-have.

---

## 3. Domain summary

| Domain | Full parity | Value | Effort to reach parity |
| --- | --- | --- | --- |
| D1 – SQL language / editor intelligence | ✅ broad, 🟡 code actions | High | **M** |
| D2 – Query execution pipeline | ✅ broad, 🟡 desktop-specific depth | High | S–M |
| D3 – Results grid | ✅ core depth, 🟡 advanced analysis | High | M |
| D4 – Schema explorer / metadata | 🟡 | Medium | S–M |
| D5 – Database Ops (import/DDL/DBA) | ❌ large | Medium-High | L–XL |
| D6 – Multi-dialect support | ❌ | Medium | L–XL |
| D7 – Platform (auth/security/multi-user) | ✅ + web-native | High | S |
| D8 – AI / MCP / notebooks / ETL / ERD | ❌ | Medium | XL |

Fast summary: web covers **SQL authoring, single/smart/script execution, result
exploration, guarded writes, and schema browsing** well. The principal gaps are
remaining code actions, desktop-only database administration, advanced result
analysis, and remote multi-dialect runtimes. Test depth for the React surface is
materially behind its implemented functionality; see the quality roadmap.

---

## D1 – SQL Language / Editor Intelligence

| Feature | Desktop status / transport | Web | Effort | Notes |
| --- | --- | :-: | :-: | --- |
| Completion | ✅ LSP (`completionEngine`) | ✅ main + WS/LSP | – | Web LSP core provides completion; REST fallback regex-based. |
| Diagnostics (SQL/PAR) | ✅ LSP `publishDiagnostics` | ✅ WS `diagnostics` | – | Same `SqlValidator` via `sql-core`. |
| Diagnostics (NZ/NZP quality) | ✅ extension linter (`sqlLinterProvider`) | ✅ WS `diagnostics` | M ✅ | `QualityEngineCore` (vscode-free) in `src/sqlParser/qualityEngineCore.ts` — shared single source; desktop `SqlQualityEngine` is now a thin wrapper. `core.diagnostics()` runs NZ/NZP rules + carries parser `suggestedFix` in `data`. |
| Hover | ✅ LSP (`hoverHandler`, budgets) | ✅ WS `hover` | ✅ | Wrapped `provideHover` + session-scope deps in `NetezzaWebLspCore.hover()`; Monaco hover provider. |
| Go to Definition | ✅ LSP | ✅ WS | ✅ | Uses rename-symbol logic (`resolveSqlRenameSymbolWithSession`). |
| References | ✅ LSP | ✅ WS | ✅ | `symbols.ts` collector, `includeDeclaration` honored. |
| Rename (+ prepare) | ✅ LSP | ✅ WS | ✅ | Quote-aware `formatSqlRenameReplacement` — `prepareRename` + `rename`. |
| Inlay hints | ✅ LSP (`inlayHintEngine`) | ✅ WS | ✅ | Column/type hints via `LspInlayHintEngine` + `registerInlayHintsProvider`. |
| Signature help | ✅ LSP (`signatureAndCodeActionHandlers`) | ✅ WS | ✅ | `findFunctionCall` + `getDatabaseSqlAuthoring().signatures` + `registerSignatureHelpProvider`. |
| Code actions (linter fixes) | ✅ LSP SQL/PAR + ext NZ/NZP | ❌ | M | Expose `codeActions` JSON-RPC; NZ/NZP still extension-host → needs core port or a "quickfix" REST for NZ codes. |
| Code actions (refactors) | ✅ ext (Extract CTE / Materialize / Inline) | ❌ | M | `sqlRefactorCodeActions`. |
| Document symbols | 🟡 ext | ✅ WS | ✅ | Parse-session CST + macro scan mirrored from `documentSymbolProvider` into `documentSymbols()`. |
| Semantic tokens | ✅ ext (`semanticTokensProvider`) | ✅ WS | ✅ | Lexer/CST-based `computeSemanticTokens()` in `sql-core` (vscode-free) + Monaco `registerDocumentSemanticTokensProvider`; token-name sets shared via `src/sql/semanticTokenNames.ts` (single source, no duplication). |
| Formatting | 🟡 ext `sqlFormattingProvider` / `formatSql` | ✅ WS `formatting` | ✅ | Shared `formatSql` (now imports `sqlAuthoringRegistry` directly, not `connectionFactory`) — `format()` + Monaco format edit. |
| Snippets (`dialects/*/snippets`) | ✅ | ✅ | ✅ | REST `GET /api/lsp/snippets` reads the committed `.code-snippets` JSON (single source) → Monaco completion provider with `InsertAsSnippet`. |
| Statement window / Go to prev/next | ✅ ext | ✅ | ✅ | `SqlParser.getAdjacentStatementAtPosition` reused in core `window()` + Monaco Ctrl/Cmd+Up/Down commands. |
| CodeLens (Run/Explain per statement) | ✅ ext `sqlCodeLensProvider` | ❌ | M | Monaco has no official CodeLens; implement as editor-gutter buttons (low value). |

> **D1 core wiring shipped 2026-08-09** — hover/definition/references/rename/inlayHints/signatureHelp/
> documentSymbols/format implemented in `packages/sql-core/src/runtime.ts` + `index.d.ts`, JSON-RPC in
> `apps/api/src/lspProtocol.ts`, Monaco providers in `apps/web/src/sqlLanguage.ts`.

> **D1 leftovers shipped 2026-08-09 (same day)** — semantic tokens, snippets, statement window
> also wired end-to-end: `sql-core.semanticTokens()` + `window()`, JSON-RPC `textDocument/semanticTokens/full`
> + `justybase/statementNav`, Monaco semantic-tokens provider + snippet completions + Ctrl/Cmd+Up/Down
> statement nav. Core/API tests: `apps/api/tests/sqlCoreFeatures.test.ts` (8/8).

> **Commit 1 — NZ/NZP linter diagnostics shipped 2026-08-09** — `SqlQualityEngine` refactored
> into a thin vscode wrapper around the new vscode-free `QualityEngineCore`
> (`src/sqlParser/qualityEngineCore.ts`); desktop behavior unchanged (guard: `linterCodeActions`,
> `sqlQualityEngine.unified`, `linterRules.commentRegression`, 83 tests). `core.diagnostics()`
> now runs NZ/NZP quality rules and transports parser `suggestedFix` via `data.suggestedFix`
> through JSON-RPC and Monaco markers. Core/API tests: `sqlCoreFeatures.test.ts` (11/11). Code
> actions (NZ/NZP fixes + refactors) remain backlog (Commit 2).

---

## D2 – Query Execution Pipeline

| Feature | Desktop | Web | Status | Notes |
| --- | --- | --- | --- | --- |
| Single query run | ✅ | ✅ | ✅ | `startQuery` + WS events. |
| Multiple / batch run | ✅ `runQueryBatch` / continue-on-error | ✅ script execution and per-statement results | 🟡 | Web has smart/script modes, statement states, cancellation, and failed-statement retry; desktop's explicit continue-on-error command remains distinct. |
| Statement selection / cursor statement | ✅ `runStatement`, lens | ✅ | ✅ | Monaco selection runs directly; otherwise `cursorOffset` selects the statement under the cursor. |
| Query cancellation | ✅ | ✅ | ✅ | Esc + Ctrl-Enter, WS/Cancel route. |
| Result session (disk spool) | ✅ | ✅ | ✅ | API spool per user; paging server-side. |
| Server-side sort / filter / global search | ✅ | ✅ | ✅ | `QueryPageRequest` with `QuerySortSpec`, `columnFilters`, `globalFilter`. |
| Row limit banner | ✅ `updateResultLimitBanner` | ✅ status shows row-limit note | 🟡 | polish only. |
| Serial/smart query | ✅ | ✅ | ✅ | Web exposes run, smart, and batch/script modes. |
| History | ✅ | ✅ (panel + tab) | ✅ | web `HistoryPanel`. |
| Explain Plan | ✅ `explainQuery` + webview | ✅ `ExplainPanel` | ✅ | Uses provider-specific EXPLAIN SQL and renders output for the active statement. |
| Explain Plan (graph) | ✅ | ❌ | L | separate visualizer (graphviz) — lower priority. |
| Tuning advisor | ✅ `tuningAdvisor` | ❌ | L | optional; part of D5-adjacent. |

---

## D3 – Results Grid (TanStack vs desktop `media/resultPanel`)

| Feature | Desktop | Web | Status | Notes |
| --- | --- | --- | --- | --- |
| Pagination + manual page size | ✅ | ✅ | ✅ | 100/200/500/1000. |
| Sorting (server) | ✅ | ✅ | ✅ | `manualSorting` on `QueryPageRequest`. |
| Column filtering (server) | ✅ | ✅ | ✅ | per-column filter inputs. |
| Global text filter (server) | ✅ | ✅ | ✅ | toolbar input. |
| Column resize / pin / reorder | ✅ | ✅ | ✅ | |
| Row selection + Copy as TSV | ✅ | ✅ copy current page | 🟡 | desktop copies *all* rows (spool); web copies loaded page (current view). |
| Cell formatting (type-aware) | ✅ | ✅ | ✅ | numbers/dates/bools aligned; precision kept. |
| Aggregations (COUNT/SUM/AVG/MIN/MAX) | ✅ `grid/aggregation.ts` | ✅ full-spool API | ✅ | `/api/query/:id/aggregate` applies current server filters without reducing to the loaded page. |
| Grouping | ✅ `diskGrouping.ts` | ✅ full-spool API | ✅ | `/api/query/:id/group` supports grouped aggregates and limits. |
| Alternate views / pivot | ✅ `grid/alternateViews.ts` | ✅ basic pivot | 🟡 | Web pivot is a prompt-driven two-dimension SUM view; desktop has deeper cards/pivot UX. |
| Column charts / range | ✅ `rangeChart.ts`, mini-chart cards (`analysis.ts`) | ❌ | L | |
| Context menu | ✅ deep desktop menu | ✅ value/row formats, filter, sort, detail/edit | 🟡 | Desktop additionally exposes database- and analysis-specific actions. |
| Row detail / full row viewer | ✅ `rowView.ts` | ✅ | ✅ | Web renders all fields for the loaded row. |
| Large-data virtualization | ✅ disk-backed 200k+ | ✅ virtualized current page + server spool | 🟡 | Web virtualizes the selected server page rather than a continuous 200k-row window. |
| Result tabs / multi-query panel | ✅ tabs + container | ✅ editor and statement result tabs | ✅ | Results and statement status are retained per editor tab. |
| Grid state persistence (`localStorage`) | ✅ `persistence.ts` | ✅ | 🟡 | Web persists page size, sort, filters, visibility, pinning, and order; state is not yet schema-versioned. |

### D3 deep-dive — current web grid and remaining backlog

Key architecture fact: **desktop is a DOM grid with a Node host**; web is a
React/TanStack grid with a Fastify API. Full-result aggregation and grouping
already execute against the API SQLite spool; client features operate on the
loaded page. The renderers remain intentionally separate, while shared public
request/response types stay additive.

| # | Feature (desktop ref) | Web approach | Effort |
| --- | --- | --- | --- |
| G1 | Full-result aggregations | ✅ Implemented through `/aggregate`; precision/filter behavior has API tests. | Done |
| G2 | Grouping and basic pivot | ✅ Grouping and a client pivot are implemented; richer pivot configuration remains. | M polish |
| G3 | Context and copy formats | ✅ Value, TSV, JSON, Markdown, SQL INSERT, filter, and sort actions are implemented. | Done |
| G4 | Row detail and guarded edit | ✅ Row detail and preview-token-confirmed update flow are implemented for eligible table results. | M hardening |
| G5 | Virtualization and server paging | ✅ Implemented; continuous virtual navigation across server pages remains optional. | L |
| G6 | Result/grid state | ✅ Persisted per query/statement; add versioning, migrations, and deep reload tests. | M quality |
| G7 | Advanced cards/charts/range analysis | ❌ Desktop-only. | L |

**Suggested order:** version and deeply test grid state → harden guarded edit and
copy semantics → improve pivot UX → consider advanced cards/charts only after
the React coverage gate in the quality roadmap.

**Regression risk:** 🟢 **none to desktop** — this is `apps/web` + `apps/api` only. The one
rule that applies is the shared-contracts additive rule: any new request/response types
(`QueryAggregateRequest`, pivot spec) must **add** to `@justybase/contracts`/`webApi.ts`,
never re-type existing fields.

### Architecture decision (2026-08-09)

**Full grid unification (single shared renderer for desktop + web) is REJECTED.**

- Desktop grid (`media/resultPanel`) is vanilla-DOM + disk-backed, wired to the VS Code host
  (`protocol.ts`); web grid is React/TanStack with an async REST/WS spool. Merging renderers
  = a 2–3 week refactor with real desktop regression risk and no proportionate payoff.
- The web grid keeps its own **TanStack renderer**; the desktop grid stays as is.
- If pure logic sharing is ever wanted, extract it into a framework-agnostic
  `@justybase/grid-core` (formatting, aggregation math, clipboard generators, pivot/group SQL,
  edit-UPDATE builder) — additive, web-first, desktop adopts later. This is a **follow-up
  opportunity**, not a parity prerequisite.

---

## D4 – Schema Explorer & Metadata

| Feature | Desktop | Web | Status | Notes |
| --- | --- | --- | --- | --- |
| Schema tree (DB → Schema → Object) | ✅ | ✅ `SchemaTree` | ✅ | |
| Object search | ✅ `schemaSearchProvider` | ✅ REST `/api/schema/search` | ✅ | |
| Insert object/column name into editor | ✅ | ✅ | ✅ | `SchemaTree.insertNode`. |
| Drag & drop into editor | ✅ | ✅ (basic) | 🟡 | |
| Inspector (columns, PK/FK, comments) | ✅ | ✅ `InspectorPanel` | ✅ | |
| Top 1000 / Copy DDL | ✅ | ✅ context menu | 🟡 | Web DDL generation is simpler than provider-specific desktop generators; a dedicated Copy Name action remains absent. |
| Favorites / recent objects | ✅ `favoritesManager`, `schemaRecentObjects` | ✅ local favorites | 🟡 | Favorites exist; desktop has deeper recent-object integration. |
| Refresh/invalidate metadata | ✅ | 🟡 | — | Web object/column cache (`lsp.ts`) auto-expires after 5 min TTL; no on-demand invalidation hook (e.g. after DDL) yet. |

---

## D5 – Database Ops (import / DDL / DBA / maintenance)

Desktop-only note: Db2 and MySQL now have dedicated **Index Designer** and
**Partition Manager** webviews in the VS Code extension. PostgreSQL and SQLite
retain their existing command-based index/partition workflows; these are not
webviews.

| Feature | Desktop | Web | Status | Effort | Notes |
| --- | --- | --- | --- | --- | --- |
| Select top/1000, per object | ✅ | ✅ | ✅ | – | Schema context menu opens a source-backed query tab. |
| Generate DDL (`createDDL`, `goToCatalogDdl`) | ✅ provider-specific | 🟡 basic table/view DDL | 🟡 | M | Web Copy DDL does not yet match all provider-specific detail. |
| Copy DDL | ✅ | ✅ | ✅ | – | Available from the schema object menu. |
| View/Edit data (50k editor) | ✅ | ✅ guarded row edit | 🟡 | M | Web edit requires eligible source metadata, preview token, explicit confirmation, ownership, and non-read-only profile. |
| Import CSV/XLSX (smart paste, wizard) | ✅ | ✅ basic file import | 🟡 | L | Web supports preview-token-confirmed CSV/XLSX import; desktop wizard and format depth remain broader. |
| DDL templates (CREATE VIEW/PROC/SEQUENCE/EXT TABLE) | ✅ | ❌ | ❌ | M | Reuse `externalTableTemplates` and `procedureTemplates`. |
| Comments (table/column) | ✅ | ❌ | ❌ | S–M | Use the existing guarded write boundary. |
| Constraints PK/FK/Unique | ✅ | ❌ | ❌ | S–M | Requires provider-specific DDL and metadata refresh. |
| Indexes (Netezza/PG/SQLite/Db2/MySQL) | ✅ | ❌ | ❌ | M | Db2 and MySQL include dedicated Index Designer webviews; PostgreSQL and SQLite use command-based desktop workflows. |
| Partitions (PG/Db2/MySQL) | ✅ PG commands + Db2/MySQL managers | ❌ | ❌ | L | Provider syntax and restructuring safety differ materially. |
| Generic DML/DDL execution with confirmation | ✅ | ✅ | ✅ | – | Web previews exact statements, signs a short-lived token, requires confirmation, and records an audit entry. |
| Rename table / TRUNCATE / DROP guided actions | ✅ | ❌ | ❌ | S–M | SQL can run through the guarded generic path, but dedicated schema actions are missing. |
| Permissions / security panel | ✅ | ❌ | ❌ | XL | Desktop command: `openSecurityPanel`. |
| Session monitor | ✅ | ❌ | ❌ | XL | Desktop command: `showSessionMonitor`. |
| Tuning advisor | ✅ | ❌ | ❌ | L | Part of explain/tuning tooling. |
| Owner/recreate/skew workflows | ✅ | ❌ | ❌ | M | Includes change owner, table recreation, and data-skew checks. |
| XLSB/Excel open on export | ✅ (open in Excel) | ❌ | n/a | – | Browser downloads replace desktop application launch. |

> The generic write boundary is implemented: read-only profiles reject writes,
> mutable operations require an exact short-lived preview token and explicit
> confirmation, and execution is audited. Remaining D5 work is guided workflow
> depth and provider-specific SQL, not creation of an unguarded generic endpoint.

---

## D6 – Multi-dialect support

| DB | Desktop | Web | Status |
| --- | --- | --- | --- |
| Netezza | ✅ | ✅ | ✅ |
| SQLite / DuckDB | ✅ (extensions) | ✅ local profiles, metadata, query sessions, paging, analysis, and guarded writes | 🟡 product-depth parity |
| Oracle / PostgreSQL / Vertica / Snowflake / Db2 / MSSQL / MySQL / Access | ✅ (extensions) | ❌ | ❌ |

The web connection contract and form support Netezza, SQLite, and DuckDB.
Profiles retain a shared `DatabaseKind`; the API selects local database handling
and provider-specific EXPLAIN/write quoting without hard-coding every profile to
Netezza. Remote companion runtimes still require explicit server-side runtime
isolation, metadata providers, capability declarations, and live contracts.

SQLite and DuckDB are already available in the web API for local profiles,
metadata, query sessions, paging, aggregation and grouping. The remaining work
is parity polish (connection UX, file-SQL workflows, and capability-specific
metadata) before adding remote dialect drivers. Add Oracle, PostgreSQL, Vertica,
Snowflake, Db2, MSSQL, MySQL and Access only with explicit runtime isolation and
integration coverage.

---

## D7 – Platform / Security / Multi-user

| Feature | Desktop | Web | Status |
| --- | --- | --- | --- |
| Auth | none (VS Code) | ✅ login/session/CSRF | ✅ (web-native) |
| Multi-user workspaces | single-user | ✅ per-tenant connection store | ✅ |
| Read-only enforcement | toolbar toggle | ✅ `isReadOnlySql` on `startQuery` | ✅ |
| Transport security | n/a | ✅ cookies+samesite + CSRF + masterKey | ✅ — better than desktop |
| Self-hosting / container | – | ✅ documented in `WEB_EDITOR.md` | ✅ |
| User roles (admin/user) | – | ✅ admin and user management | ✅ web-native |
| Execution audit | limited local history | ✅ per-user audit log | ✅ web-native |

(No desktop-parity backlog applies to web-native controls. Follow-up work is
role-based connection sharing and deeper adversarial/security coverage.)

---

## D8 – Advanced / AI / MCP / Favorites / Syntax color

| Feature | Desktop | Web | Status |
| --- | --- | --- | --- |
| Copilot assistant (chat, tools, Fix/Optimize) | ✅ many | ❌ | (out of scope) |
| MCP server (read-only Netezza MCP) | ✅ | ❌ | S–M — worth exposing (Node-based, travels fine) |
| Netezza SQL Notebook (VS Code notebook) | ✅ `netezza-sql-notebook` | ❌ | L (React notebook) |
| ETL designer | ✅ | ❌ | XL |
| Visual Query Builder | ✅ | ❌ | XL |
| Test data generator | ✅ | ❌ | XL |
| ERD | ✅ `showERD` | ❌ | L (react-flow / mermaid) |
| Favorites | ✅ | ❌ | M |
| Semantic tokens/TextMate in Monaco | ✅ grammar (`netezza.tmLanguage.json`) | ✅ semantic-token provider | – |

---

## Summary table

| # | Area | Status | Web-specific | Suggested Effort |
|----|-------|--------| --- | --- |
| 0 | Baseline LSP (completion+diagnostics) | ✅ | shared | – |
|1 | Hover / Definition / References / Rename | ✅ | wiring | ✅ done (2026-08-09) |
| 2 | Inlay hints / Signature help | ✅ | wiring | ✅ done (2026-08-09) |
| 3 | Linter (NZ/NZP) + code actions into web | 🟡 NZ/NZP diag done | core | M — code actions still ❌ |
| 4 | Format SQL (real formatter) | ✅ | core | ✅ done (2026-08-09) |
| 5 | Snippets + semantic tokens | ✅ | core | ✅ done (2026-08-09) |
| 6 | Selected/cursor/smart/script run modes | ✅ | core+api+web | done |
| 7 | Aggregations + grouping + row virtualization | ✅ | grid+api | done |
| 8 | Grid context menu + row detail | ✅ broad | grid | 🟡 desktop-only actions remain |
| 9 | Alternate views | 🟡 basic pivot | grid | M for richer UX/cards |
| 10 | Guarded DML/DDL execution + confirm/audit | ✅ | api+web | done; guided DBA actions remain |
| 11 | Import | 🟡 CSV/XLSX file flow | api+web | L for desktop wizard/format depth |
| 12 | Multi-dialect start (SQLite/DuckDB) | ✅ | api+web | done; remote dialects remain |

---

## Recommended backlog order

1. **Quality foundation:** add React component coverage, version and test
   persisted tab/grid state, and enforce the high-risk gates in the project
   quality roadmap.
2. **Editor completion:** expose NZ/NZP quick fixes and parser-backed refactors
   through the web LSP/code-action surface.
3. **Grid hardening:** deepen reload/race/accessibility tests, improve pivot UX,
   and close copy/edit semantics before considering charts and cards.
4. **Database workflows:** deepen DDL generation and import UX on top of the
   existing preview-token/read-only/audit boundary; add dedicated destructive
   actions only with provider contracts and confirmation tests.
5. **Dialect expansion:** polish SQLite/DuckDB capability parity, then add remote
   runtimes one at a time behind the common dialect contract and live coverage.

Copilot, visual ETL, the test-data generator, ERD/visualizers, and notebooks are
P2 product decisions. They are not prerequisites for web editor quality or core
database workflow parity.

---

## Regression risk model (does web-parity risk the desktop extension?)

**Short answer:** the desktop extension and web are **runtime-isolated** — `dist/extension.js`
and the web server are separate processes, nothing in `apps/web` executes in desktop, and
desktop is unaffected by web-only code. The only coupling is *at build time*, where
`packages/sql-core` **imports desktop `src/`** (`runtime.ts` → `src/server/*`, `src/sqlParser/*`).
So risk is not "web runs against desktop", it is **"desktop source changed to serve both"**.

### Risk tiers per backlog area

| Area | Touches desktop `src/`? | Risk | Why / mitigation |
| --- | --- | --- | --- |
| **D1 wiring** (hover, definition, references, rename, inlay, signature, symbols, format) | **No** | 🟢 Low | All engines are LSP-pure (`hoverEngine.ts`, `metadataBridge`, `inlayHintEngine`) — no `vscode` import. Work happened in `packages/sql-core/src/runtime.ts` + `index.d.ts` + `lspProtocol.ts` + `sqlLanguage.ts`, **additive** to the desktop build. **Shipped 2026-08-09** — desktop regression green (`check-types`, `lint`, `build`, `test:validate`; current gate: 9247 tests). Guard: `npm run build:sql-core && npm run test:api`. |
| **D1 leftovers** (semantic tokens, snippets, statement window) | **No** (one pure-extraction) | 🟢 Low | Semantic tokens reuse the existing lexer + `parseSemanticScopeWithParser` + `identifierRoleCollector`; the token-name sets were **moved** (not copied) to vscode-free `src/sql/semanticTokenNames.ts`, and the desktop provider now imports from there — behavior-identical, verified by `semanticTokensProvider.test.ts` (43 tests). Snippets reuse the committed `.code-snippets` JSON; statement window reuses `SqlParser.getAdjacentStatementAtPosition`. **Shipped 2026-08-09.** |
| **NZ/NZP linter & NZ quick-fixes** | **Yes** (done for diag) | 🟢 Low–Med | `sqlQualityEngine` refactored into vscode-free `QualityEngineCore` (`src/sqlParser/qualityEngineCore.ts`) with `SqlQualityEngine` as a thin wrapper — desktop behavior identical, verified by `test:validate` (current gate: 9247 tests). NZ/NZP diagnostics now flow through `core.diagnostics()` with `suggestedFix` in `data`. Remaining: code-action providers (`linterCodeActions.ts`, `sqlRefactorCodeActions.ts` call `vscode`) — a future isolated port; keep vscode wrappers thin. |
| **Formatting** | One-line import | 🟢 Low | `formatSql()` in `src/services/sqlFormatter.ts` was already vscode-free but imported `connectionFactory` (→ dialects index → vscode). To expose it via `sql-core`, the import was swapped to `getDatabaseSqlAuthoring` from `core/sqlAuthoringRegistry` (a passthrough re-export — behavior identical). Desktop verified: `sqlFormatter.test.ts` 17/17, production `npm run build` green. |
| **DDL/import / generic run endpoint** | **No** | 🟢 Low | Reuses `@justybase/database-runtime`; web-side only. |
| **Multi-dialect (contracts)** | Shared package | 🟡 Low-Med | Adding to `DatabaseKind` / `DatabaseDialect` in `@justybase/contracts` **must stay purely additive** (union extension, no removal/re-type of existing fields). Desktop extensions consume the published package. Run `npm run test:api` + contracts tests + `scripts/version-sync` check. |
| **Stale `sql-core`/`runtime` build** | n/a | 🟡 build-flow | Web can silently run an old parser if `npm run build:sql-core` is skipped. Mitigation: CI builds `build:api` (which includes sql-core) before `test:api`; never ship stale `dist`. |

### Desktop side-guardrails (already in place, do not relax)

```bash
npm run check-types && npm run lint && npm run build && npm run test:validate
LSP_BENCHMARK_ENFORCE=1 npm run benchmark:lsp      # parseCalls ≤ 1, latency budgets
npm run test:completion-parity && npm run test:quickfix-regression
```

### Hard rules to keep desktop regression-safe

1. **No `vscode` import may enter `sql-core`.** Add a lint/import guard if desired; the
   `platform: node` esbuild build fails loudly if it sneaks in.
2. **Web must use the engines; never fork them.** Duplicating a rule/engine in `apps/`
   to save a refactor is the real drift/regression time-bomb. If something is vscode-bound,
   extract the *pure* core into `src/` (shared) and keep a thin vscode wrapper, don't copy.
3. **Desktop-first refactors** (e.g. NZ linter extraction) ship as isolated commits with
   their own tests, never inside a web-feature commit.
4. **Contracts changes are additive-only**, with `node scripts/version-sync.js check` passing.

---

## Verification

Every completed item must keep these green:

```bash
# full desktop validation
npm run check-types && npm run lint && npm run build && npm run test:validate

# web + api
npm run build:all
npm run check-types:api && npm run test:api        # includes apps/api/tests/sqlCore*.test.ts
npm run check-types:web && npm run build:web && npm run test:web

# D1 core shared-surface regression (this hierarchy blocks desktop impact)
node scripts/build-sql-core.js && npm run test:api
```

LSP-parity work must add **tests** against the parser (never only integration) — per
`docs/EDITOR_CAPABILITY_MATRIX.md` "First-class" standard.
