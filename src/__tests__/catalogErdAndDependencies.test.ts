jest.mock('vscode', () => ({}), { virtual: true });

import { buildERDDataFromCatalogRows } from '../schema/erdProvider';
import { catalogDependencyEdges } from '../services/analysis/databaseAnalysisService';
import { DependencyIndex } from '../services/analysis/dependencyIndex';

describe('catalog-based ERD', () => {
    it('groups FK columns per constraint in ordinal order and flags PK/FK columns', () => {
        const erd = buildERDDataFromCatalogRows('shop', 'public',
            [{ OBJNAME: 'orders', SCHEMA: 'public' }, { OBJNAME: 'customers', SCHEMA: 'public' }, { OBJNAME: 'other', SCHEMA: 'audit' }],
            [
                { TABLENAME: 'orders', SCHEMA: 'public', ATTNAME: 'id', FORMAT_TYPE: 'integer', IS_PK: 1 },
                { TABLENAME: 'orders', SCHEMA: 'public', ATTNAME: 'cust_region', FORMAT_TYPE: 'text', IS_PK: 0 },
                { TABLENAME: 'orders', SCHEMA: 'public', ATTNAME: 'cust_no', FORMAT_TYPE: 'integer', IS_PK: '0' },
                { TABLE_NAME: 'customers', SCHEMA_NAME: 'public', COLUMN_NAME: 'region', DATA_TYPE: 'text', IS_PK: true },
                { TABLE_NAME: 'customers', SCHEMA_NAME: 'public', COLUMN_NAME: 'no', DATA_TYPE: 'int', IS_PK: 'Y' },
            ],
            [
                { FROM_SCHEMA: 'public', FROM_TABLE: 'orders', FROM_COLUMN: 'cust_no', TO_SCHEMA: 'public', TO_TABLE: 'customers', TO_COLUMN: 'no', CONSTRAINT_NAME: 'fk_cust', ORDINAL_POSITION: 2 },
                { FROM_SCHEMA: 'public', FROM_TABLE: 'orders', FROM_COLUMN: 'cust_region', TO_SCHEMA: 'public', TO_TABLE: 'customers', TO_COLUMN: 'region', CONSTRAINT_NAME: 'fk_cust', ORDINAL_POSITION: 1 },
            ]);
        expect(erd.tables.map(t => t.tableName)).toEqual(['orders', 'customers']);
        expect(erd.relationships).toEqual([expect.objectContaining({
            constraintName: 'fk_cust', fromTable: 'public.orders', toTable: 'public.customers',
            fromColumns: ['cust_region', 'cust_no'], toColumns: ['region', 'no'],
        })]);
        expect(erd.tables[1].primaryKeyColumns).toEqual(['region', 'no']);
        expect(erd.tables[0].columns.filter(c => c.isForeignKey).map(c => c.name)).toEqual(['cust_region', 'cust_no']);
    });
});

describe('catalog dependency edges', () => {
    const rows = [
        { SOURCE_SCHEMA: 'HR', SOURCE_NAME: 'V_EMP', SOURCE_TYPE: 'VIEW', TARGET_SCHEMA: 'HR', TARGET_NAME: 'EMP', TARGET_TYPE: 'TABLE', TARGET_COLUMN: 'SALARY' },
        { SOURCE_SCHEMA: 'HR', SOURCE_NAME: 'V_EMP', SOURCE_TYPE: 'VIEW', TARGET_SCHEMA: 'HR', TARGET_NAME: 'EMP', TARGET_TYPE: 'TABLE', TARGET_COLUMN: 'ID' },
        { SOURCE_SCHEMA: 'HR', SOURCE_NAME: 'P_PAY', SOURCE_TYPE: 'PROCEDURE', TARGET_SCHEMA: 'HR', TARGET_NAME: 'V_EMP', TARGET_TYPE: 'VIEW', TARGET_COLUMN: null },
    ];

    it('merges column evidence per pair and marks pairs without columns as wildcards', () => {
        const { edges, objects } = catalogDependencyEdges('ORCL', rows);
        expect(objects).toHaveLength(3);
        expect(edges[0].evidence.map(e => e.column)).toEqual(['SALARY', 'ID']);
        expect(edges[1].evidence).toEqual([expect.objectContaining({ kind: 'wildcard' })]);
    });

    it('drives Used By and column-filtered impact reports', async () => {
        const { edges, objects } = catalogDependencyEdges('ORCL', rows);
        const index = new DependencyIndex();
        await index.update([], objects, () => false, edges);
        const root = { database: 'ORCL', schema: 'HR', name: 'EMP', type: 'TABLE' as const };
        expect(index.getReport(root, 'incoming', 3).affected.map(a => `${a.object.name}@${a.depth}`)).toEqual(['V_EMP@1', 'P_PAY@2']);
        expect(index.getReport(root, 'incoming', 1, 'SALARY').affected.map(a => a.object.name)).toEqual(['V_EMP']);
        expect(index.getReport(root, 'incoming', 1, 'NAME').affected).toEqual([]);
        const impact = index.getReport(root, 'incoming', 2, undefined, 300, { kind: 'dropColumn', column: 'SALARY' });
        expect(impact.affected[0]).toMatchObject({ severity: 'high' });
    });
});
