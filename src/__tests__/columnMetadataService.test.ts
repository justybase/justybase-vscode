import { QueryResult } from '../types';
import {
    groupCanonicalColumnsByTable,
    mapColumnsWithKeysRows,
    mapTableColumnsRows,
    mergeForeignKeyReferencesIntoColumnRows,
    normalizeBooleanFlag,
    parseColumnsWithKeysResult,
    toCacheColumnMetadata
} from '../metadata/columnMetadataService';

describe('columnMetadataService', () => {
    it('normalizes boolean-like flags', () => {
        expect(normalizeBooleanFlag(true)).toBe(true);
        expect(normalizeBooleanFlag(1)).toBe(true);
        expect(normalizeBooleanFlag('t')).toBe(true);
        expect(normalizeBooleanFlag('yes')).toBe(true);
        expect(normalizeBooleanFlag('on')).toBe(true);
        expect(normalizeBooleanFlag(false)).toBe(false);
        expect(normalizeBooleanFlag(0)).toBe(false);
        expect(normalizeBooleanFlag('f')).toBe(false);
        expect(normalizeBooleanFlag(undefined)).toBe(false);
    });

    it('parses structured query result rows for columns with keys', () => {
        const result: QueryResult = {
            columns: [
                { name: 'DBNAME' },
                { name: 'SCHEMA' },
                { name: 'TABLENAME' },
                { name: 'ATTNAME' },
                { name: 'FORMAT_TYPE' },
                { name: 'ATTNUM' },
                { name: 'DESCRIPTION' },
                { name: 'IS_PK' },
                { name: 'IS_FK' }
            ],
            data: [
                ['DB1', 'ADMIN', 'ORDERS', 'ID', 'INT', 1, 'identifier', 1, 0],
                ['DB1', 'ADMIN', 'ORDERS', 'CUSTOMER_ID', 'INT', 2, 'fk to customer', 0, 1]
            ]
        };

        const parsed = parseColumnsWithKeysResult(result);
        const grouped = groupCanonicalColumnsByTable(parsed);

        expect(parsed).toHaveLength(2);
        expect(grouped).toHaveLength(1);
        expect(grouped[0].tableName).toBe('ORDERS');
        expect(grouped[0].columns.map(c => c.columnName)).toEqual(['ID', 'CUSTOMER_ID']);

        const first = toCacheColumnMetadata(grouped[0].columns[0]);
        expect(first).toEqual(
            expect.objectContaining({
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INT',
                isPk: true,
                isFk: false
            })
        );
    });

    it('maps table-column rows with ATTNOTNULL variants', () => {
        const mapped = mapTableColumnsRows(
            [
                { ATTNAME: 'C1', FULL_TYPE: 'INT', ATTNOTNULL: true, COLDEFAULT: null, DESCRIPTION: '', ATTNUM: 1 },
                { ATTNAME: 'C2', FULL_TYPE: 'INT', ATTNOTNULL: 1, COLDEFAULT: '', DESCRIPTION: '', ATTNUM: 2 },
                { ATTNAME: 'C3', FULL_TYPE: 'INT', ATTNOTNULL: 't', COLDEFAULT: '0', DESCRIPTION: '', ATTNUM: 3 },
                { ATTNAME: 'C4', FULL_TYPE: 'INT', ATTNOTNULL: 'yes', COLDEFAULT: null, DESCRIPTION: '', ATTNUM: 4 }
            ],
            { database: 'db1', schema: 'admin', tableName: 'orders' }
        );

        expect(mapped).toHaveLength(4);
        expect(mapped.every(c => c.isNotNull)).toBe(true);
        expect(mapped[2].defaultValue).toBe('0');
        expect(mapped[0].tableName).toBe('ORDERS');
    });

    it('keeps copilot and ddl column lists aligned for same table', () => {
        const copilotColumns = mapColumnsWithKeysRows([
            { DBNAME: 'DB1', SCHEMA: 'ADMIN', TABLENAME: 'ORDERS', ATTNAME: 'ID', FORMAT_TYPE: 'INT', ATTNUM: 1 },
            { DBNAME: 'DB1', SCHEMA: 'ADMIN', TABLENAME: 'ORDERS', ATTNAME: 'NAME', FORMAT_TYPE: 'VARCHAR(10)', ATTNUM: 2 }
        ]);
        const ddlColumns = mapTableColumnsRows(
            [
                { ATTNAME: 'ID', FULL_TYPE: 'INT', ATTNOTNULL: true, ATTNUM: 1 },
                { ATTNAME: 'NAME', FULL_TYPE: 'VARCHAR(10)', ATTNOTNULL: false, ATTNUM: 2 }
            ],
            { database: 'DB1', schema: 'ADMIN', tableName: 'ORDERS' }
        );

        expect(copilotColumns.map(c => c.columnName)).toEqual(ddlColumns.map(c => c.columnName));
    });

    it('attaches exact catalog FK endpoint pairs to source columns', () => {
        const rows = [
            { DBNAME: 'DB1', SCHEMA: 'APP', TABLENAME: 'LINE_ITEM', ATTNAME: 'TENANT_ID', FORMAT_TYPE: 'INT' },
            { DBNAME: 'DB1', SCHEMA: 'APP', TABLENAME: 'LINE_ITEM', ATTNAME: 'CUSTOMER_ID', FORMAT_TYPE: 'INT' },
        ];
        mergeForeignKeyReferencesIntoColumnRows(rows, [
            {
                FROM_DATABASE: 'DB1', FROM_SCHEMA: 'APP', FROM_TABLE: 'LINE_ITEM', FROM_COLUMN: 'TENANT_ID',
                TO_DATABASE: 'DB1', TO_SCHEMA: 'APP', TO_TABLE: 'CUSTOMER', TO_COLUMN: 'TENANT_KEY',
                CONSTRAINT_NAME: 'FK_LINE_CUSTOMER', ORDINAL_POSITION: 1,
            },
            {
                FROM_DATABASE: 'DB1', FROM_SCHEMA: 'APP', FROM_TABLE: 'LINE_ITEM', FROM_COLUMN: 'CUSTOMER_ID',
                TO_DATABASE: 'DB1', TO_SCHEMA: 'APP', TO_TABLE: 'CUSTOMER', TO_COLUMN: 'CUSTOMER_KEY',
                CONSTRAINT_NAME: 'FK_LINE_CUSTOMER', ORDINAL_POSITION: 2,
            },
        ], 'DB1');

        const parsed = mapColumnsWithKeysRows(rows);
        expect(parsed[0].joinReferences).toEqual([expect.objectContaining({
            toTable: 'CUSTOMER', toColumn: 'TENANT_KEY', constraintName: 'FK_LINE_CUSTOMER', ordinalPosition: 1,
        })]);
        expect(toCacheColumnMetadata(parsed[1]).joinReferences).toEqual([expect.objectContaining({
            toColumn: 'CUSTOMER_KEY', ordinalPosition: 2,
        })]);
    });
});
