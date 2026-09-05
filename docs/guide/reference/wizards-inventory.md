---
title: Wizard and designer inventory
description: What object wizards and visual designers exist per dialect, and which ones are still missing compared with DataGrip, DBeaver, and other SQL editors.
audience: reference
category: Reference
status: Supported
last_verified: 2026-09-05
product_version: 3.17.12
---

# Wizard and designer inventory

This page inventories the visual wizards and designers shipped with JustyBase and
compares them with the wizard catalog of DataGrip, DBeaver, and similar editors.
"Wizard" here means any guided UI that produces DDL: webview-based designers,
QuickPick/input-box wizards, and template generators. Purely command-line or
`SHOW`-based viewers are noted but not counted as wizards.

Legend: **✓** full designer/webview, **capability matrix** shared designer
surface with runtime/provider gating, **dialog** QuickPick/input-box flow,
**view only** read-only inspector, **–** not applicable for the dialect,
**blank** missing.

## Inventory by dialect

| Wizard | Netezza | Db2 | MySQL | PostgreSQL | Oracle | MSSQL | SQLite | ClickHouse | Vertica | Snowflake | DuckDB/File | Access |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Create table designer | ✓ | ✓ | – | – | – | – | ✓ | – | – | – | – | – |
| Unified Object Designer (web/API) | ✓ | capability matrix | capability matrix | capability matrix | capability matrix | capability matrix | ✓ | capability matrix | capability matrix | capability matrix | ✓ | capability matrix |
| Alter table designer | dialog | dialog | ✓ | ✓ | – | – | – | – | – | – | – | – |
| Index designer | – | ✓ | ✓ | ✓ | – | – | dialog | n/a | – | – | – | – |
| Partition manager | – | ✓ | ✓ | dialog | – | – | n/a | view only | – | n/a | n/a | n/a |
| Foreign key wizard | – | – | – | – | – | – | view only | n/a | – | – | – | – |
| Check constraint wizard | – | – | – | – | – | – | – | n/a | – | – | – | – |
| View wizard | ✓ | – | – | – | – | – | capability matrix | – | – | – | capability matrix | – |
| Trigger wizard | – | – | – | – | – | – | capability matrix | n/a | – | – | – | – |
| Procedure/function wizard | ✓ | – | – | – | – | – | – | – | – | – | – | – |
| Sequence wizard | – | – | – | ✓ | – | – | n/a | n/a | n/a | – | n/a | n/a |
| User/role/permission wizard | dialog | – | – | – | – | – | n/a | – | – | – | n/a | n/a |
| External table wizard | ✓ | – | – | – | – | – | n/a | – | – | – | – | n/a |
| Stream/task/dynamic-table wizard | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ✓ | n/a | n/a |
| Import wizard (data → table) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Migration wizard (table/query → table) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Test data generator | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Visual query builder | ✓ | – | – | – | – | – | – | – | – | – | ✓ | – |
| ERD viewer | ✓ | – | – | – | – | – | – | – | – | – | – | – |
| Schema compare | ✓ | – | – | – | – | – | – | – | – | – | – | – |
| ETL designer | ✓ | – | – | – | – | – | – | – | – | – | – | – |

The import wizard and migration wizard are dialect-neutral: their adapters cover
all twelve `DatabaseKind` values, so the **✓** entries above are by design.
The table designer, visual query builder, ERD, and ETL designer are bundled in
the core extension; the Db2/MySQL designers live in the companion extensions.
The Unified Object Designer is available from the self-hosted schema tree and
uses the shared capability manifest; unsupported or not-yet-connected dialects
remain visible as explicit status states instead of silently falling back to
Netezza SQL. DuckDB and SQLite table targets load a provider snapshot with
source DDL, columns, keys, and indexes before editing; SQLite additionally
loads trigger definitions. Local DuckDB/SQLite view targets load the source
query and output columns, and their write preview is protected by the same
snapshot fingerprint.

## Current wizard surface (detail)

### Webview-based designers

- **Visual Table Designer** (`netezza.createTableDesigner`) — create table with
  columns, PK, defaults, constraints. The builder is dialect-aware for the
  registered table profiles and is capability-gated for unsupported engines.
- **Unified Object Designer** (self-hosted schema tree) — capability/status
  overview plus table tabs for add-column, relational indexes, FK/CHECK
  constraints, and native physical design. Netezza exposes distribution and
  zone-map organization; ClickHouse exposes data-skipping indexes; Vertica
  exposes projections; Snowflake exposes clustering keys; SQLite exposes a
  trigger form for row-level INSERT/UPDATE/DELETE triggers, including `WHEN`
  and `UPDATE OF` where supported. SQLite/DuckDB view targets also expose a
  reviewed definition/replacement form. Every change goes through exact SQL
  preview and a short-lived write token before apply. Netezza procedure targets
  additionally expose a guarded NZPLSQL template; other routine targets remain
  capability/status views until provider-specific body adapters are connected.
- **MySQL Alter Table Designer** (`justybase.mysql.alterTableDesigner`) — diffs a
  column/option design against the live table and emits one `ALTER TABLE`
  statement (ADD/MODIFY/DROP COLUMN, ENGINE, CHARACTER SET, COLLATE,
  AUTO_INCREMENT, COMMENT). PK columns cannot be dropped; existing column names
  are read-only.
- **PostgreSQL Alter Table Designer** (`justybase.postgresql.alterTableDesigner`) —
  diffs columns (TYPE, SET/DROP NOT NULL, SET/DROP DEFAULT, COMMENT ON COLUMN)
  and table options (SET TABLESPACE, SET/RESET fillfactor, COMMENT ON TABLE).
  PK columns cannot be dropped; existing column names are read-only.
- **Index Designer** — Db2 (`justybase.db2.createIndexWizard`), MySQL
  (`justybase.mysql.createIndexWizard`), and PostgreSQL
  (`justybase.postgresql.createIndexWizard`, access method, UNIQUE, INCLUDE,
  partial predicate, tablespace, index drop). The core `postgresql.createIndex`
  dialog flow remains available for quick creation.
- **Partition Manager** — Db2 (`justybase.db2.managePartitions`) and MySQL
  (`justybase.mysql.managePartitions`); PostgreSQL partitions are managed through
  dialog flows (`postgresql.createPartition`, `attachPartition`).
- **Advanced Import Wizard** (`netezza.importDataAdvanced`) — file → table with
  preview, type mapping, and validation for every dialect.
- **Migration Wizard** (`netezza.migrateData`) — table or SQL query → target
  table, cross-dialect.
- **Test Data Generator** (`netezza.openTestDataGenerator`), **Visual Query
  Builder** (`netezza.openVisualQueryBuilder`; Netezza/DuckDB/File),
  **ERD** (`netezza.showERD`; Netezza), **ETL Designer**
  (`netezza.openEtlDesigner`; Netezza).

### Dialog-based wizards

- **Alter Table Wizard** (`netezza.alterTableWizard`) — seven ALTER operations
  (add/rename/drop column, NOT NULL, DEFAULT) with a review/execute step.
  Netezza-flavored SQL; not dialect-gated.
- **Create View** (`netezza.createView`), **Create Procedure**
  (`netezza.createProcedure`, template-based), **Create External Table**
  (`netezza.createExternalTable`, basic/advanced) — Netezza.
- **Create Sequence** (`netezza.createSequence`) — PostgreSQL only.
- **Snowflake wizards** — Stream, Task, Dynamic Table creation and management.
- **SQLite tools** — add/drop index, view indexes/FKs, trigger creation through
  the self-hosted Object Designer, and maintenance (vacuum, integrity check,
  WAL checkpoint).
- **Netezza table tools** — primary key, unique constraint, grants, rename,
  owner, comments. Foreign-key creation is explicitly blocked because Netezza
  does not provide an enforced FK surface.
- **PostgreSQL maintenance** — create/attach/detach/drop partition, create index
  (confirm-and-execute dialogs).

## Gap matrix versus DataGrip / DBeaver

The largest product gaps are, in rough priority order:

1. **Visual alter-table designer for every warehouse dialect.** MySQL and
   PostgreSQL have one today. Oracle and MSSQL still rely on the
   Netezza-flavored dialog, which cannot express dialect options (tablespaces,
   storage, filegroups).
2. **Index Designer rollout.** PostgreSQL was upgraded from a dialog to a full
   designer (access method, INCLUDE, partial predicates, tablespace). Oracle
   (function-based, bitmap, tablespace), MSSQL (INCLUDE, filtered, columnstore),
   and Netezza remain on dialogs or are missing.
3. **Foreign key and check constraint wizards.** The shared web surface now
   provides guarded forms where the runtime is available; provider-backed
   MySQL, PostgreSQL, Oracle, MSSQL, and desktop/companion creation flows are
   still missing.
4. **View / trigger / procedure wizards for MySQL, PostgreSQL, Oracle, MSSQL.**
   Only Netezza has procedure templates and a view wizard.
5. **Partition wizards for Oracle and MSSQL.** Oracle partitioning and the MSSQL
   partition function/scheme flow are the two notable absences.
6. **Sequence wizards for Oracle, MSSQL, Db2, Netezza.** PostgreSQL has one.
7. **User/role wizards.** Missing for MySQL, PostgreSQL, Oracle, MSSQL,
   ClickHouse, Snowflake (Netezza has grants + security panel).
8. **Remaining dialect-signature designers.** The first web Object Designer
   slice covers Netezza zone maps/distribution, ClickHouse skipping indexes,
   Vertica projections, and Snowflake clustering keys. Full MergeTree table
   definitions (ORDER BY/PARTITION BY/TTL), Oracle/SQL Server storage-specific
   designers, and provider-backed edit plans remain.
9. **Schema and data compare beyond Netezza**, plus ERD/Visual Query Builder
   beyond Netezza/DuckDB.

## Adding a new wizard

Follow the existing companion-extension pattern:

1. Extend `packages/contracts/src/database/advancedFeatures.ts` when a
   maintenance capability (`createIndex`, `createPartition`, …) is involved.
2. Add a webview contract under `src/contracts/webviews/` plus a
   `media/<designer>/` panel with a facade entry in `esbuild.js` and
   `tsconfig.media.json`.
3. Implement the host view in the companion extension
   (`extensions/<dialect>/src/*DesignerView.ts`) and register the command in
   `package.json` under the dialect submenu.
4. Keep DDL generation in a pure builder module with unit tests
   (`mysqlAlterTableDdl.test.ts` is the reference), and drive the webview with
   the same builder so the preview and the executed statement never diverge.
5. Update the support matrix in `database-support.md` when a capability ships.
