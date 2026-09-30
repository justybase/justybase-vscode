import {
    isForeignKeyCatalogUnavailable,
    getForeignKeyReferencesForTable,
    getForeignKeyReferencingTable,
    normalizeForeignKeyRelationshipRows,
} from '../metadata/foreignKeyRelationships';

describe('foreignKeyRelationships', () => {
    it.each(['Permission denied', 'DATABASE X does not exist', 'Relation X not found', 'ResolveCatalog failed'])(
        'classifies expected catalogue visibility failures: %s', message => {
        expect(isForeignKeyCatalogUnavailable(new Error(message))).toBe(true);
    });
    it.each(['query timeout', 'syntax error', 'Column PKATTNAME does not exist', 'connection reset'])(
        'preserves genuine failures: %s', message => {
        expect(isForeignKeyCatalogUnavailable(new Error(message))).toBe(false);
    });

    const rows = [
        {
            FROM_DATABASE: 'SALES',
            FROM_SCHEMA: 'PUBLIC',
            FROM_TABLE: 'ORDERS',
            FROM_COLUMN: 'CUSTOMER_ID',
            TO_DATABASE: 'CRM',
            TO_SCHEMA: 'PUBLIC',
            TO_TABLE: 'CUSTOMERS',
            TO_COLUMN: 'ID',
            CONSTRAINT_NAME: 'FK_ORDER_CUSTOMER',
            ORDINAL_POSITION: 1,
        },
        {
            FROM_DATABASE: 'SALES',
            FROM_SCHEMA: 'PUBLIC',
            FROM_TABLE: 'ORDERS',
            FROM_COLUMN: 'CUSTOMER_REGION',
            TO_DATABASE: 'CRM',
            TO_SCHEMA: 'PUBLIC',
            TO_TABLE: 'CUSTOMERS',
            TO_COLUMN: 'REGION',
            CONSTRAINT_NAME: 'FK_ORDER_CUSTOMER',
            ORDINAL_POSITION: 2,
        },
        {
            FROM_DATABASE: 'SALES',
            FROM_SCHEMA: 'PUBLIC',
            FROM_TABLE: 'ORDERS',
            FROM_COLUMN: 'CUSTOMER_ID',
            TO_DATABASE: 'CRM',
            TO_SCHEMA: 'PUBLIC',
            TO_TABLE: 'CUSTOMERS',
            TO_COLUMN: 'ID',
            CONSTRAINT_NAME: 'FK_ORDER_CUSTOMER',
            ORDINAL_POSITION: 1,
        },
    ];

    it('normalizes, deduplicates, and orders composite FK column mappings', () => {
        expect(normalizeForeignKeyRelationshipRows(rows, 'OTHER')).toEqual([
            expect.objectContaining({ fromColumn: 'CUSTOMER_ID', ordinalPosition: 1 }),
            expect.objectContaining({ fromColumn: 'CUSTOMER_REGION', ordinalPosition: 2 }),
        ]);
    });

    it('uses the source database when the catalog omits the target database', () => {
        const [reference] = normalizeForeignKeyRelationshipRows([{
            FROM_SCHEMA: 'ADMIN  ',
            FROM_TABLE: 'CHILD  ',
            FROM_COLUMN: 'PARENT_ID  ',
            TO_SCHEMA: 'ADMIN  ',
            TO_TABLE: 'PARENT  ',
            TO_COLUMN: 'ID  ',
        }], 'SALES');
        expect(reference).toEqual(expect.objectContaining({
            fromDatabase: 'SALES',
            fromSchema: 'ADMIN',
            fromTable: 'CHILD',
            fromColumn: 'PARENT_ID',
            toDatabase: 'SALES',
            toSchema: 'ADMIN',
            toTable: 'PARENT',
            toColumn: 'ID',
        }));
    });

    it('matches exact catalog identity for source and referenced tables', () => {
        const references = normalizeForeignKeyRelationshipRows(rows, 'OTHER');
        expect(getForeignKeyReferencesForTable(references, {
            database: 'SALES', schema: 'PUBLIC', table: 'ORDERS',
        })).toHaveLength(2);
        expect(getForeignKeyReferencingTable(references, {
            database: 'CRM', schema: 'PUBLIC', table: 'CUSTOMERS',
        })).toHaveLength(2);
        expect(getForeignKeyReferencingTable(references, {
            database: 'CRM', schema: 'PUBLIC', table: 'Customers',
        })).toHaveLength(0);
    });
});
