---
title: Test Data Generator and Schema Compare
description: Create controlled test rows and compare database objects before a migration or release.
audience: user
category: Product guides
status: Partial
last_verified: 2026-08-19
product_version: 3.17.13
---

# Test Data Generator and Schema Compare

## Test Data Generator

Open **Test Data Generator** from a table context. Choose row count, columns, generators, null rates, ranges, and repeatability/seed where supported. Preview the generated values and target SQL before inserting. Use a staging table or a disposable local database for destructive experiments.

Generated data is synthetic, but column names, comments, and shape can still be sensitive. Never use a production table as a scratch target without an explicit plan.

## Schema Compare

Open **Compare Schema** for compatible table, view, or procedure objects. Select source and target, compare columns/keys/options/source, and review the difference list. Generate a migration script only after checking ordering and dependencies.

Schema Compare is a structural comparison, not a row-by-row data reconciliation. It can miss semantics not represented in the catalog or source returned by the provider. Access, SQLite, and Db2 have different comparison surfaces from Netezza.

## Release checklist

- Refresh both metadata scopes.
- Compare with the same database/schema qualification.
- Review dropped/renamed columns as destructive changes.
- Check types, nullability, defaults, distribution/partitioning, comments, and constraints.
- Run generated SQL through parser/linter and an appropriate `EXPLAIN`/preview.
- Keep the comparison and applied script with the release record.
