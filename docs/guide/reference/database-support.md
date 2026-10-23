---
title: Database support matrix
description: Compare the advertised JustyBase dialects by runtime, authoring depth, metadata, writes, and operational features.
audience: reference
category: Reference
status: Supported
last_verified: 2026-10-21
product_version: 3.19.4
---

# Database support matrix

JustyBase presents one workspace shell, but a capability is only available when the selected dialect provider advertises it. The matrix below is the public product focus; **Partial** means the common path works but some database-specific operations are limited.

| Database | Runtime / authentication | Parser, completion, LSP | Metadata / search | DDL / explain | Import, export, maintenance | Boundary |
| --- | --- | --- | --- | --- | --- | --- |
| Netezza | Bundled JavaScript driver; host/port/database/user/password; VS Code Secrets; raw TCP tunnel over HTTPS/WSS | First-class parser, CST semantics, NZPLSQL, LSP, quality, semantic tokens | Full lazy catalog/cache, source search, DDL, profiles; parsed dependencies, reverse lookup and bounded object/column impact analysis | DDL, EXPLAIN, plan analysis, query flow; deterministic metadata/EXPLAIN performance advisor; Object Designer native distribution/organization and guarded NZPLSQL routine surfaces | XLSB/XLSX/CSV/compressed CSV/JSON/XML/SQL/Markdown/Parquet; GROOM, stats, skew, sessions, security | Production/core; TCP tunnel uses named relay targets |
| Db2 | Preview companion with bundled TypeScript DRDA driver; host/port/database/user/password; VS Code Secrets; raw TCP tunnel over HTTPS/WSS | Dialect authoring, completion, metadata-aware LSP; depth varies by statement | Catalog browsing incl. sequences, indexes, triggers, MQTs and tablespaces; columns, DDL, compare | DDL, explain graph, and Db2-specific structural tooling | Spreadsheet/text import-export; `RUNSTATS`, `REORG`, dedicated Index Designer and Partition Manager | Preview; no platform-specific driver install; tunnel uses named relay targets |
| MS SQL Server | Preview companion runtime and `mssql` driver; raw TCP tunnel over HTTPS/WSS | Dialect parser profile, completion, formatting, diagnostics | Metadata, object/column browsing, DDL | Explain/parser support depends on provider surface | Provider-specific import/export and maintenance operations | Preview; partial by feature; tunnel uses named relay targets |
| Oracle | Preview companion runtime; raw TCP tunnel over HTTPS/WSS | Oracle parser profile, completion, formatting, diagnostics | Metadata incl. materialized views and indexes, DDL, object search | Explain and tuning provider paths where available | Provider-specific import/export and maintenance operations | Preview; partial by feature; tunnel requires Host/Port/Service Name |
| PostgreSQL | Preview companion runtime; raw TCP tunnel over HTTPS/WSS | PostgreSQL 16–18 grammar subset, completion, formatting, metadata diagnostics and PG001 version warnings | Metadata incl. materialized views, foreign tables, triggers and indexes; DDL, object search | Explain, partitions, indexes, and maintenance paths where implemented; Alter Table Designer and Index Designer | Provider-specific import/export and maintenance operations | Preview; partial by feature; tunnel uses named relay targets |
| MySQL | Preview companion runtime (`8.0+` scope); raw TCP tunnel over HTTPS/WSS | MySQL parser profile, completion, formatting, diagnostics | Metadata, DDL, object search, index/partition catalog views | Explain, Alter Table Designer, Index Designer, and method-specific Partition Manager | Provider-specific import/export and guarded table-structure operations | Preview; MariaDB and advanced partition restructuring outside scope; tunnel uses named relay targets |
| ClickHouse | Preview companion runtime over HTTP/HTTPS; user/password authentication; raw TCP tunnel over HTTPS/WSS | ClickHouse parser profile with PREWHERE, ARRAY JOIN, QUALIFY, LIMIT BY, WITH FILL, DDL options, completion, formatting, diagnostics | `system.databases`, `system.tables`, `system.columns`, object/source search | `SHOW CREATE TABLE`, cache DDL, textual EXPLAIN, MergeTree sorting/partition metadata | Shared CSV/clipboard import, streaming results, query cancellation, sessions/query kill, OPTIMIZE TABLE, partition inspection | Preview; self-hosted and ClickHouse Cloud; no relational indexes/procedures; HTTPS tunnels use TLS Server Name |
| Snowflake | Preview companion runtime using `snowflake-sdk`; password, OAuth, or key-pair configuration | Snowflake SQL authoring, completion, formatting, diagnostics | Databases, schemas, tables, views, procedures, functions, sequences, stages, streams, tasks, file formats, warehouses | `GET_DDL`, `EXPLAIN USING JSON`, recent-query profile inspection, and clustering-key designer surface | Stage-oriented import/export guidance, stream/task drafts, shared result workflows | Preview; warehouse credits and account privileges apply |
| Vertica | Preview companion runtime using `vertica-nodejs`; TLS and session options | Vertica SQL authoring, completion, snippets, diagnostics | `v_catalog`/`v_monitor` metadata, object and source search | DDL, explain graph, tuning, projections and skew inspection | Import previews, statistics/purge helpers, session monitoring, shared result workflows | Preview; runtime setup and privileges required |
| Access | Preview Access reader/session plus local embedded runtime | File SQL authoring and local completion; not a warehouse dialect | MDB/ACCDB tables, columns, DDL boundary | File/session operations; no warehouse session model | Access file import/edit/export plus local result workflows | Preview; file/runtime boundary |
| Files / DuckDB / SQLite | Preview local DuckDB or SQLite runtime; no server credential required | File SQL dialects, local completion and formatting | Lazy local catalogs incl. DuckDB indexes, and source profiles | Local DDL, explain, integrity/maintenance varies by runtime; DuckDB foreign keys and CHECK constraints can be declared when creating/replacing a table, but cannot be added through ALTER TABLE | CSV/TSV, XLSX/XLSB, Parquet, Avro, Access; result export | Preview desktop/local; file sources can be read-only; no TCP tunnel |

## Schema tree actions by dialect

The schema tree shows an action only when the connected dialect advertises it; empty submenus are hidden. Reports are read-only catalog queries that open in SQL Results.

| Action | Netezza | Db2 | PostgreSQL | Oracle | MS SQL Server | MySQL |
| --- | --- | --- | --- | --- | --- | --- |
| ER diagram | Yes | Yes | Yes | Yes | Yes | Yes |
| Dependencies / impact | Yes | Yes | Yes | Yes | Yes | — |
| Session Monitor: Kill session | Yes | `FORCE APPLICATION` | `pg_terminate_backend` | `ALTER SYSTEM KILL SESSION` ¹ | `KILL` | `KILL` |
| Session Monitor: Cancel query | — | `WLM_CANCEL_ACTIVITY` | `pg_cancel_backend` | `ALTER SYSTEM CANCEL SQL` (18c+) ¹ | — | — |
| Analysis ▸ Table size / Table privileges | — | Yes | Yes | Yes (size: own schema only) | Yes | Yes |
| Maintenance ▸ Maintenance status | — | REORGCHK-style recommendation | `pg_stat_user_tables` | Statistics staleness | Index fragmentation | `DATA_FREE` |
| Database ▸ Lock waits | — | `MON_LOCKWAITS` | `pg_blocking_pids` | `V$SESSION` ¹ | `dm_exec_requests` | `performance_schema` ¹ |
| Database ▸ Invalid objects | — | `SYSCAT.INVALIDOBJECTS` | Invalid indexes | `ALL_OBJECTS` + `ALL_ERRORS` | — | — |
| Refresh Materialized View | Yes ² | `REFRESH TABLE` (MQT) | Yes, optional `CONCURRENTLY` | `DBMS_MVIEW.REFRESH` | — | — |
| Space reclaim (Maintenance ▸) | GROOM | Reorganize Table (REORG) | Vacuum Table | Move Table | — | Optimize Table |
| Statistics (Maintenance ▸) | `GENERATE STATISTICS` | RUNSTATS: all columns, with distribution, sampled 10 %, or saved profile | Analyze Table (`ANALYZE`) | `DBMS_STATS.GATHER_TABLE_STATS` | `UPDATE STATISTICS` | Analyze Table (`ANALYZE TABLE`) |

¹ Needs `SELECT` on `V$SESSION` (Oracle) or `performance_schema` (MySQL) for the connected account; without it the action reports the database error. Oracle Cancel/Kill has not been verified against a privileged live account.
² Netezza materialized views are kept current on insert; **Refresh** re-sorts the unsorted tail of the view.

ClickHouse offers Optimize Table and session kill; Vertica, DuckDB and SQLite keep their own maintenance actions listed in the matrix above.

## Status interpretation

Parser support does not imply identical SQL acceptance. Metadata support does not imply every catalog object is visible to the connected user. Explain/tuning and maintenance are explicitly provider-specific. A disabled context-menu action is usually a capability boundary or privilege check.

## Runtime selection

Install the core extension for Netezza and the companion extension required by the selected database. Keep credentials in VS Code Secret Storage and runtime setup instructions in the relevant database guide. Optional extensions remain short Marketplace pages; this matrix is the canonical capability description.

For the shared raw TCP tunnel deployment, including the FastAPI relay, named
target allowlist, reverse-proxy configuration, and live database checks, see
the [global database tunnel guide](../../database-tunnel.md).

## How to report a parity gap

Include database kind, version, connection mode, a minimal SQL/object example, expected behavior, and whether metadata was refreshed. Do not attach credentials or production data. The [parser guide](guide/user/parser-lsp/) and [import/export guide](guide/user/import-export/) explain common platform boundaries.

## Generated source inventory

The Pages build records every advertised `DatabaseKind` found in the shared contract. A listed companion is a repository and packaging inventory claim, not a promise of identical depth: Snowflake, Vertica, and the other optional runtimes remain Preview until their common dialect contract and live validation meet the promotion criteria in the quality roadmap.

<!-- GENERATED:DATABASES -->

Netezza analysis scope and evidence limitations are documented in
[Dependencies and impact analysis](dependency-analysis.md) and
[Netezza Performance Advisor](netezza-performance-advisor.md).
