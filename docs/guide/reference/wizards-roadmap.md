---
title: Wizard and designer roadmap
description: Implementation plan for the next wave of webview wizards and designers — tables, triggers, partitions, indexes, constraints — with the per-dialect construct-support matrix and the test plan for every feature.
audience: reference
category: Reference
status: In progress
last_verified: 2026-09-05
product_version: 3.17.12
---

# Wizard and designer roadmap

This page is the implementation plan for the next wave of webview designers.
It pairs every planned wizard with a **per-dialect construct-support matrix**:
not every database supports every construct, and the UI, the DDL builders, and
the tests must all respect that. The current shipped surface is described in
[wizards-inventory.md](wizards-inventory.md); this page plans what comes next.

## Implementation baseline (2026-09-05)

The first vertical slice is now implemented and is the baseline for the
remaining phases:

- `packages/contracts` owns a versioned capability manifest for all twelve
  database kinds, including native alternatives, enforcement caveats,
  privilege/version/engine requirements, and trigger event metadata.
- The desktop extension exposes one `Open Object Designer` entry point and
  delegates to the registered dialect adapter. Existing MySQL, PostgreSQL,
  and Db2 DDL builders are guarded by the same manifest; unsupported DDL now
  fails with a typed `UnsupportedDesignerOperationError`.
- The self-hosted web editor exposes a schema-tree Object Designer with
  capability/status states, current-column context, reviewed SQL preview, a
  server-issued write token, and streamed apply. The initial table surface
  covers add-column, relational indexes, FK/CHECK creation, Netezza
  distribution + `ORGANIZE ON`, ClickHouse skipping indexes, Vertica
  projections, Snowflake clustering keys, a SQLite row-trigger form with
  `UPDATE OF`, `WHEN`, and `BEGIN`/`END` support, and a view-definition form
  with dialect-selected replacement semantics for the local web runtimes. A
  guarded Netezza NZPLSQL routine template is also available for procedure /
  function targets.
- The API reports runtime and read-only state separately from the static
  dialect manifest. At present only the embedded Netezza, SQLite, and DuckDB
  runtimes are executable through the web API; other profiles remain visible
  but are explicitly marked runtime-unavailable.
- SQLite and DuckDB table targets now have provider snapshot paths: columns,
  primary/unique/foreign/check constraints, indexes, source DDL, and a
  fingerprint are loaded before the designer form. SQLite additionally reads
  triggers; DuckDB reports its trigger-free model. The API rechecks the
  fingerprint at preview and apply time. Local SQLite/DuckDB view targets now
  load the source query and output columns as well. Other provider-backed
  snapshots remain on the next adapter slice.

The constraint forms and native physical-design forms are intentionally a
first slice, not completion of phases 2–7. The remaining work is to add
provider-backed snapshots/change plans, companion desktop adapters, metadata
pickers, triggers/views/routines/security panels, and the browser/Extension
Host evidence listed below.

Legend: **✓** full designer possible, **~** partial or different model (the
designer must use the dialect's native construct), **✗** not supported by the
dialect — the panel must show an explicit unsupported state, **–** not
applicable.

## Construct × dialect support matrix

This matrix is the single source of truth for capability gating. It is a
product decision table, not a statement about the parser: parser support and
DDL generation are separate concerns.

| Construct | Netezza | Db2 | MySQL | PostgreSQL | Oracle | MSSQL | SQLite | ClickHouse | Vertica | Snowflake | DuckDB | Access |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Alter table designer | ~¹ | ~² | ✓ | ✓ | ✓ | ✓ | ✓ | ~³ | ✓ | ✓ | ✓ | ~⁴ |
| Index designer | ~⁵ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~⁶ | ~⁷ | ~⁸ | ✓ | ✓ |
| Partition designer | ~⁹ | ✓ | ✓ | ✓ | ✓ | ✓ | – | ~¹⁰ | ~¹¹ | –¹² | – | – |
| FK constraint wizard | ✗¹³ | ✓ | ✓ | ✓ | ✓ | ✓ | ~¹⁹ | ✗ | ~¹⁴ | ~¹⁴ | ✓ | ✓ |
| CHECK constraint wizard | ✗¹³ | ✓ | ✓ | ✓ | ✓ | ✓ | ~¹⁹ | ✓ | ✓ | ✓ | ✓ | ~¹⁵ |
| Trigger designer | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗¹⁶ | ✗ | ~¹⁷ |
| View / materialized view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Procedure / function | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗¹⁸ | ✗ |
| Sequence | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | ✓ | ✓ | – | – |
| Users / roles | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ | – | – |

Footnotes (the "why" behind each non-✓ cell — used verbatim as the
unsupported-state reason text in the UI):

1. Netezza has no ALTER TABLE column/modify surface beyond a narrow set;
   schema evolution is done by CREATE-AS-SELECT + swap. Keep the dialog-based
   alter-table wizard for the supported subset.
2. Db2 alter operations are fragmented (RESTRICT on column drops, REORG after
   most changes). Ship a designer only for the safe subset: add column,
   NOT NULL, DEFAULT, comment, and show a REORG reminder.
3. ClickHouse has no ALTER TABLE ... MODIFY COLUMN compatible with a
   relational designer; columns are added/dropped by name and types are
   changed via `ALTER TABLE ... MODIFY COLUMN` in a limited way. Expose a
   column-add/drop panel only, or keep DDL text editing.
4. Access schema changes are file-locked and limited; the designer may only
   add columns on a writable MDB/ACCDB.
5. Netezza has no user indexes — the equivalent is `ORGANIZE ON` zone maps.
   The designer must be a **zone-map editor**, not an index designer.
6. ClickHouse has no B-tree indexes; the equivalent is data-skipping indexes
   (`INDEX ... TYPE minmax/bloom_filter`). Designer = skipping-index editor.
7. Vertica has no indexes — the equivalent is projections. Designer =
   projection designer (CREATE PROJECTION).
8. Snowflake has no indexes — the equivalent is clustering keys.
   Designer = clustering-key editor.
9. Netezza has no partitioning — the equivalents are `DISTRIBUTE ON`
   (hash distribution) and `ORGANIZE ON` (zone maps). Designer = distribution
   + organize editor.
10. ClickHouse partitioning is a MergeTree `PARTITION BY` expression, not
    physical partitions. Designer = partition-by expression editor.
11. Vertica partitions by expression with segmentation (hash); designer =
    PARTITION BY + segmentation editor.
12. Snowflake micro-partitions are automatic; no user-managed partitioning.
    Show unsupported state with a link to clustering keys.
13. Netezza does not enforce FK or CHECK constraints (PK/UNIQUE only).
    Hide FK/CHECK tabs; surface PK/UNIQUE instead.
14. Vertica and Snowflake accept FK declarations but do not enforce them.
    The wizard must warn "declared, not enforced" before generating DDL.
15. Access CHECK constraints are validation-rule based; the wizard may only
    cover table-level validation rules.
16. Snowflake has no triggers — streams + tasks are the supported mechanism.
    The trigger panel must offer to open the existing Stream/Task wizards.
17. Access "triggers" are data macros, not SQL triggers — out of scope for a
    SQL trigger designer; show unsupported state.
18. DuckDB has no procedures — macros are the closest construct; show
    unsupported state with a macro hint.
19. SQLite can store FK/CHECK declarations only in the table definition;
    changing an existing table requires a table-rebuild plan that preserves
    data, indexes, triggers, and foreign-key state. Until that planner is
    provider-backed, the Object Designer exposes the current declarations in
    the snapshot and keeps mutation controls read-only.

## Design principle: capability-driven panels

Every designer panel must derive its UI from a **capability manifest**, never
from `if (dialect === 'mysql')` chains scattered through the panel. The
concrete rules:

1. **Manifest in contracts.** Extend
   `packages/contracts/src/database/dialectTraits.ts`
   (`DatabaseObjectSupportTraits` already carries `supportsIndexes`) into a
   `DatabaseDesignerCapabilities` type covering: alter table, index variants,
   partition variants, FK (with `enforced` flag), CHECK, triggers (with event
   matrix), views/materialized, sequences, procedures, users/roles. Each
   dialect provider exports its manifest.
2. **One source of truth.** The manifest lives in the shared contract; the
   media panels, the host views, and the DDL builders all read the same
   object. A panel section renders only when the manifest says the construct
   exists.
3. **Two unsupported states, not one.** A construct that the dialect supports
   with a *different* model (e.g. ClickHouse skipping indexes, Snowflake
   clustering keys) renders a **redirect tab** pointing at the native
   designer. A construct the dialect truly lacks (e.g. Netezza triggers)
   renders a **disabled section with the footnote reason text**.
4. **Builders refuse, not just UI.** The pure DDL builder functions accept the
   manifest and throw a typed `UnsupportedDesignerOperationError` when asked
   to emit DDL for a construct the dialect does not support — the webview can
   then never execute what the UI was not allowed to create.
5. **Sync tests.** A contract test walks all 12 `DatabaseKind` values × every
   manifest field and asserts every cell is explicitly set (no accidental
   default), keeping the matrix above and the code in lockstep.

## Phased plan

Each phase ends with shippable, tested, documented functionality. Phases 1–2
are prerequisites; 3–7 can proceed in any order after that.

### Phase 1 — Capability manifest infrastructure

- Add `DatabaseDesignerCapabilities` to `packages/contracts`
  (`dialectTraits.ts` or a new `designerCapabilities.ts`), with per-dialect
  manifests for all 12 kinds.
- Add a shared `media/shared/designerCapability.ts` helper: `isSupported`,
  `isAlternativeConstruct`, `unsupportedReason(kind, construct)`.
- Retrofit the existing designers (MySQL/PG alter, MySQL/PG/Db2 index,
  MySQL/Db2 partition) to read the manifest instead of hardcoded dialect
  checks.
- Add the 12 × N sync test and the builder-guard test.

**Exit criteria:** no `dialect === 'x'` checks left in `media/*Designer/`
panels; every new wizard from here on starts from the manifest.

### Phase 2 — FK and CHECK constraint wizards (initial slice shipped; provider-backed work remains)

- The shared web Object Designer now ships guarded FK/CHECK forms for the
  executable web runtimes, including PostgreSQL `NOT VALID`, deferrability,
  referential actions, MySQL drop syntax, and explicit enforcement warnings.
- MySQL: FK wizard (columns, referenced table/columns, ON DELETE/UPDATE,
  MATCH, engine check) and CHECK wizard (expression editor, enforced from
  8.0.16+ — gate on server version like `MysqlPartitionCapabilities` does).
- PostgreSQL: FK wizard (local columns ↔ referenced PK/unique, actions,
  deferrable, NOT VALID) and CHECK wizard (expression, NOT VALID, comment).
- Then Oracle and MSSQL variants (Oracle: constraint state clauses; MSSQL:
  `WITH NOCHECK`, `WITH (NOLOCK)`-adjacent options, clustered PK note).
- Wire as tabs in the MySQL/PG alter-table designers **and** as standalone
  commands in the submenu.

**Exit criteria:** each wizard emits valid, dialect-tested DDL and refuses to
run when the target table engine/version cannot enforce the constraint.

### Phase 3 — Alter-table designers for Oracle and MSSQL

- Oracle: columns (type, NULL, DEFAULT, comment), tablespace, storage clause
  (PCTFREE/INITRANS), INVISIBLE/VIRTUAL columns where version allows; diff →
  single `ALTER TABLE` + `COMMENT ON`.
- MSSQL: columns, IDENTITY, computed columns, filegroup, `WITH (DATA_COMPRESSION)`,
  `SET (LOCK_ESCALATION)`; diff → `ALTER TABLE ... ALTER/ADD/DROP COLUMN` +
  `ALTER INDEX` for PK renames where needed.
- Reuse the MySQL/PG panel pattern; only dialect-specific controls differ.

**Exit criteria:** parity with the MySQL/PG alter designers on the shared
column matrix (add/modify/drop, NULL, default, comment, PK protection), plus
their dialect options.

### Phase 4 — Index designers: Oracle, MSSQL, and the dialect-signature set (initial native slice shipped)

- The first web-native slice is shipped: Netezza zone maps, ClickHouse
  data-skipping indexes, Vertica projections, and Snowflake clustering keys.
- Oracle: B-tree/bitmap, function-based, unique, tablespace, INVISIBLE,
  compression, parallel.
- MSSQL: INCLUDE, filtered (`WHERE`), columnstore/clustered/nonclustered,
  filegroup, fillfactor.
- Netezza **zone-map editor** (`ORGANIZE ON` columns + max rows per zone).
- ClickHouse **data-skipping index editor** (column, type minmax/bloom_filter,
  granularity).
- Snowflake **clustering-key editor** (key expressions, `CLUSTER BY` /
  `ALTER TABLE ... CLUSTER BY`).
- Vertica **projection designer** (columns, segmentation, sort order,
  `CREATE PROJECTION`).

**Exit criteria:** per-dialect DDL builder unit tests; the generic "Index
Designer" entry point on the schema tree dispatches to the native designer
(zone maps, projections, …) based on the manifest.

### Phase 5 — Partition designers: Oracle, MSSQL, PostgreSQL, ClickHouse, Netezza (initial native slice shipped)

- The first web-native slice is shipped for Netezza distribution/organization
  and ClickHouse partition maintenance (DROP, DETACH, ATTACH, OPTIMIZE FINAL),
  with destructive operations shown as explicit warnings.
- Oracle: RANGE/LIST/HASH + composite, interval; add/drop/truncate/merge/split
  partition operations.
- MSSQL: partition function + scheme wizard (range, boundary values, filegroup
  mapping, `ALTER PARTITION FUNCTION ... SPLIT/MERGE`).
- PostgreSQL: upgrade the dialog flow to a webview (create partitioned table,
  attach/detach partition, partition pruning notes).
- ClickHouse: `PARTITION BY` expression editor + `DROP PARTITION`,
  `OPTIMIZE ... FINAL` actions.
- Netezza: distribution (`DISTRIBUTE ON`/`RANDOM`) + `ORGANIZE ON` editor.

**Exit criteria:** for every non-✓ cell in the partition row the panel shows
the native alternative or an unsupported state with the footnote reason.

### Phase 6 — Trigger designers (SQLite initial slice shipped; remaining dialects)

- Common trigger model: timing (BEFORE/AFTER/INSTEAD OF), event
  (INSERT/UPDATE/DELETE with column list where supported), FOR EACH ROW vs
  statement level, WHEN predicate, body.
- The shared web Object Designer now ships the first executable slice for
  SQLite: BEFORE/AFTER row triggers, INSERT/UPDATE/DELETE events, `UPDATE OF`,
  `WHEN`, and a reviewed `BEGIN`/`END` body with preview/token apply. The
  provider-backed trigger snapshot and desktop/companion adapters remain to be
  added.
- Dialect deltas encoded in the manifest's event matrix: MySQL has no
  INSTEAD OF; MSSQL has no BEFORE and fires AFTER per statement; PostgreSQL
  and Oracle have INSTEAD OF (Oracle additionally: compound triggers, schema
  triggers); SQLite has INSTEAD OF on views only; Db2 has all timings.
- Body editing: plain SQL textarea + (for MySQL/Oracle/MSSQL) BEGIN/END
  template insertion, mirroring the existing procedure template flow.
- Explicit unsupported states: Netezza, ClickHouse, DuckDB (reason text),
  Snowflake (offer Stream/Task wizards instead), Vertica, Access.

**Exit criteria:** one panel, twelve manifests — the trigger designer has no
dialect-specific `if` branches outside the capability definitions.

### Phase 7 — View, sequence, and user/role wizards per matrix (view initial slice shipped)

- View wizard (dialect-neutral create, `OR REPLACE`, materialized variants
  where supported: Oracle/PG/MSSQL/Snowflake/ClickHouse).
- The shared web Object Designer now provides a standard-view definition form
  for SQLite/DuckDB runtime targets. Replacement is explicit: SQLite uses a
  reviewed `DROP VIEW IF EXISTS` + `CREATE VIEW` script, while dialects with a
  native replacement form use the manifest-selected statement. Provider-backed
  source loading, dependency checks, and materialized-view editors remain.
- Netezza procedure targets expose a native NZPLSQL template with parameters,
  return type, execution owner, and a reviewed `BEGIN_PROC`/`END_PROC` body.
  Other routine dialects remain status-only until their provider-specific
  function/procedure bodies and argument metadata are wired.
- Sequence wizard for Oracle, MSSQL, Db2, MySQL, Vertica, Snowflake
  (PostgreSQL exists): start/increment/cache/cycle, `ALTER SEQUENCE`.
- User/role wizards: MySQL, PostgreSQL, Oracle, MSSQL, ClickHouse, Snowflake
  — create/alter/drop user or role, grant table/privilege pickers.
- Netezza stays on the existing grant dialog + security panel (no change).

## Test plan

Every wizard follows the same five test layers, in increasing cost. The
referenced patterns already exist in the repo and are the templates.

### Layer 1 — Pure DDL builder unit tests (mandatory, cheapest)

Pattern: `src/__tests__/extensions/mysql/mysqlAlterTableDdl.test.ts`,
`src/__tests__/extensions/postgresql/postgresqlIndexDdl.test.ts`.

For each new builder, cover:

- every emitted clause (add/modify/drop column, options, comments);
- no-change input → empty statement / no-op (diff correctness);
- identifier quoting per dialect (reserved words, mixed case, `#temp`);
- guard cases: `UnsupportedDesignerOperationError` when the manifest forbids
  the construct (e.g. FK builder on Netezza, trigger builder on ClickHouse);
- `enforced: false` dialects emit the "declared, not enforced" warning string.

### Layer 2 — Capability manifest and sync tests (mandatory)

- New contract test (extend `src/__tests__/webviewContractSync.test.ts` or
  sibling): every `DatabaseKind` × every manifest field is explicitly set;
  the matrix document and the manifest agree (spot-check by construct).
- Panel-level test: each section renders enabled/redirected/disabled exactly
  as the manifest dictates — one table-driven test per designer.

### Layer 3 — View-host tests (mandatory)

Pattern: `src/__tests__/extensions/mysql/mysqlDesignerViews.test.ts`.

Per new host view: context loads (columns/options/triggers from mock query
results), load failure surfaces an error message, execute/copy/saveAsSQL
message routing, refresh invalidates stale context, dispose cleans listeners.

### Layer 4 — Browser / Extension Host evidence (high-risk changes)

- New webview panels: add a Playwright spec in `test-harness/tests/` that
  renders the bundled panel against the fixture and asserts section
  visibility for a supported and an unsupported dialect.
- DDL-executing paths (FK/CHECK create, partition operations, trigger create)
  are **high-risk writes**: extend the Extension Host scenario
  (`npm run test:extension-host`) with a designer command that creates a
  fixture table + constraint/trigger and drops it in `finally`. Live suites
  (`test:*:integration`) must follow hygiene: uniquely named fixtures, drop in
  `finally`, missing env vars are errors, never real credentials in tests.

### Layer 5 — Docs and coverage gates

- Update `wizards-inventory.md` and the `database-support.md` matrix row when
  each wizard ships (docs:check must pass).
- New high-risk code targets ≥ 80% line / ≥ 70% branch coverage
  (per `docs/TESTING_STRATEGY.md`); run `npm run test:coverage:changed` on the
  PR branch.

### Per-feature checklist (definition of done)

1. Manifest entry added (or existing entry corrected) with sync test.
2. DDL builder + Layer 1 tests (including guard and no-op cases).
3. Host view + Layer 3 tests.
4. Panel section gated on the manifest; unsupported/redirect states tested.
5. Command registered in the extension `package.json` submenu; entry added to
   `esbuild.js` and `tsconfig.media.json`.
6. Layer 4 evidence where the change executes DDL or renders a new panel.
7. Docs updated; `npm run check-types && npm run lint && npm run build`
   green.
