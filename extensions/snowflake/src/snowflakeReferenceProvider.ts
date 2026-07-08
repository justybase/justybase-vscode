import type { DatabaseCopilotReferenceProvider, DatabaseReferenceTopic } from '@justybase/contracts';

const ALL_REFERENCE = `
Snowflake guidance:
- Prefer explicit warehouse and role selection for repeatable sessions.
- Use stage-based COPY INTO workflows for bulk import/export; prefer external cloud stages over local PUT from the extension.
- Use EXPLAIN USING JSON for machine-readable plans and QUERY_HISTORY/GET_QUERY_OPERATOR_STATS for recent execution profiling.
- Review scans, repartition/exchange steps, large sorts, and spill-heavy operators first when investigating performance.
- Semi-structured columns (VARIANT, OBJECT, ARRAY) often benefit from targeted projection, FLATTEN filters, and explicit casting.
`.trim();

const OPTIMIZATION_REFERENCE = `
Snowflake optimization checklist:
- Confirm the active warehouse size is appropriate before rewriting SQL.
- Inspect bytes scanned, partitions scanned, spills, and repartition steps from recent profile data.
- Trim projected columns and unnecessary FLATTEN expansions to reduce scan volume.
- Use clustering, pruning-friendly predicates, and staged data loading patterns where they materially reduce scan costs.
`.trim();

const PROCEDURE_REFERENCE = `
Snowflake routine notes:
- Procedures, tasks, streams, and stages are first-class operational objects and should be schema-qualified in deployment SQL.
- Use CREATE OR REPLACE for iterative development where safe.
- Preserve role/warehouse assumptions explicitly in tasks and operational scripts.
`.trim();

export const snowflakeCopilotReferenceProvider: DatabaseCopilotReferenceProvider = {
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
