# PostgreSQL Support

PostgreSQL support is delivered as the optional sibling extension in [`extensions/postgresql`](../extensions/postgresql).

## Preview extension status

This pack is published with `"preview": true` in `extensions/postgresql/package.json`. It is a **companion runtime** for the JustyBase core extension — not a peer of the Netezza-first SQL stack.

**Netezza (core)** ships the full dialect tooling: dedicated Chevrotain grammar, NZPLSQL procedure diagnostics, semantic tokens, SQL/NZ/NZP linter depth, and Netezza-specific IDE workflows (GROOM, session monitor, ETL designer, and similar).

**PostgreSQL (this pack)** reuses the shared shell (connect, schema browser, query execution, results/export) and adds PostgreSQL-oriented features below. SQL editor intelligence is **more limited** than Netezza and should be treated as preview-quality.

## What this pack provides

- Shared connection UI with PostgreSQL-specific fields such as `searchPath`, `sslMode`, and statement timeout
- Metadata-driven schema explorer for schemas, tables, views, functions, procedures, and sequences
- Metadata-aware SQL completion through the shared LSP path (where implemented for PostgreSQL)
- PostgreSQL import flow backed by `COPY ... FROM STDIN`
- DDL generation for tables, views, routines, and sequences
- `EXPLAIN (FORMAT JSON)` parsing for the explain view and tuning-advisor scaffolding

## Installation

1. Install the core extension (search for "JustyBase Core" in the VS Code Marketplace)
2. Install the optional PostgreSQL support extension from this repository packaging flow
3. For local packaging or development:

```bash
cd extensions/postgresql
npm install
npm run build
```

## Runtime Notes

- The extension uses the pure JavaScript `pg` driver. No native binaries are bundled.
- Each saved PostgreSQL connection targets a single database. Save separate connections for different databases.
- System schemas such as `pg_catalog`, `information_schema`, `pg_toast*`, and temp schemas are intentionally filtered from the main schema explorer.

## Explain and Tuning

- The explain command builds `EXPLAIN (FORMAT JSON, ...)` statements for PostgreSQL.
- The shared explain view consumes a PostgreSQL JSON plan after it is normalized into the common planner text shape.
- The PostgreSQL tuning advisor currently provides heuristic recommendations for:
    - `SELECT *`
    - large sequential/full scans
    - nested loop joins at larger row volumes
    - high overall planner cost
    - row-estimate drift when `EXPLAIN ANALYZE` output is supplied

## Import and COPY

- PostgreSQL CSV import uses `COPY ... FROM STDIN`
- Import streams are kept in memory only for the duration of the import session
- No credentials or import artifacts are persisted in the repository

## Integration Testing

Optional local integration:

```bash
npm run test:postgres:integration
```

The test is skipped unless `POSTGRES_LIVE_TEST_*` environment variables are set.

Optional docker-compose environment:

```bash
docker compose -f extensions/postgresql/docker-compose.integration.yml up -d
POSTGRES_LIVE_TEST_HOST=127.0.0.1 \
POSTGRES_LIVE_TEST_PORT=55432 \
POSTGRES_LIVE_TEST_DATABASE=justybase \
POSTGRES_LIVE_TEST_USER=justybase \
POSTGRES_LIVE_TEST_PASSWORD=justybase \
npm run test:postgres:integration
docker compose -f extensions/postgresql/docker-compose.integration.yml down -v
```
