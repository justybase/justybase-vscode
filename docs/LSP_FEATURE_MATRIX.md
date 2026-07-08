# SQL LSP Feature Matrix

For an editor-facing status board with the current Phase 2 completion baseline, see `docs/EDITOR_CAPABILITY_MATRIX.md`.

## Current Surface

| Feature | Transport | Primary Files | Status | Quality | Notes |
| --- | --- | --- | --- | --- | --- |
| Diagnostics (SQL/PAR) | LSP | `src/server/main.ts`, `src/sqlParser/validator.ts` | Working | Native | Parser diagnostics publish from the language server only when the client is running. |
| Diagnostics (NZ/NZP) | Extension host | `src/providers/sqlLinterProvider.ts`, `src/providers/sqlQualityEngine.ts` | Working | Native | Extension linter runs quality rules only when LSP is active; full parser+quality fallback when LSP is off. |
| Completion | LSP | `src/server/main.ts`, `src/server/completionEngine.ts` | Working | Native + Heuristic | Parser-based scope with explicit `sortText` ranking; context selection still mixes parser-native and best-effort paths. |
| Hover | LSP | `src/server/main.ts`, `src/providers/parserHoverProvider.ts` | Working | Native | Production hover now routes through the language server; the extension-host provider remains test-only as a local fallback. |
| Go to Definition | LSP | `src/server/main.ts` | Working | Native | Symbol resolution uses parser-backed rename-symbol logic. |
| References | LSP | `src/server/main.ts`, `src/sqlParser/symbols.ts` | Working | Native | Parser-backed symbol collection. Extension-host fallback for test mode only. |
| Rename | LSP | `src/server/main.ts`, `src/sqlParser/symbols.ts` | Working | Native | Quote-aware rename via `formatSqlRenameReplacement`. Extension-host fallback for test mode only. |
| Inlay Hints | LSP | `src/server/inlayHintEngine.ts`, `src/server/main.ts` | Working | Native | Inline column-type hints in the language server. |
| Code Actions (linter) | LSP + Extension host | `src/server/handlers/signatureAndCodeActionHandlers.ts`, `src/providers/linterCodeActions.ts` | Working | Native | LSP serves SQL/PAR quick fixes; NZ/NZP codes remain on the extension host. |
| Code Actions (refactors) | Extension host | `src/activation/deferredFeatureRegistration.ts`, `src/providers/sqlRefactorCodeActions.ts` | Working, not migrated | Native | Parser-based; transport migration is orchestration work. |
| Signature Help | LSP | `src/server/handlers/signatureAndCodeActionHandlers.ts`, `src/server/main.ts` | Working | Native | Production signature help routes through the language server with request budgets. Extension-host provider remains test-mode fallback only. |
| Document Symbols | Extension host | `src/activation/sqlLanguageRegistration.ts`, `src/providers/documentSymbolProvider.ts` | Working, not migrated | Native | Candidate for LSP migration if outline latency becomes visible. |
| Folding Ranges | Extension host | `src/activation/sqlLanguageRegistration.ts`, `src/providers/foldingProvider.ts` | Working, not migrated | Native | Low urgency. |
| CodeLens | Extension host | `src/activation/sqlLanguageRegistration.ts`, `src/providers/sqlCodeLensProvider.ts` | Working, not migrated | Native | Depends on connection context. |
| Semantic Tokens | Extension host | `src/activation/sqlLanguageRegistration.ts`, `src/providers/semanticTokensProvider.ts` | Working | Native | Parser-backed roles via `identifierRoleCollector`; not routed through LSP. |
| Formatting | Extension host | `src/providers/sqlFormattingProvider.ts`, `src/activation/sqlLanguageRegistration.ts` | Working | Hybrid | Document/range formatting via `formatSql()` and dialect formatter profiles. |

### Quality Legend

| Quality | Description |
| --- | --- |
| **Native** | Backed by parser or metadata with deterministic results |
| **Fallback** | Working but uses secondary transport or heuristic approach |
| **Heuristic** | Relies on insertion order, regex, or best-effort matching |

## Diagnostics Split

| Source | Collection / transport | Codes | When active |
| --- | --- | --- | --- |
| LSP (`publishDiagnostics`) | VS Code Problems (server) | SQL*, PAR*, LEX* | `isSqlLanguageClientRunning()` after `client.start()` |
| Extension linter (`netezza-sql-linter`) | VS Code Problems (`source: Netezza Quality`) | NZ*, NZP* | Always (quality-only when LSP is running) |
| Extension linter fallback | VS Code Problems | SQL*, PAR*, NZ*, NZP* | LSP client not running (tests, degraded mode) |

When LSP is active, expect **two Problems sources** on SQL/PAR files:

1. **Parser diagnostics** from the language server (`SQL*`, `PAR*`, `LEX*`) — schema via `LspSchemaProvider` / `metadataBridge`.
2. **Quality rules** from the extension host (`NZ*`, `NZP*`) — Netezza style and NZPLSQL checks; NZP rules run only when the document contains `CREATE PROCEDURE`.

`netezza.validateSelectedSql` on a whole document delegates to the linter for NZ/NZP and does not re-count parser diagnostics when LSP is active.

Schema parity between LSP and extension-host validation is covered by `src/__tests__/schemaProviderParity.test.ts`. Mirrored system-catalog lookups remain extension-host only.

## Parse session

LSP features that need a Chevrotain CST share a per-server `DocumentParseSession` (`src/sqlParser/documentParseSession.ts`):

- **Cached:** lexer + parser output (`parseSqlStatements`) keyed by content hash and parsing runtime.
- **Derived per request:** semantic scope walks and `SqlValidator` visitor passes (visitor state is not shared).
- **Wired in:** `publishDiagnostics`, completion, inlay hints, and hover (`src/server/main.ts` and completion/inlay engines).

On a single document version, diagnostics plus completion should trigger at most one full-document parse; inlay hints reuse statement-scoped parse entries from the same session. Extension-host features (semantic tokens, quality linter) still parse independently until a later migration phase.

Benchmark: `npm run benchmark:lsp` reports `parseCalls` for the multi-feature xlarge scenario; CI enforces `parseCalls ≤ 1` when `LSP_BENCHMARK_ENFORCE=1`.

## Incremental validation

LSP diagnostics use a `DocumentValidationSession` to track statement boundaries and cache statement-level diagnostics across document versions:

- **Statement index:** `src/sqlParser/statementIndex.ts` derives stable per-statement hashes from `SqlParser.splitStatementsWithPositions`.
- **Dirty detection:** `publishDiagnostics` compares the previous and current statement index and uses the incremental path when only a small subset changed.
- **Diagnostics cache:** unchanged statements reuse cached `ValidationError` entries; dirty statements are revalidated and merged before publishing.
- **Fallback:** cold opens, parse failures, mass edits, and missing cache entries still use full-document validation.

The benchmark includes an XLarge incremental-edit scenario and reports `validatedStatements` so the diagnostics budget reflects the number of statements that were actually revisited.

## Immediate Gaps

- NZ/NZP linter code actions remain extension-host only (SQL/PAR fixes are already on LSP).
- Refactor code actions remain extension-host only.
- Completion ranking has deterministic `sortText` priorities but still lacks richer metadata relevance scoring.
- Full-document XLarge diagnostics median (~580 ms) is within budget but tight; incremental validation path is the preferred hot-edit route.

## Metadata & Completion Ranking Status

| Item type | Current ranking | Sort mechanism | Quality |
| --- | --- | --- | --- |
| Variables | 1st | `sortText: "0_..."` | Native |
| Wildcard expand | 2nd | `sortText: "0000_expand"` | Native |
| PK columns | 3rd | `sortText: "0_col"` | Native |
| FK columns | 4th | `sortText: "1_col"` | Native |
| Local definitions (aliases, CTEs) | Early | `sortText: "1_..."` | Native |
| Scoped/local columns | Context-aware | `sortText: "2_..."` plus scoped-column disambiguation | Native |
| Metadata tables | Mid | `sortText: "3_..."` | Native |
| Metadata columns (non-scoped) | Mid | `sortText: "3_..."` | Native |
| Functions | Later | `sortText: "4_..."` | Native |
| Keywords | Last | `sortText: "5_..."` | Fallback |

## Baseline Notes

- Parser/context regression harness: `Benchmark/suggestBenchmark.test.ts`.
- End-to-end LSP engine latency (completion, hover, inlay, diagnostics validator): `Benchmark/lspFeatureBenchmark.test.ts` → `Benchmark/lspFeature.results.md`.
- CI enforces Medium/Large budgets when `LSP_BENCHMARK_ENFORCE=1`; full-document XLarge diagnostics keep a separate tier, while the incremental XLarge edit scenario uses the standard diagnostics budget.
- Raw benchmark artifacts are kept under `Benchmark/` for engineering reference.

## Recommended Next Slice

1. Continue tightening full-document XLarge diagnostics toward the standard 500 ms median budget now that incremental edits are covered.
2. Migrate refactor code actions to LSP only if outline/latency pressure justifies the orchestration cost.
3. Enrich completion ranking with metadata relevance scoring beyond `sortText` tiers.