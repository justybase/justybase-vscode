---
title: Migration Studio and ETL Designer
description: Move data between connections and build repeatable visual ETL flows with explicit staging and execution boundaries.
audience: user
category: Product guides
status: Partial
last_verified: 2026-08-19
product_version: 3.16.35
---

# Migration Studio and ETL Designer

## Migration Studio

Open **Migration Studio** from the Schema view or Command Palette. Select source and target connections, inspect discovered objects/columns, map compatible types, and review the generated migration plan. Choose whether the workflow creates a staging table, inserts into an existing target, or emits SQL for manual execution.

The source and target database kinds matter. Identifier quoting, generated DDL, identity/default behavior, constraints, and bulk-load paths are dialect-specific. A plan can be valid SQL and still require a target privilege or data-quality decision.

## Reliable migration workflow

1. Use read-only source credentials for discovery.
2. Compare schemas and export the plan before moving rows.
3. Map columns explicitly; do not accept a name-only match when types differ.
4. Preview DDL and row-count expectations.
5. Run a small/staged sample and validate counts/nulls.
6. Run the full transfer with progress and cancellation available.
7. Reconcile source/target counts and retain the generated plan.

Cancellation can stop the client pipeline, but a database may finish an in-flight bulk operation. Treat the target as needing reconciliation after an interrupted write.

## ETL Designer

The ETL canvas supports SQL, Python script, import, export, and container tasks connected as a directed flow. Configure inputs, outputs, connections, order, error policy, and timeouts. Projects are file-based and should be reviewed like code.

`Continue on Error` is a deliberate graph policy: it records a failed node and allows eligible downstream nodes to run. It does not make the failed output valid. Stop and inspect dependencies when a later node consumes the failed artifact.

## Limits

ETL and migration are **Partial** across dialects and formats. Some nodes are desktop-only and local file import/export uses a separate runtime. See [Import and export](guide/user/import-export/) and [Database support](guide/reference/database-support/).
