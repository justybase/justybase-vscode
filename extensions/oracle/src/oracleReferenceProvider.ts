import type { DatabaseCopilotReferenceProvider, DatabaseReferenceTopic } from '@justybase/contracts';

const ALL_REFERENCE = `
Oracle guidance:
- Use fully qualified object names (SCHEMA.OBJECT) in deployment and migration scripts.
- Use EXPLAIN PLAN FOR followed by SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY) for execution plan analysis.
- Prefer MERGE for upsert workflows and bulk FORALL/BULK COLLECT for PL/SQL data processing.
- Use external tables or SQL*Loader for high-volume data ingestion instead of row-by-row INSERT.
- Bind variables prevent hard parsing and improve cursor sharing; avoid literal concatenation in dynamic SQL.
`.trim();

const OPTIMIZATION_REFERENCE = `
Oracle optimization checklist:
- Inspect DBMS_XPLAN output for TABLE ACCESS FULL on large tables; verify index availability and predicate selectivity.
- Compare estimated vs. actual cardinality using GATHER_PLAN_STATISTICS hint; large mismatches signal stale statistics.
- Check for Nested Loop joins on large row counts — Hash Join or Sort Merge Join may be more efficient.
- Use DBMS_STATS.GATHER_TABLE_STATS to refresh optimizer statistics after significant data changes.
- Consider function-based indexes, partitioning, or materialized views for complex analytical queries.
- Review wait events and session statistics (V$SESSION, V$SQL) for I/O and latch contention bottlenecks.
`.trim();

const PROCEDURE_REFERENCE = `
Oracle routine notes:
- PL/SQL procedures and functions support packages, exception handling, autonomous transactions, and pipelined table functions.
- Use CREATE OR REPLACE for iterative development; schema-qualify all object references in package bodies.
- Prefer BULK COLLECT and FORALL over row-by-row processing for performance-critical operations.
- Use DBMS_OUTPUT.PUT_LINE for debugging and RAISE_APPLICATION_ERROR for custom error propagation.
`.trim();

export const oracleCopilotReferenceProvider: DatabaseCopilotReferenceProvider = {
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
