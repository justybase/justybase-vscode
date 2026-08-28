---
title: Table Designer, Alter Table and maintenance
description: Design tables, review DDL changes, edit rows, and run database-specific maintenance with permission-aware safeguards.
audience: user
category: Product guides
status: Partial
last_verified: 2026-08-19
product_version: 3.17.4
---

# Table Designer, Alter Table and maintenance

## Table Designer and Alter Table Wizard

Use **Visual Table Designer** to draft a new table and **Alter Table Wizard** to add/rename/drop columns, keys, comments, or compatible type changes. The wizard generates SQL and shows a preview before execution. Review dependencies, default expressions, nullability, distribution/partition choices, and whether the dialect can perform the alteration in place.

## View/Edit Data

**View/Edit Data (Limit 50k)** opens a bounded editing surface for supported table connections. It is not available for every dialect and is separate from a disk-backed result grid. Review the generated update/insert/delete operations and keep a predicate or primary-key scope whenever possible.

## Maintenance actions

The Schema context menu exposes capabilities when the selected dialect advertises them:

- Netezza: GROOM, statistics, skew/distribution inspection, table recreation, comments, constraints, owner changes, and selected maintenance scripts.
- PostgreSQL/Oracle/Db2/MSSQL/SQLite: dialect-specific analyze, vacuum, reindex, indexes, partitions, or integrity operations where implemented.
- DuckDB/MySQL: local/engine-specific analyze, vacuum, recreation, and metadata workflows.
- Access: file/session operations rather than warehouse maintenance SQL.

GROOM, VACUUM, REINDEX, ANALYZE, statistics, and owner/permission changes can be expensive or privileged. A successful dialog means the operation was submitted; verify catalog state and query plans afterward.

## Security and comments

**Grant Permissions** and raw permission variants are capability- and privilege-dependent. **Add/Edit Comment** updates catalog metadata, not a local note. Use [Security Panel](guide/user/session-security/) for role/user discovery and review generated SQL before applying grants/revokes.

## When an action is hidden

Hidden actions usually mean the selected object kind or dialect capability does not support them, not that the command failed. Check the database kind, object type, connection privileges, and [Database support](guide/reference/database-support/).
