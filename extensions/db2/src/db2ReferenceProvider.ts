import type { DatabaseCopilotReferenceProvider, DatabaseReferenceTopic } from '@justybase/contracts';

const ALL_REFERENCE = `
Db2 LUW guidance:
- Use fully qualified object names (SCHEMA.OBJECT) in production and migration scripts.
- Use EXPLAIN to populate plan tables and db2exfmt or Visual Explain to inspect access plans.
- Prefer LOAD or IMPORT utilities for bulk data ingestion; use INSERT FROM for smaller volumes.
- Run RUNSTATS regularly to keep the optimizer informed of data distribution and table growth.
- Use REORG TABLE to reclaim space and reorganise data for optimal access paths after heavy DML.
`.trim();

const OPTIMIZATION_REFERENCE = `
Db2 optimization checklist:
- Inspect access plan sections for TBSCAN (table scans); verify index availability and predicate selectivity.
- Compare estimated vs. actual cardinality from section actuals; large mismatches indicate stale RUNSTATS.
- Review SORT operations and hash join build sizes; consider indexes or MDC (multi-dimensional clustering) to reduce sorts.
- Use db2advis for automated index and MQT (materialized query table) recommendations.
- Check lock wait and deadlock events using MON_GET_CONNECTION and SYSIBMADM.MON_LOCKWAITS.
- Consider range partitioning and MDC tables for large analytical workloads.
`.trim();

const PROCEDURE_REFERENCE = `
Db2 routine notes:
- SQL PL procedures support compound statements (BEGIN/END), condition handlers, cursors, and dynamic SQL.
- Use CREATE OR REPLACE PROCEDURE for iterative development.
- Keep schema qualification explicit in deployment scripts and use SET SCHEMA for session defaults.
- CALL statements invoke procedures; use VALUES INTO for scalar function results.
- For complex ETL, consider autonomous procedures and COMMIT ON RETURN for transaction control.
`.trim();

export const db2CopilotReferenceProvider: DatabaseCopilotReferenceProvider = {
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
