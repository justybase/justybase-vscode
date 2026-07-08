import type { DatabaseCopilotReferenceProvider, DatabaseReferenceTopic } from '@justybase/contracts';

const ALL_REFERENCE = `
SQL Server guidance:
- Use schema-qualified object names ([schema].[object]) in all production and migration scripts.
- Use SET STATISTICS IO ON and SET STATISTICS TIME ON, or inspect estimated/actual execution plans for diagnostics.
- Prefer BULK INSERT, bcp, or OPENROWSET(BULK ...) for high-volume data loading.
- Use parameterised queries or sp_executesql for dynamic SQL to benefit from plan caching and avoid SQL injection.
- Favour MERGE for upsert patterns and OUTPUT clause for capturing affected rows.
`.trim();

const OPTIMIZATION_REFERENCE = `
SQL Server optimization checklist:
- Inspect execution plans for Clustered Index Scan or Table Scan on large tables; verify index design and predicate selectivity.
- Check sys.dm_db_missing_index_details for optimizer-suggested missing indexes.
- Compare estimated vs. actual row counts; large discrepancies suggest stale statistics — run UPDATE STATISTICS.
- Review Key Lookup operators; consider covering indexes with INCLUDE columns.
- Monitor tempdb spills from Sort and Hash Match operators; increase memory grant or simplify queries.
- Use SET STATISTICS IO to identify high logical-read queries for targeted tuning.
`.trim();

const PROCEDURE_REFERENCE = `
SQL Server routine notes:
- T-SQL procedures support TRY/CATCH error handling, table-valued parameters, temporary tables, and dynamic SQL via sp_executesql.
- Use CREATE OR ALTER PROCEDURE for idempotent deployments (SQL Server 2016 SP1+).
- Always SET NOCOUNT ON at the start of procedures to suppress row-count messages.
- Schema-qualify all object references and use explicit transaction control (BEGIN TRAN / COMMIT / ROLLBACK) for data modifications.
`.trim();

export const mssqlCopilotReferenceProvider: DatabaseCopilotReferenceProvider = {
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
