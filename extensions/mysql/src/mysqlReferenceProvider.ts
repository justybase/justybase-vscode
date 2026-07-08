import type { DatabaseCopilotReferenceProvider, DatabaseReferenceTopic } from '@justybase/contracts';

const ALL_REFERENCE = `
MySQL guidance:
- Use backtick-quoted identifiers for reserved words and mixed-case names.
- Use EXPLAIN FORMAT=JSON or EXPLAIN ANALYZE for detailed execution plan analysis.
- Prefer LOAD DATA INFILE for high-volume CSV imports; use INSERT ... ON DUPLICATE KEY UPDATE for upserts.
- InnoDB is the default storage engine; ensure tables use InnoDB for transactional integrity and row-level locking.
- Use prepared statements to benefit from query plan caching and prevent SQL injection.
`.trim();

const OPTIMIZATION_REFERENCE = `
MySQL optimization checklist:
- Inspect EXPLAIN output for type=ALL (full table scan); verify index coverage and WHERE clause selectivity.
- Check key_len in EXPLAIN to verify the optimizer is using the intended composite index prefix.
- Review filesort and Using temporary indicators; consider adding indexes or restructuring ORDER BY / GROUP BY.
- Use performance_schema or SHOW PROFILE for query-level CPU, I/O, and lock-wait breakdowns.
- Run ANALYZE TABLE after significant data changes to update index statistics for the optimizer.
- Consider covering indexes, composite indexes aligned with query patterns, and partitioning for large tables.
`.trim();

const PROCEDURE_REFERENCE = `
MySQL routine notes:
- MySQL supports stored procedures, functions, triggers, and events with BEGIN/END compound statements.
- Use DELIMITER to define multi-statement routines in script files.
- Procedures support DECLARE for local variables, cursors, condition handlers, and SIGNAL for custom errors.
- Use CREATE OR REPLACE (MariaDB) or DROP/CREATE patterns for idempotent deployments on MySQL.
- Schema-qualify routine calls and keep DEFINER/INVOKER security context explicit.
`.trim();

export const mysqlCopilotReferenceProvider: DatabaseCopilotReferenceProvider = {
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
