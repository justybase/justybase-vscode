# Web Editor ↔ VS Code Extension — Parity Audit & Backlog

Last updated: 2026-09-12

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

The web backend runs in Node and **reuses the platform-neutral Netezza SQL core instead of a regex port**:

- `apps/api/src/lspProtocol.ts` → `apps/api/src/sqlCoreLsp.ts` →
  `@justybase/sql-core`, which composes the Chevrotain parser, native
  `NetezzaSqlSemanticValidator`, completion/authoring helpers and
  `QualityEngineCore` with API-owned metadata and transport state.
- Completion and diagnostics in the web therefore already carry the same parser-backed
  behavior as the desktop, including SQL003/004/007/025/026 and completion ranking.
- Query execution, metadata listing and export reuse `@justybase/database-runtime`,
  `@justybase/spreadsheet-tasks` and the same operator contracts.

**Consequence:** most remaining "parity" work lives in the *web surface* (API+UI) and in
*shimming* the other desktop LSP handlers into the API adapter, not in
re-implementing SQL logic or importing desktop sources into `sql-core`.

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
| D1 – SQL language / editor intelligence | ✅ broad, 🟡 advanced code actions | High | **M** |
| D2 – Query execution pipeline | ✅ broad, 🟡 desktop-specific depth | High | S–M |
| D3 – Results grid | ✅ core depth, 🟡 advanced analysis | High | M |
| D4 – Schema explorer / metadata | 🟡 | Medium | S–M |
| D5 – Database Ops (import/DDL/DBA) | ❌ large | Medium-High | L–XL |
| D6 – Multi-dialect support | 🟡 authoring / ❌ remote runtime | Medium | L–XL |
| D7 – Platform (auth/security/multi-user) | ✅ + web-native | High | S |
| D8 – AI / MCP / notebooks / ETL / ERD | ❌ | Medium | XL |

Fast summary: web covers **SQL authoring, single/smart/script execution, result
exploration, guarded writes, and schema browsing** well. The principal gaps are
advanced desktop-only code actions and database administration, advanced result
analysis, and remote multi-dialect runtimes. Test depth for the React surface is
still behind its implemented functionality; see the quality roadmap.

---

## D1 – SQL Language / Editor Intelligence

| Feature | Desktop status / transport | Web | Effort | Notes |
| --- | --- | :-: | :-: | --- |
| Completion | ✅ LSP (`completionEngine`) | ✅ main + WS/LSP | – | REST and WS use the same API LSP core; parser-derived table/alias context stays in `sql-core`, while API owns metadata/cache lifecycle. |
| Diagnostics (SQL/PAR) | ✅ LSP `publishDiagnostics` | ✅ WS `diagnostics` | – | Netezza uses the same native validator through desktop/API adapters. |
| Diagnostics (NZ/NZP quality) | ✅ extension linter (`sqlLinterProvider`) | ✅ WS `diagnostics` | M ✅ | `QualityEngineCore` in `@justybase/sql-core`; desktop `SqlQualityEngine` and API LSP are thin product adapters. Parser-owned `suggestedFix` data and NZ/NZP mappings remain intact. |
| Hover | ✅ LSP (`hoverHandler`, budgets) | ✅ WS `hover` | ✅ | Wrapped `provideHover` + session-scope deps in `NetezzaWebLspCore.hover()`; Monaco hover provider. |
| Go to Definition | ✅ LSP | ✅ WS | ✅ | Uses rename-symbol logic (`resolveSqlRenameSymbolWithSession`). |
| References | ✅ LSP | ✅ WS | ✅ | `symbols.ts` collector, `includeDeclaration` honored. |
| Rename (+ prepare) | ✅ LSP | ✅ WS | ✅ | Quote-aware `formatSqlRenameReplacement` — `prepareRename` + `rename`. |
| Inlay hints | ✅ LSP (`inlayHintEngine`) | ✅ WS | ✅ | Column/type hints via `LspInlayHintEngine` + `registerInlayHintsProvider`. |
| Signature help | ✅ LSP (`signatureAndCodeActionHandlers`) | ✅ WS | ✅ | `findFunctionCall` + `getDatabaseSqlAuthoring().signatures` + `registerSignatureHelpProvider`. |
| Code actions (linter fixes) | ✅ LSP SQL/PAR + ext NZ/NZP | 🟡 WS/LSP | M | Shared core exposes parser fixes, SQL004/007/012/019/048, PAR003/PAR004/PAR101, Netezza guard/limit/normalization fixes, and metadata-backed qualification. Desktop still has richer context-sensitive NZ/NZP actions. |
| Code actions (refactors) | ✅ ext (Extract CTE / Materialize / Inline) | ❌ | M | `sqlRefactorCodeActions`. |
| Document symbols | 🟡 ext | ✅ WS | ✅ | Parse-session CST + macro scan mirrored from `documentSymbolProvider` into `documentSymbols()`. |
| Semantic tokens | ✅ ext (`semanticTokensProvider`) | ✅ WS | ✅ | The API adapter composes the vscode-free sql-core lexer and symbol collector into LSP tokens; desktop semantic token ownership remains product-specific. |
| Formatting | 🟡 ext `sqlFormattingProvider` / `formatSql` | ✅ WS `formatting` | ✅ | Netezza desktop and API formatting use `formatNetezzaSql` from sql-core; other dialect formatter profiles remain desktop-owned. |
| Snippets (`dialects/*/snippets`) | ✅ | ✅ | ✅ | REST `GET /api/lsp/snippets` reads the committed `.code-snippets` JSON (single source) → Monaco completion provider with `InsertAsSnippet`. |
| Statement window / Go to prev/next | ✅ ext | ✅ | ✅ | `SqlParser.getAdjacentStatementAtPosition` reused in core `window()` + Monaco Ctrl/Cmd+Up/Down commands. |
| CodeLens (Run/Explain per statement) | ✅ ext `sqlCodeLensProvider` | ❌ | M | Monaco has no official CodeLens; implement as editor-gutter buttons (low value). |

> **D1 core wiring shipped 2026-08-09** — hover/definition/references/rename/inlayHints/signatureHelp/
> documentSymbols/format are composed by `apps/api/src/sqlCoreLsp.ts` from the
> platform-neutral package, with JSON-RPC in `apps/api/src/lspProtocol.ts` and
> Monaco providers in `apps/web/src/sqlLanguage.ts`.

> **D1 leftovers shipped 2026-08-09 (same day)** — semantic tokens, snippets, statement window
> also wired end-to-end by the API product adapter (`apps/api/src/sqlCoreLsp.ts`), with JSON-RPC
> `textDocument/semanticTokens/full` + `justybase/statementNav`, Monaco semantic-tokens provider
> + snippet completions + Ctrl/Cmd+Up/Down statement nav. Core/API tests:
> `apps/api/tests/sqlCoreFeatures.test.ts` (8/8).

> **Commit 1 — NZ/NZP linter diagnostics shipped 2026-08-09** — `SqlQualityEngine` refactored
> into a thin VS Code adapter around the vscode-free `QualityEngineCore` in
> `@justybase/sql-core` (the desktop adapter is `src/sqlParser/qualityEngineCore.ts`);
> desktop behavior unchanged (guard: `linterCodeActions`,
> `sqlQualityEngine.unified`, `linterRules.commentRegression`, 83 tests). `core.diagnostics()`
> now runs NZ/NZP quality rules and transports parser `suggestedFix` via `data.suggestedFix`
> through JSON-RPC and Monaco markers. Core/API coverage lives in
> `apps/api/tests/sqlCoreFeatures.test.ts` and the shared browser gate.

> **D1 authoring parity refresh 2026-09-12** — the shared Web/Electron authoring path now
> exposes the complete connection-profile dialect catalog, live completion checks for
> PostgreSQL, Db2, ClickHouse, Oracle and MSSQL, and an Extension Host `Definition Provider`
> check for CTE navigation. Deterministic shared quick fixes are available through the same
> WebSocket LSP contract; full desktop refactor actions remain intentionally separate.

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

## D3 – Results Grid (shared Web/Electron renderer + desktop compatibility)

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
| Large-data virtualization | ✅ disk-backed 200k+ | ✅ shared virtualized page + server spool | 🟡 | Web and Electron use the same React/TanStack renderer and virtualized page contract; VS Code keeps its disk-backed DOM renderer. |
| Result tabs / multi-query panel | ✅ tabs + container | ✅ editor and statement result tabs | ✅ | Results and statement status are retained per editor tab. |
| Grid state persistence (`localStorage`) | ✅ `persistence.ts` | ✅ shared Web/Electron | 🟡 | Page size, sort, filters, visibility, pinning, order, and both scroll axes are restored by stable result identity; the shared React state still needs schema-version migration. |

### D3 deep-dive — current web grid and remaining backlog

Key architecture fact: **VS Code desktop is a DOM grid with a Node host**; Web and
Electron use the same React/TanStack grid over an async REST/WS spool. Full-result
aggregation and grouping already execute against the API SQLite spool; client features
operate on the loaded page. Public request/response types remain additive and the
Web/Electron renderer is shared without forcing the VS Code webview onto React.

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

### Architecture decision (updated 2026-09-12)

**One renderer across VS Code + Web + Electron remains out of scope; Web and Electron
share one renderer.**

- VS Code grid (`media/resultPanel`) is vanilla-DOM + disk-backed, wired to the VS Code host
  (`protocol.ts`); Web/Electron use a React/TanStack renderer with an async REST/WS spool.
- Web and Electron consume the same `@justybase/ui-react` `DataGrid` and shared view,
  clipboard, context-action, and viewport contracts. This gives the two application shells
  identical behavior while preserving the low-risk VS Code renderer boundary.
- If pure logic sharing is ever wanted, extract it into a framework-agnostic
  `@justybase/grid-core` (formatting, aggregation math, clipboard generators, pivot/group SQL,
  edit-UPDATE builder) — additive, web-first, desktop adopts later. This remains a **follow-up
  opportunity**, not a prerequisite for Web/Electron parity.

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
| Generate DDL (`createDDL`, `goToCatalogDdl`) | ✅ provider-specific | 🟡 exact Netezza + reconstructed local table/view | 🟡 | M | Netezza table/view/procedure/external-table/synonym paths preserve native catalog fidelity; SQLite/DuckDB table/view DDL is explicitly marked reconstructed. Remote authoring-only profiles do not receive fabricated DDL. |
| Copy DDL | ✅ | ✅ | ✅ | – | Available from the schema object menu. |
| View/Edit data (50k editor) | ✅ | ✅ guarded row edit | 🟡 | M | Web edit requires eligible source metadata, preview token, explicit confirmation, ownership, and non-read-only profile. |
| Import CSV/XLSX (smart paste, wizard) | ✅ | ✅ guarded file import | 🟡 | L | Web supports preview-token-confirmed CSV/XLSX, null/Unicode/duplicate-header handling, compressed CSV, bounded rows and rollback; desktop wizard and format depth remain broader. |
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
| Oracle / PostgreSQL / Vertica / Snowflake / Db2 / MSSQL / MySQL / ClickHouse / Access | ✅ (extensions) | 🟡 authoring-only | 🟡 |

The shared connection contract and forms expose every supported `DatabaseKind`.
Profiles retain the selected dialect, so Monaco completion, snippets, diagnostics,
signature help, formatting and semantic authoring use the selected profile. The API
runtime registry currently executes Netezza, SQLite and DuckDB; remote profiles are
clearly labelled authoring-only and keep save/test/run/schema/DDL controls disabled
until an explicit server-side driver/runtime adapter, metadata provider, capability
declarations and live contract are added.

SQLite and DuckDB are already available in the web API for local profiles,
metadata, query sessions, paging, aggregation and grouping. The remaining work
is parity polish (file-SQL workflows, capability-specific runtime gates, and
controlled remote runtime adapters). Add remote execution only with explicit
runtime isolation and integration coverage.

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
| 3 | Linter (NZ/NZP) + code actions into web | 🟡 diagnostics + deterministic quick fixes | core | M — desktop refactors and context-sensitive actions remain |
| 4 | Format SQL (real formatter) | ✅ | core | ✅ done (2026-08-09) |
| 5 | Snippets + semantic tokens | ✅ | core | ✅ done (2026-08-09) |
| 6 | Selected/cursor/smart/script run modes | ✅ | core+api+web | done |
| 7 | Aggregations + grouping + row virtualization | ✅ | grid+api | done |
| 8 | Grid context menu + row detail | ✅ broad | grid | 🟡 desktop-only actions remain |
| 9 | Alternate views | 🟡 basic pivot | grid | M for richer UX/cards |
| 10 | Guarded DML/DDL execution + confirm/audit | ✅ | api+web | done; guided DBA actions remain |
| 11 | Import/export | 🟡 guarded CSV/XLSX + compressed CSV flow | api+web | L for desktop wizard/format depth |
| 12 | Multi-dialect authoring/runtime | 🟡 authoring catalog + local runtimes | api+web | remote dialect runtimes remain |

---

## Recommended backlog order

1. **Quality foundation:** add React component coverage, version and test
   persisted tab/grid state, and enforce the high-risk gates in the project
   quality roadmap.
2. **Editor completion:** expose the remaining context-sensitive NZ/NZP quick fixes
   and parser-backed refactors through the web LSP/code-action surface.
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
desktop is unaffected by web-only code. The shared Netezza package is platform-neutral;
desktop and API adapters are separate composition layers, so the remaining risk is
contract/parity drift rather than a hidden desktop import in the web build.

### Risk tiers per backlog area

| Area | Touches desktop `src/`? | Risk | Why / mitigation |
| --- | --- | --- | --- |
| **D1 wiring** (hover, definition, references, rename, inlay, signature, symbols, format) | **No** | 🟢 Low | Pure parser/authoring helpers, including table/alias context and formatting, live in `@justybase/sql-core`; metadata, LSP DTOs and transport state live in `apps/api/src/sqlCoreLsp.ts`, while the desktop adapter remains local. Completion cache/invalidation has API tests; Extension Host evidence remains required before release. |
| **D1 leftovers** (semantic tokens, snippets, statement window) | **No** (one pure-extraction) | 🟢 Low | Semantic tokens reuse the existing lexer + `parseSemanticScopeWithParser` + `identifierRoleCollector`; the token-name sets were **moved** (not copied) to vscode-free `src/sql/semanticTokenNames.ts`, and the desktop provider now imports from there — behavior-identical, verified by `semanticTokensProvider.test.ts` (43 tests). The API adapter exposes the same transport operations from `apps/api/src/sqlCoreLsp.ts`. Snippets reuse the committed `.code-snippets` JSON; statement window uses the shared statement splitter. **Shipped 2026-08-09.** |
| **NZ/NZP linter & NZ quick-fixes** | **Yes** (done for diag) | 🟢 Low–Med | `QualityEngineCore` is in `@justybase/sql-core`, with `src/sqlParser/qualityEngineCore.ts` as a thin desktop adapter. Desktop and API diagnostics preserve parser-owned fixes and NZ/NZP mappings. Remaining code-action providers (`linterCodeActions.ts`, `sqlRefactorCodeActions.ts`) remain product-specific. |
| **Formatting** | One-line import | 🟢 Low | Netezza formatting is owned by `formatNetezzaSql` in sql-core and called by the desktop facade and API adapter. Other dialect profiles still use the desktop formatter until their own migrations. |
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
