jest.mock('../../core/mcpConnectionFactory', () => ({
    createConnectedNetezzaConnectionFromDetails: jest.fn(),
    executeNetezzaDatabaseQuery: jest.fn(),
}));

import {
    createConnectedNetezzaConnectionFromDetails,
    executeNetezzaDatabaseQuery,
} from '../../core/mcpConnectionFactory';
import { CatalogIntrospection } from '../../core/catalogIntrospection';

describe('CatalogIntrospection SQL construction', () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const introspection = new CatalogIntrospection({
        getConnectionDetails: async () => ({
            host: 'nz.example.com',
            database: 'DWH',
            user: 'ADMIN',
            dbType: 'netezza',
        }),
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (createConnectedNetezzaConnectionFromDetails as jest.Mock).mockResolvedValue({ close });
        (executeNetezzaDatabaseQuery as jest.Mock).mockResolvedValue([]);
    });

    function lastSql(): string {
        const calls = (executeNetezzaDatabaseQuery as jest.Mock).mock.calls;
        return String(calls[calls.length - 1]?.[1] ?? '');
    }

    it('uses valid literals for schema filters', async () => {
        await introspection.getTables('DWH', 'ADMIN');
        expect(lastSql()).toContain("DATABASE = 'DWH'");
        expect(lastSql()).toContain("OWNER = 'ADMIN'");
        expect(lastSql()).not.toContain("''ADMIN''");

        await introspection.getProcedures('DWH', 'ADMIN');
        expect(lastSql()).toContain("OWNER = 'ADMIN'");

        await introspection.getViews('DWH', 'ADMIN');
        expect(lastSql()).toContain("OWNER = 'ADMIN'");
    });

    it('builds a valid contains LIKE literal for schema search', async () => {
        await introspection.searchSchema('ord', 'TABLES', 'DWH');
        expect(lastSql()).toContain("LIKE '%ORD%'");
        const malformedLike = "LIKE '%'ORD'%'";
        expect(lastSql()).not.toContain(malformedLike);
    });

    it('escapes table, schema, and database filter values', async () => {
        await introspection.getColumns(["DWH.ADMIN.ORD'ERS"]);
        const sql = lastSql();
        expect(sql).toContain("O.DBNAME = 'DWH'");
        expect(sql).toContain("O.OBJNAME = 'ORD''ERS'");
        expect(sql).toContain("O.SCHEMA = 'ADMIN'");
        expect(sql).not.toContain("ORD'ERS'");
    });

    it('supports DATABASE..TABLE notation for columns without an empty-schema predicate', async () => {
        await introspection.getColumns(['DWH..ORDERS']);
        const sql = lastSql();
        expect(sql).toContain('O.OBJNAME = \'ORDERS\'');
        expect(sql).not.toContain("O.SCHEMA = ''");
    });

    it('builds read-only catalog queries for the new metadata tools', async () => {
        (executeNetezzaDatabaseQuery as jest.Mock).mockImplementation(async (_connection, sql: string) => {
            if (sql.includes('_V_OBJECT_DATA') && sql.includes('SELECT SCHEMA')) {
                return [{ SCHEMA: 'ADMIN', OBJNAME: 'ORDERS', OBJTYPE: 'TABLE' }];
            }
            if (sql.includes('_V_RELATION_KEYDATA')) {
                return [{
                    SCHEMA: 'ADMIN',
                    RELATION: 'ORDERS',
                    CONSTRAINTNAME: 'PK_ORDERS',
                    CONTYPE: 'p',
                    ATTNAME: 'ID',
                    CONSEQ: 1
                }];
            }
            if (sql.includes('_V_TABLE_STORAGE_STAT')) {
                return [{ TBL_ROWS: 12, SKEW: 1, USED_BYTES: 1024 }];
            }
            return [];
        });

        const stats = await introspection.getTableStats('ORDERS');
        expect(JSON.parse(stats).tableName).toBe('ORDERS');
        expect(stats).toContain('Netezza catalog views');

        const comments = await introspection.getComments('ADMIN.ORDERS', undefined, undefined, false);
        expect(JSON.parse(comments).columns).toEqual([]);

        const constraints = await introspection.getTableConstraints('ADMIN.ORDERS');
        expect(JSON.parse(constraints).constraints[0].type).toBe('PRIMARY KEY');

        const dependencies = await introspection.getDependencies('ADMIN.ORDERS', undefined, 'TABLE');
        expect(JSON.parse(dependencies).target.objectType).toBe('TABLE');

        await introspection.getExternalTables('DWH', 'ADMIN', '%EXT%');
        expect(lastSql()).toContain('FROM "DWH".._V_EXTERNAL');
        expect(lastSql()).toContain("LIKE UPPER('%EXT%')");
        expect(lastSql()).not.toMatch(/INSERT|UPDATE|DELETE|CREATE|DROP/i);
    });

    it('rejects missing qualified objects and ambiguous unqualified objects', async () => {
        (executeNetezzaDatabaseQuery as jest.Mock).mockImplementation(async (_connection, sql: string) => {
            if (sql.includes("UPPER(OBJNAME) = UPPER('MISSING')")) {
                return [];
            }
            if (sql.includes("UPPER(OBJNAME) = UPPER('DUPLICATE')")) {
                return [
                    { SCHEMA: 'ADMIN', OBJNAME: 'DUPLICATE', OBJTYPE: 'TABLE' },
                    { SCHEMA: 'REPORTING', OBJNAME: 'DUPLICATE', OBJTYPE: 'TABLE' }
                ];
            }
            return [];
        });

        await expect(introspection.getTableStats('ADMIN.MISSING')).rejects.toThrow(/not found/i);
        await expect(introspection.getTableConstraints('DUPLICATE')).rejects.toThrow(/ambiguous/i);
    });

    it('preserves every referenced column in a composite foreign key', async () => {
        (executeNetezzaDatabaseQuery as jest.Mock).mockImplementation(async (_connection, sql: string) => {
            if (sql.includes('SELECT SCHEMA, OBJNAME, OBJTYPE')) {
                return [{ SCHEMA: 'ADMIN', OBJNAME: 'CHILD', OBJTYPE: 'TABLE' }];
            }
            if (sql.includes('_V_RELATION_KEYDATA')) {
                return [
                    {
                        SCHEMA: 'ADMIN',
                        RELATION: 'CHILD',
                        CONSTRAINTNAME: 'FK_CHILD_PARENT',
                        CONTYPE: 'f',
                        ATTNAME: 'PARENT_ID_1',
                        PKDATABASE: 'DWH',
                        PKSCHEMA: 'ADMIN',
                        PKRELATION: 'PARENT',
                        PKATTNAME: 'ID_1',
                        CONSEQ: 1
                    },
                    {
                        SCHEMA: 'ADMIN',
                        RELATION: 'CHILD',
                        CONSTRAINTNAME: 'FK_CHILD_PARENT',
                        CONTYPE: 'f',
                        ATTNAME: 'PARENT_ID_2',
                        PKDATABASE: 'DWH',
                        PKSCHEMA: 'ADMIN',
                        PKRELATION: 'PARENT',
                        PKATTNAME: 'ID_2',
                        CONSEQ: 2
                    }
                ];
            }
            return [];
        });

        const result = JSON.parse(await introspection.getTableConstraints('ADMIN.CHILD')) as {
            constraints: Array<{
                referenced: { columns: string[] };
                columnMappings: Array<{ columnName: string; referencedColumnName: string }>;
            }>;
        };
        expect(result.constraints[0].referenced.columns).toEqual(['ID_1', 'ID_2']);
        expect(result.constraints[0].columnMappings).toEqual([
            { columnName: 'PARENT_ID_1', referencedColumnName: 'ID_1' },
            { columnName: 'PARENT_ID_2', referencedColumnName: 'ID_2' }
        ]);
    });

    it('does not report dependencies from object-name substrings', async () => {
        (executeNetezzaDatabaseQuery as jest.Mock).mockImplementation(async (_connection, sql: string) => {
            if (sql.includes('SELECT SCHEMA, OBJNAME, OBJTYPE')) {
                return [{ SCHEMA: 'ADMIN', OBJNAME: 'ORDERS', OBJTYPE: 'TABLE' }];
            }
            if (sql.includes('_V_RELATION_KEYDATA')) {
                return [];
            }
            if (sql.includes('_V_VIEW')) {
                return [
                    {
                        SCHEMA: 'ADMIN',
                        VIEWNAME: 'V_ARCHIVE',
                        OWNER: 'ADMIN',
                        DEFINITION: 'SELECT * FROM ADMIN.ORDERS_ARCHIVE'
                    },
                    {
                        SCHEMA: 'ADMIN',
                        VIEWNAME: 'V_EXACT',
                        OWNER: 'ADMIN',
                        DEFINITION: 'SELECT * FROM ADMIN.ORDERS'
                    }
                ];
            }
            if (sql.includes('_V_PROCEDURE')) {
                return [];
            }
            return [];
        });

        const result = JSON.parse(await introspection.getDependencies('ADMIN.ORDERS', undefined, 'TABLE')) as {
            dependencies: Array<{ VIEWNAME?: string }>;
        };
        expect(result.dependencies.map(item => item.VIEWNAME)).toEqual(['V_EXACT']);
    });
});
