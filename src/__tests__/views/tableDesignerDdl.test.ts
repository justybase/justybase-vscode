import { describe, expect, it } from '@jest/globals';
import {
    buildTableDesignerCreateSql,
    getTableDesignerContainerDisplay,
    getTableDesignerProfile,
    getTableDesignerUnsupportedReason,
    isTableDesignerSupported,
    type TableDesignerCreateInput,
} from '../../views/tableDesignerDdl';
import { UnsupportedDesignerOperationError } from '../../contracts/database';

function input(overrides: Partial<TableDesignerCreateInput> = {}): TableDesignerCreateInput {
    return {
        databaseKind: 'postgresql',
        dbName: 'sales',
        schemaName: 'public',
        tableName: 'orders',
        tableType: 'PERMANENT',
        ifNotExists: true,
        columns: [
            { name: 'id', type: 'BIGINT', length: '', notNull: true, pk: true, defaultValue: '' },
            { name: 'customer_name', type: 'VARCHAR', length: '120', notNull: false, pk: false, defaultValue: 'pending' },
        ],
        distributeColumns: [],
        organizeNone: false,
        organizeColumns: [],
        tableConstraints: [],
        ...overrides,
    };
}

describe('table designer DDL', () => {
    it('keeps Netezza-specific DISTRIBUTE and ORGANIZE clauses', () => {
        const ddl = buildTableDesignerCreateSql(input({
            databaseKind: 'netezza',
            dbName: 'SYSTEM',
            schemaName: 'ADMIN',
            distributeColumns: ['id'],
            organizeColumns: ['customer_name'],
        }));
        expect(ddl).toContain('CREATE TABLE IF NOT EXISTS SYSTEM.ADMIN."orders"');
        expect(ddl).toContain('DISTRIBUTE ON ("id")');
        expect(ddl).toContain('ORGANIZE ON ("customer_name")');

        const random = buildTableDesignerCreateSql(input({
            databaseKind: 'netezza',
            dbName: 'SYSTEM',
            schemaName: 'ADMIN',
            organizeNone: true,
        }));
        expect(random).toContain('DISTRIBUTE ON RANDOM');
        expect(random).toContain('ORGANIZE ON NONE');
    });

    it('emits ANSI PostgreSQL DDL without Netezza clauses', () => {
        const ddl = buildTableDesignerCreateSql(input());
        expect(ddl).toBe(
            'CREATE TABLE IF NOT EXISTS public.orders (\n'
            + '    id BIGINT NOT NULL,\n'
            + '    customer_name VARCHAR(120) DEFAULT \'pending\',\n'
            + '    PRIMARY KEY (id)\n'
            + ');',
        );
        expect(ddl).not.toContain('DISTRIBUTE');
        expect(ddl).not.toContain('ORGANIZE');
    });

    it('quotes reserved PostgreSQL identifiers', () => {
        const ddl = buildTableDesignerCreateSql(input({
            columns: [{ name: 'order', type: 'INTEGER', length: '', notNull: false, pk: false, defaultValue: '' }],
        }));
        expect(ddl).toContain('"order" INTEGER');
    });

    it('drops IF NOT EXISTS for Oracle and uses GLOBAL TEMPORARY with ON COMMIT PRESERVE ROWS', () => {
        const oracle = buildTableDesignerCreateSql(input({
            databaseKind: 'oracle',
            schemaName: 'APP',
            tableType: 'GLOBAL TEMP',
            columns: [{ name: 'id', type: 'NUMBER', length: '10,0', notNull: true, pk: true, defaultValue: '' }],
        }));
        expect(oracle).toBe(
            'CREATE GLOBAL TEMPORARY TABLE APP."orders" (\n'
            + '    "id" NUMBER(10,0) NOT NULL,\n'
            + '    PRIMARY KEY ("id")\n'
            + ') ON COMMIT PRESERVE ROWS;',
        );
        expect(oracle).not.toContain('IF NOT EXISTS');

        const permanent = buildTableDesignerCreateSql(input({
            databaseKind: 'oracle',
            schemaName: 'APP',
            tableType: 'PERMANENT',
            columns: [{ name: 'id', type: 'NUMBER', length: '', notNull: true, pk: true, defaultValue: '' }],
        }));
        expect(permanent).toContain('CREATE TABLE APP."orders"');
        expect(permanent).not.toContain('ON COMMIT');
    });

    it('uses #temp naming for SQL Server temporary tables without schema qualification', () => {
        const mssql = buildTableDesignerCreateSql(input({
            databaseKind: 'mssql',
            schemaName: 'dbo',
            tableType: 'TEMP',
            columns: [{ name: 'id', type: 'INT', length: '', notNull: true, pk: true, defaultValue: '' }],
        }));
        expect(mssql).toBe(
            'CREATE TABLE #orders (\n'
            + '    id INT NOT NULL,\n'
            + '    PRIMARY KEY (id)\n'
            + ');',
        );
        expect(mssql).not.toContain('IF NOT EXISTS');
        expect(mssql).not.toContain('dbo');
    });

    it('uses backtick quoting and TEMPORARY prefix for MySQL', () => {
        const mysql = buildTableDesignerCreateSql(input({
            databaseKind: 'mysql',
            schemaName: 'sales',
            tableType: 'TEMPORARY',
            columns: [{ name: 'select', type: 'INT', length: '', notNull: false, pk: false, defaultValue: '' }],
        }));
        expect(mysql).toBe(
            'CREATE TEMPORARY TABLE IF NOT EXISTS sales.orders (\n'
            + '    `select` INT\n'
            + ');',
        );
    });

    it('keeps SQLite catalog.table target paths and TEXT affinity', () => {
        const sqlite = buildTableDesignerCreateSql(input({
            databaseKind: 'sqlite',
            schemaName: 'main',
            columns: [{ name: 'note', type: 'TEXT', length: '', notNull: false, pk: false, defaultValue: '' }],
        }));
        expect(sqlite).toBe(
            'CREATE TABLE IF NOT EXISTS main.orders (\n'
            + '    note TEXT\n'
            + ');',
        );
    });

    it('hides IF NOT EXISTS for Db2', () => {
        const db2 = buildTableDesignerCreateSql(input({
            databaseKind: 'db2',
            schemaName: 'APP',
            columns: [{ name: 'id', type: 'INTEGER', length: '', notNull: true, pk: true, defaultValue: '' }],
        }));
        expect(db2).not.toContain('IF NOT EXISTS');
        expect(db2).toContain('CREATE TABLE APP."orders"');
    });

    it('generates plain ANSI DDL for Vertica, Snowflake, and DuckDB', () => {
        expect(buildTableDesignerCreateSql(input({ databaseKind: 'vertica', schemaName: 'public' }))).toContain('CREATE TABLE public.orders');
        expect(buildTableDesignerCreateSql(input({ databaseKind: 'snowflake', schemaName: 'PUBLIC' }))).toContain('CREATE TABLE IF NOT EXISTS "sales".PUBLIC."orders"');
        expect(buildTableDesignerCreateSql(input({ databaseKind: 'duckdb', schemaName: 'main' }))).toContain('CREATE TABLE IF NOT EXISTS main.orders');
        expect(buildTableDesignerCreateSql(input({ databaseKind: 'file', schemaName: undefined }))).toContain('CREATE TABLE IF NOT EXISTS orders');
    });

    it('rejects unsupported dialects with an actionable reason', () => {
        expect(isTableDesignerSupported('clickhouse')).toBe(false);
        expect(isTableDesignerSupported('access')).toBe(false);
        expect(getTableDesignerUnsupportedReason('clickhouse')).toContain('MergeTree');
        expect(getTableDesignerUnsupportedReason('access')).toContain('Access');
        expect(() => buildTableDesignerCreateSql(input({ databaseKind: 'clickhouse' }))).toThrow(UnsupportedDesignerOperationError);
        expect(() => buildTableDesignerCreateSql(input({ databaseKind: 'clickhouse' }))).toThrow('MergeTree');
        expect(() => buildTableDesignerCreateSql(input({ databaseKind: 'access' }))).toThrow('Access');
        expect(() => buildTableDesignerCreateSql(input({ databaseKind: 'mystery' }))).toThrow('mystery');
    });

    it('rejects table creation for a read-only runtime context', () => {
        expect(isTableDesignerSupported('sqlite', { readOnly: true, runtimeAvailable: true })).toBe(false);
        expect(getTableDesignerUnsupportedReason('sqlite', { readOnly: true, runtimeAvailable: true })).toContain('read-only');
        expect(() => buildTableDesignerCreateSql(input({
            databaseKind: 'sqlite',
            readOnly: true,
            runtimeAvailable: true,
        }))).toThrow(UnsupportedDesignerOperationError);
    });

    it('validates the design and rejects injectable column types', () => {
        expect(() => buildTableDesignerCreateSql(input({ tableName: '' }))).toThrow('table name');
        expect(() => buildTableDesignerCreateSql(input({ columns: [] }))).toThrow('at least one column');
        expect(() => buildTableDesignerCreateSql(input({
            columns: [{ name: '', type: 'INT', length: '', notNull: false, pk: false, defaultValue: '' }],
        }))).toThrow('name');
        expect(() => buildTableDesignerCreateSql(input({
            columns: [{ name: 'bad', type: 'INT; DROP TABLE x', length: '', notNull: false, pk: false, defaultValue: '' }],
        }))).toThrow('separators or comments');
    });

    it('renders function defaults without quoting and strings with quoting', () => {
        const ddl = buildTableDesignerCreateSql(input({
            columns: [
                { name: 'created_at', type: 'TIMESTAMP', length: '', notNull: false, pk: false, defaultValue: 'CURRENT_TIMESTAMP' },
                { name: 'note', type: 'VARCHAR', length: '10', notNull: false, pk: false, defaultValue: "it's" },
                { name: 'count', type: 'INTEGER', length: '', notNull: false, pk: false, defaultValue: '42' },
            ],
        }));
        expect(ddl).toContain('created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
        expect(ddl).toContain('note VARCHAR(10) DEFAULT \'it\'\'s\'');
        expect(ddl).toContain('count INTEGER DEFAULT 42');
    });

    it('exposes per-dialect profiles and container displays', () => {
        expect(getTableDesignerProfile('postgresql').supportsIfNotExists).toBe(true);
        expect(getTableDesignerProfile('postgresql').supportsDistribution).toBe(false);
        expect(getTableDesignerProfile('netezza').supportsOrganize).toBe(true);
        expect(getTableDesignerProfile('oracle').dataTypes).toContain('VARCHAR2');
        expect(getTableDesignerContainerDisplay('netezza', 'SYSTEM', undefined)).toBe('SYSTEM.ADMIN');
        expect(getTableDesignerContainerDisplay('mysql', 'sales', 'sales')).toBe('sales');
        expect(getTableDesignerContainerDisplay('sqlite', 'main.db', undefined)).toBe('main.db');
        expect(getTableDesignerContainerDisplay('postgresql', 'sales', 'public')).toBe('sales.public');
    });
});
