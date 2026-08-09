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
});
