---
title: Migration Studio and ETL Designer
description: Move data between connections and build repeatable visual ETL flows with explicit staging and execution boundaries.
audience: user
category: Product guides
status: Partial
last_verified: 2026-08-19
product_version: 3.17.2
---

# Migration Studio and ETL Designer

## Migration Studio

<figure class="figure-wide">
  <img src="screenshots/migration-studio.png" alt="Migration Studio for streaming Netezza results into another database">
  <figcaption>Migration Studio combines source, target, column mapping, and a reviewable execution plan.</figcaption>
</figure>

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

### Cross-database and file sources

The Netezza target writer uses the 2.4.4 driver's virtual import-stream registry and `FROM EXTERNAL` protocol, with driver-managed socket backpressure. This is the preferred path for Netezza targets because it avoids staging migration rows in a temporary client file.

The live migration coverage includes Netezza↔PostgreSQL and Netezza↔Oracle paths, local SQLite→Netezza, and optional Db2→Netezza when Db2 credentials and the native `ibm_db` runtime are available. Parquet, CSV, XLSX, XLSB, Avro, and Access files can be exposed through the DuckDB/File SQL connection where the format is supported; Parquet→Netezza is verified by selecting the file view and migrating that result. File SQL is the appropriate route for Parquet because the Netezza driver itself does not parse Parquet.

## ETL Designer

<figure class="figure-wide">
  <img src="screenshots/etl-designer.png" alt="ETL Designer canvas in JustyBase">
  <figcaption>ETL Designer connects SQL, Python, import, and export tasks as a directed flow.</figcaption>
</figure>

The ETL canvas supports SQL, Python script, import, export, and container tasks connected as a directed flow. Configure inputs, outputs, connections, order, error policy, and timeouts. Projects are file-based and should be reviewed like code.

`Continue on Error` is a deliberate graph policy: it records a failed node and allows eligible downstream nodes to run. It does not make the failed output valid. Stop and inspect dependencies when a later node consumes the failed artifact.

## Limits

ETL and migration are **Partial** across dialects and formats. Some nodes are desktop-only and local file import/export uses a separate runtime. See [Import and export](guide/user/import-export/) and [Database support](guide/reference/database-support/).
