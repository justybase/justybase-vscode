import type { DatabaseCopilotReferenceProvider, DatabaseReferenceTopic } from '@justybase/contracts';

const ALL_REFERENCE = `
PostgreSQL guidance:
- Prefer explicit column lists over SELECT * in persistent application queries.
- Use EXPLAIN (FORMAT JSON) for machine-readable plans and EXPLAIN (ANALYZE, FORMAT JSON) for real execution evidence when it is safe to execute the statement.
- Review Seq Scan, Nested Loop, Sort, Hash, Aggregate, and Materialize operators first when a plan is slow.
- Verify index coverage, predicate selectivity, row-estimate quality, and join cardinality before rewriting SQL.
- Use COPY for high-volume CSV import/export workflows instead of row-by-row INSERT where possible.
`.trim();

const OPTIMIZATION_REFERENCE = `
PostgreSQL optimization checklist:
- Inspect the highest-cost operators from EXPLAIN (FORMAT JSON).
- Compare planned rows to actual rows when EXPLAIN ANALYZE is safe; large mismatches usually point to stale statistics or skew.
- Review join strategy, especially Nested Loop on medium or large row counts.
- Consider covering indexes, partial indexes, or predicate rewrites before wider query refactors.
`.trim();

const PROCEDURE_REFERENCE = `
PostgreSQL routine notes:
- Functions and procedures are distinct object types.
- Use CREATE OR REPLACE for iterative development where supported.
- Keep argument signatures stable and prefer explicit schema qualification for deployment scripts.
`.trim();

export const postgresqlCopilotReferenceProvider: DatabaseCopilotReferenceProvider = {
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
