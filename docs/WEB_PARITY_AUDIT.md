# Web Editor ↔ VS Code Extension — Parity Audit & Backlog

Last updated: 2026-08-09

This document is the **feature-by-feature parity audit** between the two products shipped
from this repository:

- **Desktop** — the VS Code extension (`src/`, `media/`, `extensions/`, 152 palette commands).
- **Web** — `apps/web` (React + Monaco + TanStack) + `apps/api` (Fastify server) running the
  shared SQL core.

> This is a **living backlog**, not a status board frozen in time. When a backlog item is
> implemented, move it to **Done** and bump the date.
>
> Companion implementation references: `docs/LSP_FEATURE_MATRIX.md` (LSP transport),
> `docs/EDITOR_CAPABILITY_MATRIX.md` (desktop editor capability status),
> `docs/WEB_EDITOR.md` (how to run the web editor).

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
| D1 – SQL language / editor intelligence | ✅ base, ❌ most surface | High | **M** (mostly wiring) |
| D2 – Query execution pipeline | 🟡 | High | M–L |
| D3 – Results grid | 🟡 | High | M–L |
| D4 – Schema explorer / metadata | 🟡 | Medium | S–M |
| D5 – Database Ops (import/DDL/DBA) | ❌ large | Medium-High | L–XL |
| D6 – Multi-dialect support | ❌ | Medium | L–XL |
| D7 – Platform (auth/security/multi-user) | ✅ + web-native | High | S |
| D8 – AI / MCP / notebooks / ETL / ERD | ❌ | Medium | XL |

Fast summary: web currently covers **SQL authoring + running + results + schema browsing**
well. The gaps are **editor intelligence feathers** (cheap), **grid depth** (medium),
**database operations** and **multi-dialect** (large).

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
| Multiple / batch run | ✅ `runQueryBatch` / continue-on-error | ❌ | M | Web runs one statement per tab; reuse `queryBatchExecutor` semantics for "run all". |
| Statement select / run-all | ✅ `runStatement`, lens | ❌ | S | Take 1 selected statement from Monaco selection before `startQuery`. |
| Query cancellation | ✅ | ✅ | ✅ | Esc + Ctrl-Enter, WS/Cancel route. |
| Result session (disk spool) | ✅ | ✅ | ✅ | API spool per user; paging server-side. |
| Server-side sort / filter / global search | ✅ | ✅ | ✅ | `QueryPageRequest` with `QuerySortSpec`, `columnFilters`, `globalFilter`. |
| Row limit banner | ✅ `updateResultLimitBanner` | ✅ status shows row-limit note | 🟡 | polish only. |
| Serial/smart query | ✅ | ❌ | S | Just a run-mode flag in web. |
| History | ✅ | ✅ (panel + tab) | ✅ | web `HistoryPanel`. |
| Explain Plan | ✅ `explainQuery` + webview | ❌ | M | Add EXPLAIN renderer (tree/timeline). |
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
| Aggregations (SUM/AVG/MIN/MAX) | ✅ `grid/aggregation.ts` | ❌ | M | TanStack ‑ new `category` group or per-column footer in web. |
| Grouping / **alternate views** (cards / pivot) | ✅ `grid/alternateViews.ts` | ❌ | M–L | Pivot is a big one; cards/row-grouping is M. |
| Column charts / range | ✅ `rangeChart.ts`, mini-chart cards (`analysis.ts`) | ❌ | L | |
| Context menu (copy value/row as INSERT, column sum, GoTo, filter) | ✅ `selection/contextMenu.ts` | ❌ only placeholder Copy | M | |
| Row detail / full row viewer | ✅ `rowView.ts` | ❌ | S–M | Monaco-based detail panel; field-level gallery. |
| Large-data virtualization | ✅ `diskBackedGrid` (200k+) | ❌ | L | currently loads up to page size; fine under `MAX_ROWS`. Add `@tanstack/react-virtual` (already in deps). |
| Result tabs / multi-query panel | ✅ tabs + container | ✅ single-tab results | 🟡 | web shows results of current tab only. |
| Grid state persistence (`localStorage`) | ✅ `persistence.ts` | ✅ sidebar/prefs only | 🟡 | persist columns order/filter/sort per session. |

### D3 deep-dive — what desktop grid does, and the web backlog

Key architecture fact: **desktop is a DOM grid with a Node host**; web is a React/TanStack
grid with a Fastify API. Everything below is **100% web-side work** (no desktop `media/`
touch, no `src/` touch) except where noted. The desktop computes some aggregations and the
pivot through **generated SQL** (`media/resultPanel/explore/pivotTab.ts`) and all-rows
host messages (`media/resultPanel/databaseAggregations.ts`); the web should do the same
*semantics* but through its own API.

| # | Feature (desktop ref) | Web approach | Effort |
| --- | --- | --- | --- |
| G1 | **Full-result aggregations** (SUM/AVG/MIN/MAX/COUNT over the whole spool, not just page) `databaseAggregations.ts`, `grid/aggregation.ts` | New `POST /api/query/:id/aggregate` — compute over the sqlite spool (`querySessions`); render column-footer. TanStack side is trivial. | M |
| G2 | **Pivot** (generate GROUP BY SQL + grid) `explore/pivotTab.ts` | `POST /api/query/:id/pivot` returns a pivot spec + runs the generated SELECT via existing `startQuery`. Web renders group-row header grid. | M–L |
| G3 | **Grouping by column** `diskGrouping.ts` | Same generated-SQL machinery as G2 (GROUP BY); reuse. | M (after G2) |
| G4 | **Context menu** (copy value / copy row as TSV·JSON·SQL INSERT / copy column / filter on value / sort by value) `selection/contextMenu.ts` | Pure client in `ResultGrid.tsx`; clipboard formats generated locally. | S–M |
| G5 | **Copy formats** beyond TSV (markdown, SQL INSERT, JSON) `selection/clipboard.ts` | Local generators in web (`queryState`/new util). | S |
| G6 | **Row detail / field gallery** `rowView.ts` | Modal component fed by loaded row. | S |
| G7 | **Edit-in-place & write-back** (edit cell → UPDATE) `interaction.ts`, `messages.ts saveEdits` | Needs **write path** on API: `POST /api/query/:id/edit` builds `UPDATE table SET … WHERE pk` and runs DML (respects `readOnly` + ownership). Needs PK from metadata. Largest risk-adjacent item (writes to DB) — do last, with confirm + read-only guard. | M–L |
| G8 | **Large-set virtualization** (smooth scroll of current page, 200k+) `diskBackedGrid` | `@tanstack/react-virtual` already in deps; wrap body rows. Server page limit stays. | S–M |
| G9 | **Result tabs / multiple query panels** `tabs.ts` | Keep result per editor tab (already 1:1) — polish: preserve result when switching tabs. | S |
| G10 | **Grid state persistence** (sort/filter/pin/order per result) `persistence.ts` | localStorage keyed by `sessionId` in `ResultGrid`. | S |
| G11 | **Column trends / range chart** `rangeChart.ts` | SVG chart of current column page — nice-to-have, defer. | L |

**Suggested order:** G5+G6+G8 (S, immediate polish) → G1+G4 (M, biggest perceived value) →
G2+G3 (M–L) → G7 (write-back, last, with guardrails) → G11 (defer).

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
| Nice-to-have: copy name / Top 1000 / DDL | ✅ | ❌ | S each | actions belong to D5 but deserve real estate. |
| Favorites / recent objects | ✅ `favoritesManager`, `schemaRecentObjects` | ❌ | M | server-side favorites or localStorage. |
| Refresh/invalidate metadata | ✅ | 🟡 | — | Web object/column cache (`lsp.ts`) auto-expires after 5 min TTL; no on-demand invalidation hook (e.g. after DDL) yet. |

---

## D5 – Database Ops (import / DDL / DBA / maintenance)

| Feature | Desktop | Web | Status | Effort |
| --- | --- | --- | --- | --- |
| Select top/1000, per object | ✅ | ❌ | – | S |
| Generate DDL ($`createDDL`, `goToCatalogDdl`) | ✅ | ❌ | S | desktop uses `generateTableDDL` (`src/dialects/netezza/ddl/tableDDL.ts`) — port the pure generator to an API endpoint. |
| Copy DDL | ✅ | ❌ | S | |
| View/Edit data (50k editor) | ✅ | ❌ | M | edits need write-mode path in web (read-only guard exists). |
| Import CSV/XLSX (smart paste, wizard) | ✅ | ❌ | L | reuse `spreadsheet-tasks`; wizard bigger. |
| DDL templates (CREATE VIEW/PROC/SEQUENCE/EXT TABLE) | ✅ | ❌ | M | reuse `externalTableTemplates`, `procedureTemplates`. |
| Comments (table/column) | ✅ | ❌ | S–M | needs DDL-mutating endpoint. |
| Constraints PK/FK/Unique | ✅ | ❌ | S–M | |
| Indexes (Netezza/PG/SQLite) | ✅ | ❌ | M | |
| Partitions (PG/Netezza) | ✅ PG commands only | ❌ | L | |
| Rename table / TRUNCATE / DROP (confirm) | ✅ | ❌ | S–M | execution of DDL with confirmation modal. |
| Permissions / security panel | ✅ | ❌ | XL | `openSecurityPanel`. |
| Session monitor | ✅ | ❌ | XL | `showSessionMonitor`. |
| Tuning advisor | ✅ | ❌ | L | part of explain/tuning tooling. |
| `changeOwner` (`tableCommands.ts`), `recreateTable`; data-skew check (inside tuning `queryCommandTuning.ts`) | ✅ | ❌ | M | |
| XLSB/Excel open on export | ✅ (open in Excel) | ❌ | n/a | web just downloads. |

> D5 is the **biggest product-value lever** after D1–D3, but also the biggest *effort*:
> most mutating commands need a safe **"run DDL script"** endpoint (read-only enforced)
> — a single generic `POST /api/sql/run` that reuses `database-runtime.executeQuery` + a
> confirm dialog on the web. That unblocks almost every row in this table at once.

---

## D6 – Multi-dialect support

| DB | Desktop | Web | Status |
| --- | --- | --- | --- |
| Netezza | ✅ | ✅ | ✅ |
| SQLite / DuckDB / Oracle / PostgreSQL / Vertica / Snowflake / Db2 / MSSQL / MySQL / Access | ✅ (extensions) | ❌ | ❌ |

Web constraints that must change:

- 🛑 `apps/web/src/App.tsx` connection form hard-codes `dbType: 'netezza'`.
- 🟧 `apps/api/src/store.ts` — `dbType` field type is literal `'netezza'`; `dbType ?? 'netezza'` on insert.
- 🟧 `apps/api/src/server.ts:156` forces `dbType === 'netezza'`.
- ✅ `@justybase/contracts` already defines a rich `DatabaseKind` union and
  `DatabaseDialect` contract; connection traits / translator modules are all **shared**, so a
  Node-based web backend validates everything except browser-only bits (native drivers).
- 0️⃣ `apps/api/src/netezza.ts` — the whole metadata layer is Netezza-driver-specific. Need a generic
  `executeQueryForDialect(profile, sql)` gate in `apps/api/src/dialects.ts` (**planned — file does
  not exist yet**, mirror `connectionFactory`).

Start with **SQLite** (Node 22 built-in `node:sqlite`, dialect already in `src/dialects/sqlite/runtime.ts`)
and **DuckDB** (`@duckdb/node-api` already used by the DuckDB extension), then file-SQL
(spreadsheet/parquet via spreadsheet-tasks). Add the remaining dialects afterwards.

---

## D7 – Platform / Security / Multi-user

| Feature | Desktop | Web | Status |
| --- | --- | --- | --- |
| Auth | none (VS Code) | ✅ login/session/CSRF | ✅ (web-native) |
| Multi-user workspaces | single-user | ✅ per-tenant connection store | ✅ |
| Read-only enforcement | toolbar toggle | ✅ `isReadOnlySql` on `startQuery` | ✅ |
| Transport security | n/a | ✅ cookies+samesite + CSRF + masterKey | ✅ — better than desktop |
| Self-hosting / container | – | ✅ documented in `WEB_EDITOR.md` | ✅ |
| User roles (admin/user) | – | ✅ admin bootstrap | 🟡 only admin-ish |

(No backlog here for parity; everything is web-native already. Only polish: role-based
connection sharing, audit log.)

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
| Semantic tokens/TextMate in Monaco | ✅ grammar (`netezza.tmLanguage.json`) | ❌ | S (load grammar as Monarch or inject semantic) |

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
| 6 | Statement-select run-mode | ❌ | core | S |
| 7 | Aggregations + row virtualization | ❌ | grid | M–L |
| 8 | Grid context menu | ❌ | grid | M |
| 9 | Alternate views (cards) | ❌ | grid | M |
| 10 | DDL-ops generic run endpoint + confirm | ❌ | grid+api | M (fast unlock) |
| 11 | Import (smart paste + basic wizard) | ❌ | api | L |
| 12 | Multi-dialect start (SQLite/DuckDB) | ❌ | api | L |

---

## Roadmap suggestion (order)

**Commit 0 — LSP core sharing (DONE 2026-08-09)** (D1: hover, definition, references,
rename + prepare, inlay hints, signature help, document symbols, formatting).

**Commit 1 — "NZ/NZP linter diagnostics" (DONE 2026-08-09, part 1 of D1:3)** —
`SqlQualityEngine` slimmed to a vscode wrapper around the new vscode-free
`QualityEngineCore` (`src/sqlParser/qualityEngineCore.ts`); desktop behavior unchanged.
`core.diagnostics()` runs NZ/NZP quality rules and transports parser `suggestedFix` via
`data`. **Remaining in D1:3:** code actions (NZ/NZP fixes + refactors) = next commit.

**Commit 2 — "surface leftovers" (DONE 2026-08-09)** (D1: semantic tokens, snippets,
statement window). Semantic tokens: vscode-free lexer/CST tokenizer in `sql-core` +
Monaco `registerDocumentSemanticTokensProvider`; token name sets single-sourced from
`src/sql/semanticTokenNames.ts`. Snippets: REST `GET /api/lsp/snippets` reads the committed
`.code-snippets` JSON → Monaco snippet completions. Statement window: reused `SqlParser`
`getAdjacentStatementAtPosition` + Ctrl/Cmd+Up/Down Monaco commands.

**Commit 3 — "grid depth"** (D3: aggregation, context menu, virtualization, rowView).

**Commit 4 — "DDL ops"** (D5: run-script endpoint, confirm modal, Top-1000 / Get-column /
DDL generation, import).

**Commit 5 — "dialects"** (D6: SQLite, DuckDB, then rest).

**Out of scope for v1:** Copilot; visual ETL; test-data generator; ERD/visualizer;
notebooks — those are large product scoping decisions, not parity reminders.

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
| **D1 wiring** (hover, definition, references, rename, inlay, signature, symbols, format) | **No** | 🟢 Low | All engines are LSP-pure (`hoverEngine.ts`, `metadataBridge`, `inlayHintEngine`) — no `vscode` import. Work happened in `packages/sql-core/src/runtime.ts` + `index.d.ts` + `lspProtocol.ts` + `sqlLanguage.ts`, **additive** to the desktop build. **Shipped 2026-08-09** — desktop regression green (`check-types`, `lint`, `build`, `test:validate` 8398 tests). Guard: `npm run build:sql-core && npm run test:api`. |
| **D1 leftovers** (semantic tokens, snippets, statement window) | **No** (one pure-extraction) | 🟢 Low | Semantic tokens reuse the existing lexer + `parseSemanticScopeWithParser` + `identifierRoleCollector`; the token-name sets were **moved** (not copied) to vscode-free `src/sql/semanticTokenNames.ts`, and the desktop provider now imports from there — behavior-identical, verified by `semanticTokensProvider.test.ts` (43 tests). Snippets reuse the committed `.code-snippets` JSON; statement window reuses `SqlParser.getAdjacentStatementAtPosition`. **Shipped 2026-08-09.** |
| **NZ/NZP linter & NZ quick-fixes** | **Yes** (done for diag) | 🟢 Low–Med | `sqlQualityEngine` refactored into vscode-free `QualityEngineCore` (`src/sqlParser/qualityEngineCore.ts`) with `SqlQualityEngine` as a thin wrapper — desktop behavior identical, verified by `test:validate` (8416 tests). NZ/NZP diagnostics now flow through `core.diagnostics()` with `suggestedFix` in `data`. Remaining: code-action providers (`linterCodeActions.ts`, `sqlRefactorCodeActions.ts` call `vscode`) — a future isolated port; keep vscode wrappers thin. |
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