import type { DatabaseCopilotReferenceProvider, DatabaseReferenceTopic } from '@justybase/contracts';

const ALL_REFERENCE = `
DuckDB guidance:
- DuckDB is an in-process analytical database; prefer columnar scans and vectorised aggregations over row-by-row processing.
- Use EXPLAIN ANALYZE to inspect pipeline throughput, filter pushdown, and hash-join build sizes.
- Prefer COPY or read_csv/read_parquet functions for bulk ingest instead of row-by-row INSERT.
- Leverage DuckDB extensions (httpfs, parquet, json) to query remote or multi-format data directly.
- Use CREATE TABLE ... AS SELECT (CTAS) for materialising intermediate results in analytical pipelines.
`.trim();

const OPTIMIZATION_REFERENCE = `
DuckDB optimization checklist:
- Inspect EXPLAIN ANALYZE output for full-table scans on large datasets; consider adding filters or projecting fewer columns.
- Prefer explicit column lists over SELECT * to reduce memory pressure in wide tables.
- Use persistent storage mode for repeated queries on the same dataset instead of re-scanning files.
- Hash joins are the default strategy; verify build-side cardinality is reasonable before restructuring queries.
- GROUP BY on high-cardinality columns benefits from DuckDB's parallel hash aggregation; avoid unnecessary ORDER BY before aggregation.
`.trim();

const PROCEDURE_REFERENCE = `
DuckDB routine notes:
- DuckDB supports macros (CREATE MACRO) as lightweight reusable expressions and table-returning functions.
- Traditional stored procedures are not supported; use macros or client-side scripting for procedural logic.
- Table macros (CREATE MACRO ... AS TABLE) can encapsulate parameterised queries for reuse.
`.trim();

export const duckdbCopilotReferenceProvider: DatabaseCopilotReferenceProvider = {
    getReference(topic: DatabaseReferenceTopic = 'all'): string {
        if (topic === 'optimization') {
            return OPTIMIZATION_REFERENCE;
        }

        if (topic === 'procedure') {
            return PROCEDURE_REFERENCE;
        }

        return ALL_REFERENCE;
    },
};
