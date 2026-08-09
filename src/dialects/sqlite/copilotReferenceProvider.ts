import type { DatabaseCopilotReferenceProvider, DatabaseReferenceTopic } from '../../contracts/database';

export const sqliteCopilotReferenceProvider: DatabaseCopilotReferenceProvider = {
    getReference(topic?: DatabaseReferenceTopic): string {
        if (topic === 'optimization') {
            return 'SQLite optimization uses EXPLAIN QUERY PLAN, selective indexes, ANALYZE and careful handling of temporary B-trees.';
        }
        return 'SQLite supports local catalogs such as main and temp, tables, views, indexes, triggers, PRAGMA, ATTACH, transactions and EXPLAIN QUERY PLAN. It does not support stored procedures, external tables or distribution keys.';
    },
};
