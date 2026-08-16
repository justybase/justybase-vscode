# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Project Overview

Monorepo for the JustyBase SQL Editor: a VS Code extension for IBM Netezza / PureData System for Analytics, optional database companion extensions, and a self-hosted web editor/API. Database support includes Netezza, SQLite, Db2, Oracle, PostgreSQL, Snowflake, MSSQL, MySQL, DuckDB/File SQL, Microsoft Access, and Vertica.

**External dependencies:**

- `@justybase/netezza-driver` (published npm package)
- `@justybase/spreadsheet-tasks` (published npm package)

## Repository Layout

- `src/` — core VS Code extension, Netezza SQL/LSP implementation, metadata cache, MCP server, providers, and services.
- `media/` — VS Code webviews and React-based panels. These are bundled by the root esbuild configuration.
- `dialects/` — TextMate grammars and snippets for the supported SQL dialects.
- `extensions/*/` — optional VS Code companion extensions. Each extension depends on the core extension and is built/package separately.
- `packages/contracts/` — shared public TypeScript contracts used by desktop, web, API, and companion extensions.
- `packages/sql-core/` — VS Code-free SQL/LSP surface shared with the web API. Do not introduce a `vscode` import here.
- `packages/database-runtime/` — shared database execution/runtime helpers used by the web API and other platform-neutral consumers.
- `packages/access-file/` — standalone MDB/ACCDB reader and Access file-session package.
- `apps/api/` — self-hosted Fastify API and WebSocket server.
- `apps/web/` — React/Vite self-hosted web editor.
- `Benchmark/` — local performance suites; generated result files are ignored.
- `test-harness/` — Playwright and browser harnesses for webviews and the web SQL workspace.

The root `package.json` uses npm workspaces for `packages/*` and `apps/*`. The root API build handles the `contracts -> sql-core -> database-runtime -> api` dependency chain; build `@justybase/access-file` separately when working on that package. Use the root scripts rather than committing generated `dist/` output.

### Toolchain and Local Setup

- Node.js `>=22.12.0` and npm are required by the root and web/API manifests.
- The desktop extension targets VS Code `^1.103.2`.
- Run `npm install` from the repository root so workspace links and shared tooling resolve consistently.
- Use `apps/api/.env.example` as the starting point for local API configuration. Keep `.env` files, database credentials, and generated runtime data out of commits.
- Optional extensions may require additional native/runtime dependencies; follow the README and verification script for the extension being changed.

## Build, Lint, Test Commands

### Build

```bash
npm run build              # Desktop extension, webviews, LSP, workers, and MCP bundles
npm run build:dev          # Same as build; retained for development workflows
npm run build:watch        # Watch all root esbuild entry points
npm run build:minified     # Opt-in minified desktop bundles
npm run build:api          # contracts -> sql-core -> database-runtime -> web API
npm run build:web          # Vite build for apps/web
npm run build:all          # API and web builds
npm run clean              # Remove root dist/
```

The root build emits `dist/extension.js`, `dist/media/*`, `dist/server/main.js`, `dist/metadataDiskCompress.worker.js`, and `dist/mcp/mcpServer.js`. It also rebuilds the TanStack table/virtual webview globals in `media/`.

### Lint and Type Check

```bash
npm run lint               # ESLint check
npm run lint:fix           # ESLint with auto-fix
npm run check-types        # TypeScript type check (no emit)
```

### Test Commands

```bash
npm run test                                            # Root unit tests under src/__tests__
npm run test:fast                                       # Faster root Jest config
npm run test:serial                                     # Root tests with one worker
npm run test:validate                                   # Root validation Jest config
npm run test:parser                                     # Parser/linter/completion-focused tests
npm run test -- --testPathPatterns="sqlParser.test.ts" # Single test file
npm run test -- --testNamePattern="ConnectionManager"  # Tests by name pattern
npx jest src/__tests__/sqlParser/sqlParser.test.ts --runInBand  # Direct Jest
npm run test:watch                                      # Watch mode
npm run test:completion-parity                          # Completion parity tests
npm run test:quickfix-regression                        # Quickfix regression tests
npm run test:api                                        # Build shared packages and test apps/api
npm run test:web                                        # Test apps/web
npm run test:playwright                                 # Browser/webview harness
```

Root Jest uses up to 50% of available workers by default; use `test:serial` or `--runInBand` for low-memory/parser work. Live database suites are excluded from the default root test command by `scripts/jestLiveDbIgnorePatterns.cjs`.

### Benchmark Commands (local performance baselines)

```bash
npm run benchmark:lsp                                   # LSP completion/hover/inlay/diagnostics
npm run benchmark                                       # All benchmarks (suggest + lsp + result-panel)
LSP_BENCHMARK_ENFORCE=1 npm run benchmark:lsp           # Fail when latency budgets are exceeded
```

Results are written locally to `Benchmark/lspFeature.results.md` and `Benchmark/results.md` (gitignored — never commit benchmark timing artifacts).

### Integration and Optional Extension Checks

```bash
npm run test:metadata-cache:integration  # Local disk-restart/cache contract test
npm run test:duckdb:integration
npm run test:file:integration
npm run test:access:integration
npm run test:db2:integration
npm run test:oracle:integration
npm run test:mssql:integration
npm run test:postgres:integration
npm run test:snowflake:integration

npm run verify:access
npm run verify:db2
npm run verify:duckdb
npm run verify:oracle
npm run verify:postgresql
npm run verify:vertica
npm run verify:snowflake
npm run verify:mssql
npm run verify:mysql
```

The database-backed suites require the corresponding environment variables and/or a running database. Do not add credentials to the repository. Optional extension tasks are dispatched through `scripts/run-optional-extension-task.js`.

### Parser Performance Guardrails

Parser construction (`createSqlParserInstance`, including Chevrotain self-analysis) is a
critical latency path. Keep cold construction below the hard `< 2000 ms` budget:

- MSSQL: `< 2000 ms` (`src/__tests__/sqlParser/mssqlParserPerf.test.ts`)
- Oracle: `< 2000 ms` (`src/__tests__/sqlParser/oracleParserPerf.test.ts`)

When changing a dialect parser:

- add a focused syntax regression test for every newly accepted keyword or block form;
- run the dialect construction-performance test and inspect
  `JUSTYBASE_PARSER_PERF=1` output when the budget changes;
- do not add the same token type to both `commandTailToken` and a dialect token list;
  Chevrotain will report ambiguous alternatives and self-analysis can become very slow;
- keep thin `BEGIN … END` rules acyclic and use the smallest dialect-specific keyword
  list needed by the block grammar. Do not replace them with broad recursive token ORs.

Parser-focused validation:

```bash
NODE_ENV=test npx jest src/__tests__/sqlParser --runInBand --no-cache
npm run check-types && npm run lint && npm run build
```

### Full Validation (before commits)

```bash
npm run check-types && npm run lint && npm run build && npm run test:validate
npm run build:all && npm run check-types:api && npm run check-types:web && npm run test:api && npm run test:web
```

`check-types` includes webview media TypeScript (`tsconfig.media.json` with `strictNullChecks` and `noImplicitAny`). New code under `media/` must pass `npm run check-types:media` (alias: `check-types:media:strict`).

### Result Panel webview layout

`media/resultPanel/grid.ts` and `media/resultPanel/selection.ts` are thin esbuild entry facades. Implementation lives in subfolders:

| Area | Path | Role |
|------|------|------|
| Grid facade | `media/resultPanel/grid.ts` | Re-exports; `scrollToColumn` |
| Grid modules | `media/resultPanel/grid/*` | `sizing`, `columns`, `aggregation`, `alternateViews`, `orchestration`, `persistence`, `tableBuilder`, `types` |
| Selection facade | `media/resultPanel/selection.ts` | `setupCellSelectionEvents` orchestrator |
| Selection modules | `media/resultPanel/selection/*` | `clipboard`, `contextMenu`, `interaction` |
| Banners | `media/resultPanel/banners.ts` | `updateResultLimitBanner` (leaf — no `tabs`/`messages` imports) |

Grid state persistence (`saveAllGridStates`, `SavedGridState`) is in `grid/persistence.ts` — not `messages.ts`. Result/limit banners live in `banners.ts`. Avoid reintroducing `grid` ↔ `messages` or `messages` ↔ `tabs` import cycles.

### Optional Database Extensions

```bash
npm run verify:access       # Microsoft Access
npm run verify:db2          # Db2
npm run verify:duckdb       # DuckDB + Files
npm run verify:oracle       # Oracle
npm run verify:postgresql   # PostgreSQL
npm run verify:snowflake    # Snowflake
npm run verify:mssql        # Microsoft SQL Server
npm run verify:mysql        # MySQL
npm run verify:vertica      # Vertica
```

### Packaging

```bash
npm run vscode:prepublish  # Clean, build, and generate third-party notices
npm run package            # Build VSIX
npm run package:pre        # Build + package
npm run package:access     # Package one optional extension
npm run package:db2        # Package Db2 (runtime-specific)
```

Optional extensions expose corresponding `package:<dialect>` and `package:<dialect>:full` scripts. Use `npm run version:check` / `version:set` / `version:bump` for repository version synchronization; never use `npm version`.

## Architecture

### Build System

- Extension uses **esbuild** for bundling (not tsc) - output goes to `dist/`
- Root bundles include `dist/extension.js`, `dist/media/*`, `dist/server/main.js`, `dist/metadataDiskCompress.worker.js`, and `dist/mcp/mcpServer.js`.
- `apps/api` and the workspace packages use TypeScript builds into their own `dist/` directories; `apps/web` uses Vite.
- Root TypeScript `out/` is not used for desktop runtime.

### Shared Workspace Boundaries

- `@justybase/contracts` is the additive contract boundary. Keep new request/response fields compatible with desktop and web consumers.
- `@justybase/sql-core` must remain independent of VS Code. It is consumed by `apps/api`; importing `vscode` or desktop-only providers here breaks the web build.
- `@justybase/database-runtime` owns reusable execution and read-only safety helpers. Keep web/API execution logic here when it is not platform-specific.
- `apps/api` is a multi-user/self-hosted server. Keep credentials and secrets in its environment/configuration, never in source or fixtures.
- `src/mcp/` contains the bundled read-only Netezza MCP server. Preserve the read-only gate for both stdio and HTTP transports.

### Critical Patterns

- **ConnectionManager**: Stores credentials in VS Code secrets API (service: 'netezza-vscode-connections')
- **StreamingManager**: Singleton in `src/core/queryCancellation.ts` handles all query execution/cancellation
- **Logger**: Singleton - initialize once with `Logger.initialize()` during activation
- **URI normalization**: Use `normalizeUriKey` from `src/core/queryRunnerUtils.ts` for Windows compatibility
- **Thenable API**: VS Code's `Thenable` doesn't have `.catch()` - use `.then(undefined, handler)`
- **Metadata disk storage**: Disk serialization/compression lives under `src/metadata/diskStorage/`; compression runs in `metadataDiskCompress.worker.ts` and is bundled separately.

### Activation Flow

- `src/extension.ts` is the composition root
- Deferred features in `src/activation/deferredFeatureRegistration.ts` load after activation
- Deferred init is skipped when `NODE_ENV=test`

### Dialect Registry

- `src/core/connectionFactory.ts` is the shared access point for connections
- Database-specific behavior uses `DatabaseDialect` contracts in `src/contracts/database/*`
- Do NOT add Netezza-only assumptions in shared providers

### Metadata and SQL Features

- `src/metadataCache.ts` is the shared metadata cache
- Parser scope helpers in `src/providers/parsers/parserSqlContext.ts` reused across features
- SQL validation uses Chevrotain lexer/parser in `src/dialects/netezza/sql/`

### SQL Parsing, Validation, and LSP (end-to-end)

**Layers (bottom to top):**

1. **TextMate** — `dialects/netezza/syntaxes/netezza.tmLanguage.json` (baseline highlighting; semantic tokens override where emitted)
2. **Chevrotain** — `src/dialects/netezza/sql/lexer.ts`, `src/sqlParser/BaseSqlParser.ts`, `src/dialects/netezza/sql/parser.ts`, `src/sqlParser/parsingRuntime.ts`
3. **Semantic** — `parserSqlContext.ts` (alias/CTE scope), `identifierRoleCollector.ts` (CST role map), `semanticTokensProvider.ts`

**Key files:**

| Area | Files |
|------|-------|
| Lexer / parser | `lexer.ts`, `parser.ts`, `BaseSqlParser.ts`, `parsingRuntime.ts` |
| Validator | `src/sqlParser/validator.ts`, `src/sqlParser/visitor/sqlVisitor.ts` |
| Type comparison | `src/sqlParser/visitor/typeComparisonUtils.ts` (SQL025/SQL026) |
| Completion | `src/server/completionEngine.ts`, `completionContextExtractor.ts`, `completionQualifierResolver.ts` |
| Linter / Problems | `src/providers/sqlLinterProvider.ts`, `src/providers/sqlQualityEngine.ts` |
| LSP diagnostics | `src/server/main.ts`, `src/server/lspSchemaProvider.ts`, `src/server/metadataBridge.ts` |
| Schema for validation | `src/sqlParser/metadataCacheAdapter.ts`, `src/sqlParser/schemaProvider.ts` |

**Two validation paths (both must preserve column `dataType`):**

- **Extension host linter** — `getInitializedSqlValidator()` → `MetadataCacheSchemaProvider` (reads `metadataCache`; maps `FORMAT_TYPE` → `ColumnInfo.dataType`)
- **LSP server** — `LspSchemaProvider` (reads `metadataBridge` cache; maps `MetadataColumnItem.type` → `ColumnInfo.dataType`)

Type-aware warnings **require** metadata with types. Without connection/cache, SQL003/004/007 still work; SQL025/SQL026 do not.

### NZPLSQL (Chevrotain-first)

**Layers:**

1. **Chevrotain** — `parser.ts` (`procedureStatement`, `createProcedureStatement`, string-body `StringLiteral`) + `sqlVisitor.ts` (`inProcedureContext`, `ProcedureScopeBuilder`)
2. **CST procedure semantics** — `src/sqlParser/procedure/procedureScopeBuilder.ts` emits **SQL037–SQL040** (SELECT without INTO, missing RETURN, unused variables, unassigned OUT/INOUT)
3. **String-body** — `procedureStringBody.ts` re-parses `AS '…'` bodies with offset mapping
4. **Regex NZP** — `procedureRules.ts` calls `shouldUseProcedureRegexFallback()` from `procedureAnalysis.ts`; migrated rules (NZP004/005/006/008/011/013/017/022/024) run only when parse fails

**Note:** SQL030 is reserved for grouped-query ORDER BY warnings; procedure codes use SQL037+.

### Netezza Parser: Keywords as Identifiers

`NetezzaSqlParser` overrides shared ANSI-safe rules via `OVERRIDE_RULE`:

- **`identifier`** — broad keyword allowance (object names)
- **`alias` / `columnReference`** — narrow subset via shared rule **`netezzaRelaxedName`** (`getNetezzaRelaxedNameTokens()`)

**Important:** `columnReference` qualified names use `SUBRULE(netezzaRelaxedName)` — do **not** duplicate `CONSUME` for the same token in one rule (Chevrotain rejects duplicate `CONSUME`). Reuse `netezzaRelaxedName` for OR/OR1/OR2 positions.

When reading tokens from `columnReference` CST nodes, use **recursive** collection (walk nested `netezzaRelaxedName` children), not only direct `Identifier` children. Same pattern in:

- `identifierRoleCollector.ts` — `collectOrderedReferenceTokens`
- `parserSqlContext.ts` — `extractColumnFromExpression`, CTAS column inference
- `sqlVisitor.ts` / `symbols.ts` — `getOrderedReferenceTokens`

### Semantic Coloring (`identifierRoleCollector`)

- Strict parse required (`actionableParserErrors.length === 0`); parse failure → empty role map
- **Single parse:** `collectIdentifierOccurrences` uses `parseSemanticScopeWithParser().cst` (no second `parseCst`)
- DDL handlers: `dropStatement` → `visitChildren` + `dropTarget` → `qualifiedName`; `alterTableStatement`, `callStatement`, `createSequenceStatement` → `visitQualifiedTableDdl`
- `mergeStatement` override in Netezza parser exposes `tableName` for coloring

Tests: `identifierRoleCollector.test.ts`, `semanticTokensProvider.test.ts`

### Completion: Qualifier Paths

`extractQualifierColumnContext()` in `completionContextExtractor.ts` handles:

- `alias.` (trailing dot)
- `alias.partial` (e.g. `X.DATE_` — columns only, **no** functions/keywords)

When qualifier path is active, `completionQualifierResolver` returns filtered column items; do not fall through to `getSemanticScopeCompletions` (which mixes all aliases + functions).

Tests: `completionEngine.test.ts` (`X.|`, `X.ACC|` partial prefix)

### Type-Aware Comparison Warnings (SQL025 / SQL026)

Implemented in `sqlVisitor.validateComparisonExpressionTypes()` for `column = literal` (and ordered operators).

| Code | Condition | Severity |
|------|-----------|----------|
| **SQL025** | numeric column ↔ string literal, or text column ↔ numeric with `=` / `!=` | warning |
| **SQL026** | text column ↔ numeric with ordered operator (`>`, `<`, `>=`, `<=`) | warning |

Classification: `typeComparisonUtils.ts` (`classifyNetezzaDataType`, `classifyLiteralToken`).

**Metadata requirements:** `ColumnInfo.dataType` from `FORMAT_TYPE` (cache) or mock schema `{ name, dataType }`. `resolveColumnDataType` prefers `schemaProvider.getTable()` over in-scope column list.

Tests: `validator.test.ts`, `typeComparisonUtils.test.ts`, `lspSchemaProvider.test.ts`, `metadataCacheAdapter.test.ts`

### TextMate Grammar Notes

- **Comment/string exclusion** — use `injectionSelector` only (`L:source.sql - (string.quoted | comment…)`). Do **not** add per-rule line lookbehinds such as `(?m)(?<!^\s*--[^\n]*)` or variable-length CREATE/TABLE lookbehinds; they are O(n²) on long lines. Guard: `src/__tests__/syntax/tmLanguageLookbehindGuard.test.ts`
- **P16** — `DB.SCHEMA.TABLE` after table-like keywords via **`begin`/`end`** (not a `\s+` lookbehind); `beginCaptures` must preserve the base SQL scope of the consumed keyword — split into a DML rule (`FROM|JOIN|UPDATE` → `keyword.other.DML.sql`, matching microsoft/vscode `sql.tmLanguage.json`) and a DDL rule (`INTO|TABLE|VIEW|DROP|ALTER|TRUNCATE|GROOM` → `keyword.other.sql`); segment 2 uses `constant.other.schema-name.sql`
- **P17b** — `SCHEMA.TABLE` after `FROM`/`JOIN` via **`begin`/`end`** (not a `\s+` lookbehind); `beginCaptures` must preserve the base SQL scope of the consumed keyword (→ `keyword.other.DML.sql`); segment 1 = schema scope
- Lookbehinds, if unavoidable, must use bounded whitespace (`\s{1,16}`), never `\s+` / `\s*`
- Token colors in `package.json` `configurationDefaults` use **`[*Light*]`** and **`[*Dark*]`** theme selectors for both `editor.semanticTokenColorCustomizations` and `editor.tokenColorCustomizations` (do not use Dark+ hex globally)

### Live Netezza (optional)

For ambiguous syntax or implicit-cast behavior, a dev Netezza instance can confirm runtime acceptance vs linter warnings. Do **not** hardcode credentials in the repo; use env vars (`NZ_DEV_PASSWORD`, etc.) as in `linterLiveValidation.test.ts`.

## Code Style

### ESLint Rules

- `@typescript-eslint/no-explicit-any`: **error** (unusual - most projects use warn)
- `@typescript-eslint/no-unused-vars`: warn with `argsIgnorePattern: '^_'`
- `prefer-const`: warn
- `no-console`: error in specific files (batchQueryExecutor, connectionManager, etc.)

### TypeScript

- **TypeScript 6+** required (`typescript` in root `package.json`; use `"typescript.tsdk": "node_modules/typescript/lib"` in `.vscode/settings.json` so the IDE and ESLint match the project compiler)
- `strict: true` with `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- `moduleResolution: bundler` with `module: commonjs` (root); extensions inherit via `extends` — no deprecated `baseUrl`
- Explicit `types: ["jest", "node"]` in root `tsconfig.json` (TS 6 default is `[]`)
- Target: ES2020
- Path aliases: `@core/*`, `@metadata/*`, `@types/*` (defined in tsconfig.json)

### Imports

- Use path aliases: `import { Foo } from '@core/foo'`
- Group imports: external packages first, then internal modules
- Use `import * as vscode from 'vscode'` for VS Code API

### Naming Conventions

- PascalCase for types, interfaces, classes
- camelCase for functions, variables, methods
- UPPER_SNAKE_CASE for constants
- Prefix unused parameters with underscore: `_context`

### Error Handling

- Use typed errors where possible
- Prefer `Error` objects over string throws
- Log errors with context using Logger

### Comments

- Use JSDoc for public APIs
- Comment complex algorithms and business logic
- Avoid obvious/redundant comments

### Commit Messages

- Use **Conventional Commits** format: `type(scope): description`
- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`
- **NEVER** use generic messages like `fix`, `checkpoint`, `WIP`, `tmp`
- Always describe **what** was changed and **why**
- Keep first line under 72 characters
- Examples:
  - ✅ `fix(release): add contracts package to version sync workflow`
  - ✅ `feat(dialect): add MariaDB connection support`
  - ❌ `fix` or `checkpoint` or `tmp changes`

## Testing

### Test Structure

- Root extension tests: `src/__tests__/**/*.test.ts`
- Shared contract tests: `packages/contracts/__tests__/**/*.test.ts`
- API tests: `apps/api/tests/**/*.test.ts`
- Web tests: `apps/web/src/**/*.test.ts`
- Browser/webview tests: `test-harness/tests/**/*.spec.ts`
- VS Code mock: `src/__tests__/__mocks__/vscode.ts`
- Root Jest uses `maxWorkers: 50%` by default; use `npm run test:serial` or `--runInBand` to reduce memory usage.
- Timeout: 60s

### Integration Tests

- Database-backed integration tests are excluded from default `npm run test`.
- Run with `npm run test:duckdb:integration`, `npm run test:file:integration`, `npm run test:access:integration`, `npm run test:db2:integration`, `npm run test:oracle:integration`, `npm run test:mssql:integration`, `npm run test:postgres:integration`, or `npm run test:snowflake:integration` as appropriate.
- `npm run test:metadata-cache:integration` is a local disk-restart/cache contract test and does not require a live database.
- Playwright requires browser dependencies; install them with `npm run test:playwright:install` when needed.

### Parser / Linter Focused Tests

```bash
npm run test -- --testPathPatterns="identifierRoleCollector|semanticTokensProvider|completionEngine|validator.test|typeComparisonUtils|lspSchemaProvider|metadataCacheAdapter"
npm run test:metadata-cache:integration  # disk restart + SchemaProvider column expand (no live DB)
```

Metadata cache contract (layers, disk, views catalog, column load paths): `docs/METADATA_CACHE_CONTRACT.md`

Tests that need the real Chevrotain parser: `jest.unmock('chevrotain')` at top of file (see `identifierRoleCollector.test.ts`, `lspSchemaProvider.test.ts`).

## Key Conventions

### Parser Changes

When modifying SQL syntax, update ALL of:

- `src/dialects/netezza/sql/lexer.ts`
- `src/dialects/netezza/sql/parser.ts`
- `src/sqlParser/visitor/sqlVisitor.ts`
- `src/dialects/netezza/sql/builtins.ts`
- `dialects/netezza/syntaxes/netezza.tmLanguage.json`
- `dialects/netezza/snippets/netezza.code-snippets`

If adding keyword tokens usable as column/alias names, extend `getNetezzaRelaxedNameTokens()` and ensure `netezzaRelaxedName` rule stays the single `CONSUME` site per token.

### Validator / Linter Changes

When adding or changing diagnostic codes:

- Implement checks in `sqlVisitor.ts` (CST walk) or `validator.ts` (pre/post-parse)
- Surface through `SqlQualityEngine` (maps `ValidationError` → `LintIssue` with `ruleId` = code)
- Add tests in `src/__tests__/sqlParser/validator.test.ts` and/or `sqlValidator.test.ts`
- If code depends on column types, verify **both** `MetadataCacheSchemaProvider` and `LspSchemaProvider` pass `dataType` through

### SQL Authoring

- Use parser-based logic via `src/providers/parsers/parserSqlContext.ts`
- Do NOT add ad-hoc regex-only completion or scope logic

### Metadata Cache

- Table-like objects (`TABLE`, `VIEW`, `NICKNAME`, `ALIAS`) share cache state
- When refreshing, merge new objects instead of replacing entire cache entry

### Netezza Notation

- `DB..TABLE` notation is first-class - preserve it in all changes
- Support formats: `TABLE`, `SCHEMA.TABLE`, `DB.SCHEMA.TABLE`, `DB..TABLE`

### Version Management

- **NEVER use `npm version` locally** - versions managed by GitHub Actions
- Use `node scripts/version-sync.js check` for version sync

## Copilot Integration

- Features wired from `src/activation/copilotRegistration.ts`
- Tool definitions must stay aligned across `package.json`, `src/services/copilotTools/*`, and `src/contracts/copilotTools/contracts.ts`

## Release Process

See `docs/RELEASE_PROCESS.md`. GitHub → Actions → Release → Run workflow.
