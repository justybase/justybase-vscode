import type { DatabaseCopilotReferenceProvider, DatabaseReferenceTopic } from '@justybase/contracts';

const ALL_REFERENCE = `
Vertica guidance:
- Prefer explicit column lists over SELECT * in repeatable workloads.
- Use EXPLAIN and EXPLAIN VERBOSE JSON to inspect resegment, broadcast, and storage access operators.
- Favor projection-aware query design and refresh statistics after large data changes.
- COPY is the preferred high-volume ingest path, while batched INSERT is acceptable for lighter ad hoc loads.
`.trim();

const OPTIMIZATION_REFERENCE = `
Vertica optimization checklist:
- Check EXPLAIN output for BROADCAST and RESEGMENT operators first.
- Review projection design, segmentation, and statistics before rewriting joins.
- For delete-heavy tables, consider PURGE_TABLE after maintenance windows.
`.trim();

const PROCEDURE_REFERENCE = `
Vertica routine notes:
- Stored procedures and SQL functions are exposed separately in USER_PROCEDURES and USER_FUNCTIONS.
- Use EXPORT_OBJECTS to capture deployable DDL for procedures and functions.
- Keep schemas explicit in deployment scripts to avoid search path surprises.
`.trim();

export const verticaCopilotReferenceProvider: DatabaseCopilotReferenceProvider = {
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
