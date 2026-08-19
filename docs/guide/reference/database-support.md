---
title: Database support matrix
description: Compare the advertised JustyBase dialects by runtime, authoring depth, metadata, writes, and operational features.
audience: reference
category: Reference
status: Supported
last_verified: 2026-08-19
product_version: 3.16.35
---

# Database support matrix

JustyBase presents one workspace shell, but a capability is only available when the selected dialect provider advertises it. The matrix below is the public product focus; **Partial** means the common path works but some database-specific operations are limited.

| Database | Runtime / authentication | Parser, completion, LSP | Metadata / search | DDL / explain | Import, export, maintenance | Boundary |
| --- | --- | --- | --- | --- | --- | --- |
| Netezza | Bundled JavaScript driver; host/port/database/user/password; VS Code Secrets | First-class parser, CST semantics, NZPLSQL, LSP, quality, semantic tokens | Full lazy catalog/cache, source search, DDL, profiles, dependencies | DDL, EXPLAIN, plan analysis, query flow, tuning paths | XLSB/XLSX/CSV/compressed CSV/JSON/XML/SQL/Markdown/Parquet; GROOM, stats, skew, sessions, security | Production/core |
| Db2 | Companion runtime; platform-specific driver package | Dialect authoring, completion, metadata-aware LSP; depth varies by statement | Catalog browsing, columns, DDL, compare | DDL and database-specific explain/maintenance where implemented | Spreadsheet/text import-export and Db2 maintenance paths | Supported with runtime setup |
| MS SQL Server | Companion runtime and `mssql` driver | Dialect parser profile, completion, formatting, diagnostics | Metadata, object/column browsing, DDL | Explain/parser support depends on provider surface | Common import/export and maintenance operations | Partial by feature |
| Oracle | Companion runtime | Oracle parser profile, completion, formatting, diagnostics | Metadata, DDL, object search | Explain and tuning provider paths where available | Common import/export and maintenance operations | Partial by feature |
| PostgreSQL | Companion runtime | PostgreSQL parser profile, completion, formatting, diagnostics | Metadata, DDL, object search | Explain, partitions, indexes, and maintenance paths where implemented | Common import/export and maintenance operations | Partial by feature |
| MySQL | Companion runtime | MySQL parser profile, completion, formatting, diagnostics | Metadata, DDL, object search | Explain and maintenance paths where implemented | Common import/export and maintenance operations | Partial by feature |
| Access | Access reader/session plus local embedded runtime | File SQL authoring and local completion; not a warehouse dialect | MDB/ACCDB tables, columns, DDL boundary | File/session operations; no warehouse session model | Access file import/edit/export plus local result workflows | File/runtime boundary |
| Files / DuckDB / SQLite | Local DuckDB or SQLite runtime; no server credential required | File SQL dialects, local completion and formatting | Lazy local catalogs and source profiles | Local DDL, explain, integrity/maintenance varies by runtime | CSV/TSV, XLSX/XLSB, Parquet, Avro, Access; result export | Desktop/local; file sources can be read-only |

## Status interpretation

Parser support does not imply identical SQL acceptance. Metadata support does not imply every catalog object is visible to the connected user. Explain/tuning and maintenance are explicitly provider-specific. A disabled context-menu action is usually a capability boundary or privilege check.

## Runtime selection

Install the core extension for Netezza and the companion extension/runtime required by the selected database. Keep native runtime installation and version checks out of the workspace secrets. Optional extensions remain short Marketplace pages; this matrix is the canonical capability description.

## How to report a parity gap

Include database kind, version, connection mode, a minimal SQL/object example, expected behavior, and whether metadata was refreshed. Do not attach credentials or production data. The [parser guide](guide/user/parser-lsp/) and [import/export guide](guide/user/import-export/) explain common platform boundaries.

## Generated source inventory

The Pages build also records the `DatabaseKind` values found in the shared contract:

<!-- GENERATED:DATABASES -->
