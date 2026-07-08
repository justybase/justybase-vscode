# Editor Capability Matrix

Last updated: 2026-06-29

This document tracks the SQL editor surface from a user-facing perspective. It complements `docs/LSP_FEATURE_MATRIX.md`, which remains the implementation- and transport-oriented reference.

## Status Legend

| Status         | Meaning                                                                             |
| -------------- | ----------------------------------------------------------------------------------- |
| First-class    | Parser- or metadata-backed behavior with deterministic results in the current stack |
| Fallback-only  | Working behavior, but still heuristic or split across transports                    |
| Extension-host | Supported outside the language server and not yet migrated                          |
| Gap            | No provider is currently wired                                                      |

## Quality Classification

| Quality           | Description                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Parser-aware**  | Implementation uses the Chevrotain SQL parser for symbol resolution, scope tracking, or syntax analysis. Results are deterministic and test-backed with direct parser tests. |
| **Hybrid**        | Implementation combines parser-based logic with metadata lookups or context heuristics. Core behavior is parser-driven but some edge cases may fall back to heuristics.      |
| **Fallback-only** | Implementation relies on regex, token patterns, or best-effort matching without parser support. Works for common cases but may produce incorrect results on complex SQL.     |

## Core Editor Surface

| Capability               | Status         | Quality       | Primary path   | Notes                                                                                                             |
| ------------------------ | -------------- | ------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Completion               | First-class    | Hybrid        | LSP            | Parser-based scope, local-definition resolution, wildcard expansion, and metadata lookup.                         |
| Diagnostics              | First-class    | Parser-aware  | LSP + Extension host | LSP publishes SQL/PAR; extension linter publishes NZ/NZP only when LSP is active (full fallback when LSP is off). |
| Go to Definition         | First-class    | Parser-aware  | LSP            | Parser-backed symbol resolution.                                                                                  |
| References               | First-class    | Parser-aware  | LSP            | Shared symbol collector with language-server routing.                                                             |
| Rename                   | First-class    | Parser-aware  | LSP            | Quote-aware rename replacements and parser-backed occurrence collection.                                          |
| Inlay Hints              | First-class    | Hybrid        | LSP            | Server-side column/type hint generation (parser resolves, metadata provides types).                               |
| Hover                    | First-class    | Hybrid        | LSP            | LSP hover owns production requests with explicit budgets; extension-host hover remains test-only as a local fallback. |
| Signature Help           | First-class    | Hybrid        | LSP            | Server-side function signature lookups with parser-adjacent call detection. Extension-host retained for test-only fallback. |
| Code Actions (linter)    | First-class    | Hybrid        | LSP + Extension host | Parser-backed fixes migrated to LSP (SQL/PAR codes). NZ/NZP codes remain on extension host. Shared `buildSafeFixEdit` helper eliminates duplication. |
| Code Actions (refactors) | First-class    | Parser-aware  | Extension host | `analyzeSqlQueryStructures` provides parser-backed candidates: Extract Subquery as CTE, Materialize CTE, Inline Temp Table. |
| Document Symbols         | Extension-host | Parser-aware  | Extension host | Stable, but not yet server-backed.                                                                                |
| Folding Ranges           | Extension-host | Fallback-only | Extension host | Regex-based region folding (--REGION/--ENDREGION). Low priority for migration.                                    |
| CodeLens                 | Extension-host | Hybrid        | Extension host | Depends on extension-host connection state.                                                                       |
| SQL Console              | First-class    | Hybrid        | Extension host | Ephemeral SQL editor pinned to a connection/database, available from the schema view and query history aware.      |
| Semantic Tokens          | First-class    | Parser-aware  | Extension host | Lexer-backed token classification via `SqlLexer.tokenize()`. Identifier lookup from `builtins.ts`, `dataTypes.ts`, and `allTokens` keyword types. |
| Formatting               | First-class    | Hybrid        | Extension host | Extension-host provider delegating to `formatSql()`. Dialect-aware via `DatabaseSqlFormatterProfile`. Standard Format Document / Range. |

## Critical Completion Contexts

| Context                                                                                   | Current state                      | Notes                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Object targets (`INSERT INTO`, `CALL`, `EXECUTE`, `EXEC`, `UPDATE`, `DROP`, `CREATE`)     | First-class                        | Backed by `completionContextExtractor` object-target parsing plus completion-engine integration coverage.                                                                      |
| Multi-part object paths (`DB.SCHEMA.TABLE`, `DB..TABLE`, dialect-specific two-part names) | First-class                        | Dialect-aware path parsing and completion branches are in place across Netezza, PostgreSQL, DB2, MSSQL, SQLite, and companion dialects.                                        |
| Alias member completion                                                                   | First-class                        | Shared parser scope extraction feeds both completion and symbol/navigation features.                                                                                           |
| CTE local definitions and visible-scope filtering                                         | First-class                        | Shared parser helpers now have direct tests for sibling visibility and final-statement scope.                                                                                  |
| Nested subquery scope isolation                                                           | First-class                        | Direct parser tests cover inner/outer alias isolation in addition to completion-engine integration coverage.                                                                   |
| Quoted identifiers                                                                        | First-class with one grammar limit | Quoted schema/table paths, quoted aliases, and quoted projected columns are covered. Quoted CTE names are still grammar-limited and are not part of the supported surface yet. |
| Procedure target paths                                                                    | First-class                        | `CALL`, `EXECUTE`, and `EXEC` target parsing now has direct helper-level coverage in addition to integration coverage.                                                         |

## Parser-Aware vs Hybrid vs Fallback Classification

### Fully Parser-Aware (First-Class)

These features use the Chevrotain SQL parser for deterministic, test-backed behavior:

1. **CTE definition and reference resolution** - `SqlSymbolCollector` tracks CTE definitions and all references across scopes (tests: `symbols.test.ts` lines 132-188)
2. **Table alias scope tracking** - Including MERGE target/source aliases (tests: `symbols.test.ts` lines 24-65, 167-187)
3. **Nested subquery scope isolation** - Each nested level has isolated alias scope (tests: `symbols.test.ts` lines 190-241)
4. **DB..TABLE Netezza notation** - Parser recognizes double-dot syntax (tests: `symbols.test.ts` lines 99-129)
5. **Wildcard column propagation** - Through CTEs and CTAS (tests: `completionEngine.test.ts` lines 1293-1440)
6. **Created table tracking** - CREATE TABLE -> SELECT -> DROP chain (tests: `symbols.test.ts` lines 99-129)
7. **Quoted identifier handling** - Parser normalizes quoted identifiers (tests: `symbols.test.ts` lines 67-97)
8. **UPDATE/DELETE alias scope** - Parser tracks alias definitions in DML (tests: `symbols.test.ts` lines 284-319)
9. **Semantic token classification** - Lexer-backed via `SqlLexer.tokenize()` with keyword token type names, identifier lookup against `builtins.ts`, `dataTypes.ts`, and `system columns`.
10. **Lexer-based code action fixes** - `createRemoveUnusedCteFix` uses `SqlLexer.tokenize()` for CTE boundary detection. `createSubqueryAliasFix` uses lexer for paren matching. Shared `buildSafeFixEdit` for deterministic SQL/PAR rewrites.

### Hybrid (Parser + Metadata)

These features use parser for symbol resolution but require metadata for full functionality:

1. **Qualified column completion** - Parser resolves alias -> table, metadata provides columns
2. **Unqualified column disambiguation** - Parser provides scope, metadata provides candidates
3. **Hover information** - Parser resolves symbol, metadata provides description
4. **Inlay type hints** - Parser resolves alias, metadata provides column types

### Fallback-Only (Needs Improvement)

These features lack parser support and rely on heuristics:

1. **Keyword completion** - Static keyword list, no syntax-aware filtering
2. **Function hover** - Static function documentation

## Test Coverage Summary

| Category              | Direct Parser Tests       | Provider Tests                       |
| --------------------- | ------------------------- | ------------------------------------ |
| CTE scope             | `symbols.test.ts:132-188` | `completionEngine.test.ts:978-1009`  |
| Nested subquery       | `symbols.test.ts:190-241` | `completionEngine.test.ts:1086-1094` |
| MERGE aliases         | `symbols.test.ts:24-65`   | -                                    |
| DB..TABLE             | `symbols.test.ts:99-129`  | `completionEngine.test.ts:813-825`   |
| Quoted identifiers    | `symbols.test.ts:67-97`   | -                                    |
| UPDATE/DELETE aliases | `symbols.test.ts:284-319` | `completionEngine.test.ts:1164-1188` |

## Phase 2 Measurement Status

Harness: `Benchmark/suggestBenchmark.test.ts`

Scope: parser/context pipeline only. This measurement coverage excludes LSP transport overhead, metadata I/O, and VS Code rendering costs, so it should be treated as an internal regression floor rather than a full end-to-end request benchmark.

The internal parser/context benchmark is within the current working budget. The repo still does not have a dedicated end-to-end LSP completion benchmark, so transport and metadata fetch overhead remain intentionally unreported in this document.

## Current Follow-Through

- Keep adding direct helper-level tests when a behavior is only covered through the large `completionEngine` integration suite.
- Hover routes through the LSP in production, with the local provider retained only for test-mode fallback coverage.
- Signature help migrated to LSP; extension-host provider retained for test-mode fallback.
- Code actions split: LSP handles SQL/PAR codes (parser diagnostics), extension host handles NZ/NZP codes (linter rules). Shared `buildSafeFixEdit` helper for deterministic rewrites.
- Do not claim quoted CTE names as supported until the grammar accepts them explicitly.
