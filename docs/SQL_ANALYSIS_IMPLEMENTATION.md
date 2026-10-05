# SQL dependency and performance analysis implementation

The SQL queue and Logs changes were delivered separately in commit
`bfee27f` (`feat(query): queue SQL per tab and improve execution Logs`).
This report describes the subsequent analysis features.

## Architecture

```text
Existing Netezza parser / semantic scopes   MetadataCache   Existing EXPLAIN
                    |                           |                 |
                    +---------------------------+-----------------+
                                                |
                       DependencyIndex / NetezzaTuningAdvisor
                                                |
                         Typed dependency / performance reports
                                                |
                           Schema Browser / analysis webview
```

`DatabaseAnalysisService` owns derived indexes and cancellation during one
extension activation. MetadataCache owns ephemeral definition catalogs and
existing column, distribution and foreign-key metadata. Analysis uses the
existing connection factory, execution helpers, cancellation manager, DDL
commands, history manager and structured EXPLAIN analyzer. It does not create
another SQL parser or execution runtime. SQL is captured when an action starts.

## Files and responsibilities

| Files | Purpose |
| --- | --- |
| `src/services/analysis/sqlAnalysis.ts` | Existing CST and semantic scope extraction; normalized references, columns, joins and patterns. |
| `src/services/analysis/dependencyIndex.ts` | Definition hashes, forward/reverse indexes, bounded traversal and impact reports. |
| `src/services/analysis/databaseAnalysisService.ts` | Shared metadata integration, bulk loading, invalidation, partial results and cancellation. |
| `src/services/analysis/analysisSession.ts` | Isolated factory-owned session, planner-only EXPLAIN and deterministic cleanup. |
| `src/services/analysis/performanceAdvisor.ts` | Evidence-driven deterministic Netezza findings. |
| `src/metadata/definitionCatalog.ts`, `src/metadata/cache/MetadataCache.ts` | Ephemeral definition ownership, bounded retention and expiry. |
| `src/dialects/netezza/metadata/systemQueries.ts` | Bulk view/procedure definitions using existing catalog conventions. |
| `src/dialects/netezza/tuning/netezzaTuningAdvisor.ts` | Additive performance-analysis entry point in the existing advisor. |
| `src/services/tuning/explainPlanSemanticAnalyzer.ts` | Existing structured plan model with indentation-unit inference. |
| `src/core/singleQueryExecutor.ts` | Optional caller-owned connection for the existing EXPLAIN helper. |
| `src/commands/databaseAnalysisCommands.ts`, `src/extension.ts`, `package.json` | Six commands, Schema Browser/editor menus and activation-owned disposal. |
| `src/views/databaseAnalysisView.ts`, `media/databaseAnalysis.ts`, `esbuild.js` | Themed panels, bounded graph, evidence, navigation, refresh and explicit skew measurement. |
| `src/__tests__/*Analysis*.test.ts`, `analysisSession.test.ts`, `metadataDefinitionCatalog.test.ts` | Core, metadata, cancellation, command and panel regressions. |
| `media/__tests__/databaseAnalysis.test.tsx`, `test-harness/tests/database-analysis.spec.ts` | Actual DOM and bundled browser protocol/graph/plan navigation. |
| `scripts/quality-gate.mjs`, `scripts/quality-tools.test.mjs`, `jest.media.config.cjs` | Coverage collection and regression-tested handling of erased declarations/static templates; executable template expressions remain checked. |
| `docs/guide/reference/dependency-analysis.md`, `netezza-performance-advisor.md`, `commands.md`, `database-support.md` | User documentation and supported-capability boundaries. |

## Dependencies and impact

Tables, views, procedures and external tables participate in object references.
Table relationships also use declared foreign keys. Both dependency directions
and direct/indirect impact are supported. Columns filter direct incoming edges;
subsequent hops follow object relationships. Exact direct edges are high,
indirect edges medium, and probable/wildcard edges low. These indicate objects
to review, rather than guaranteed breakage.

Supported constructs include qualified names, aliases, multiple joins, nested
queries, CTE exclusion, views referencing views, CALL and resolvable column
references. Literal dynamic SQL is analyzed as probable. Constructed dynamic
SQL, unresolved procedure variables, ambiguous columns and parser failures
produce explicit coverage issues. Routine overloads are aggregated by name.

Full projection lineage, function/sequence dependencies, incoming references
from other databases and local SQL-file references remain unsupported.
Unknown schemas and quoted identifiers are preserved rather than guessed.
Empty reports do not prove the absence of dependencies.

Graph depth defaults to two. All is capped at 100 hops, 300 objects and 3,000
evidence edges; visited identities terminate cycles. Nodes open existing DDL
actions, and the graph supports pan, zoom and keyboard activation.

## Performance rules and evidence

| Rule | Finding | Evidence |
| --- | --- | --- |
| NZPERF001 | Distribution does not co-locate equality joins (alignment or RANDOM) | CST + distribution HASH/RANDOM/UNKNOWN |
| NZPERF002 | Significant maximum/average slice skew | Explicit existing skew scan |
| NZPERF003A | Catalog-reported missing statistics on a large relation | Supplied catalog statistics state |
| NZPERF003B | Zero-confidence large scan | EXPLAIN confidence |
| NZPERF004 | Large estimated scan | EXPLAIN |
| NZPERF005 | Function/cast on columns in join/filter predicates | CST |
| NZPERF006 | Join column types differ | CST + cached types |
| NZPERF007 | JOIN without ON/USING/NATURAL | CST |
| NZPERF008 | Wide SELECT * on the wildcard-projected relation | Per-scope CST wildcard + columns + cardinality |
| NZPERF009 | Large sort/aggregation | EXPLAIN |
| NZPERF010 | UNION duplicate elimination | CST; conditional semantics-preserving advice |
| NZPERF011 | Large redistribution/broadcast/movement | EXPLAIN |
| NZPERF012 | Large estimated join expansion | EXPLAIN input/output estimates |

Findings reuse existing tuning severity, confidence and evidence contracts.
Plan row counts are estimates. There is no arbitrary score, fabricated
statistics age or automatic distribution-key change. Incomplete metadata and
failed EXPLAIN retain useful partial reports. Last Execution uses recorded SQL
and target context; it does not claim runtime or workload evidence.

Normal analysis never executes the analyzed production SQL and performs no
COUNT scan. It uses the existing safe planner-only EXPLAIN gate on an isolated
session. Optional skew measurement explicitly scans up to ten referenced
tables sequentially. Temporary objects from another session may be unavailable.
Core findings require no external AI service.

## Cache, resources and tests

Definitions expire after five minutes and are invalidated by existing metadata
refresh events. At most four database slices are retained, each bounded to
20,000 catalog rows per object type and 32 MB of SQL. Bulk metadata avoids a
query per object. Derived indexes retain hashes and edges, not SQL/AST copies;
unchanged definitions skip parsing. Index construction yields every 20 objects.
Cancellation and generation checks prevent stale publication. Sessions close
in finally blocks, panels cancel refresh on disposal, and extension shutdown
cancels active analysis and releases listeners/indexes. Nothing is persisted.

Core tests cover qualified references, CTEs, nesting, aliases, columns,
procedures/CALL, dynamic SQL, cycles, depth, cache invalidation, transactional
publication, cancellation and disposal. Performance tests cover every rule,
aligned/composite distributions, small-scan suppression, UNION ALL, incomplete
metadata, unavailable/malformed EXPLAIN and cardinality expansion. Command
tests cover captured SQL/targets, history, guards and quoted table names;
panel/DOM/browser tests cover indexed navigation, graph controls and stale
refresh cancellation.

A local synthetic measurement using 1,000 small view definitions and a warmed
parser observed approximately 444 ms initial indexing, 12 ms unchanged update,
3.52 ms bounded reverse lookup and 2.69 MiB heap growth. These are local fixture
measurements, not production performance guarantees. Timing artifacts remain
outside the repository.

## Remaining enhancements

Full column lineage, signature-specific routine resolution, cross-database
reverse catalogs, graph export, workload-aware distribution advice, runtime
and historical plan comparison, richer visual EXPLAIN, migration simulation
and optional AI explanations can build on these contracts.
