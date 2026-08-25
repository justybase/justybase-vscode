import {
    buildNetezzaColumnsWithKeysQueries,
    loadNetezzaColumnsWithKeysRows,
    mergeNetezzaColumnsWithKeysRows,
} from '../dialects/netezza/metadata/columnsWithKeys';

describe('Netezza columns-with-keys in-memory merge', () => {
    it('reproduces LEFT JOIN, MAX, GROUP BY and ORDER BY semantics', () => {
        const columns = [
            {
                OBJID: 2,
                TABLENAME: 'BETA',
                SCHEMA: 'S2',
                DBNAME: 'DB1',
                ATTNAME: 'VALUE',
                FORMAT_TYPE: 'VARCHAR(10)',
                ATTNUM: '2',
                DESCRIPTION: '',
            },
            {
                OBJID: 1,
                TABLENAME: 'ALPHA',
                SCHEMA: 'S1',
                DBNAME: 'DB1',
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INTEGER',
                ATTNUM: 2,
                DESCRIPTION: 'identifier',
            },
            {
                OBJID: 3,
                TABLENAME: 'ALPHA',
                SCHEMA: 'S1',
                DBNAME: 'DB1',
                ATTNAME: 'NAME',
                FORMAT_TYPE: 'VARCHAR(30)',
                ATTNUM: 1,
                DESCRIPTION: null,
            },
            // Same projected GROUP BY values with a different object id. The
            // legacy SQL collapses these rows and takes MAX across both joins.
            {
                OBJID: 9,
                TABLENAME: 'ALPHA',
                SCHEMA: 'S1',
                DBNAME: 'DB1',
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INTEGER',
                ATTNUM: 2,
                DESCRIPTION: 'identifier',
            },
        ];
        const keys = [
            { OBJID: '1', ATTNAME: 'ID   ', CONTYPE: 'p ' },
            { OBJID: 9, ATTNAME: 'ID', CONTYPE: 'f' },
            { OBJID: 2, ATTNAME: 'VALUE', CONTYPE: 'u' },
            { OBJID: 99, ATTNAME: 'ID', CONTYPE: 'p' },
        ];
        const distribution = [
            { OBJID: '1', ATTNAME: 'ID' },
            { OBJID: 2, ATTNAME: 'VALUE' },
        ];

        expect(mergeNetezzaColumnsWithKeysRows(columns, keys, distribution)).toEqual([
            {
                TABLENAME: 'ALPHA',
                SCHEMA: 'S1',
                DBNAME: 'DB1',
                ATTNAME: 'NAME',
                FORMAT_TYPE: 'VARCHAR(30)',
                ATTNUM: 1,
                DESCRIPTION: null,
                IS_PK: 0,
                IS_FK: 0,
                IS_DISTRIBUTION_KEY: 0,
            },
            {
                TABLENAME: 'ALPHA',
                SCHEMA: 'S1',
                DBNAME: 'DB1',
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INTEGER',
                ATTNUM: 2,
                DESCRIPTION: 'identifier',
                IS_PK: 1,
                IS_FK: 1,
                IS_DISTRIBUTION_KEY: 1,
            },
            {
                TABLENAME: 'BETA',
                SCHEMA: 'S2',
                DBNAME: 'DB1',
                ATTNAME: 'VALUE',
                FORMAT_TYPE: 'VARCHAR(10)',
                ATTNUM: '2',
                DESCRIPTION: '',
                IS_PK: 0,
                IS_FK: 0,
                IS_DISTRIBUTION_KEY: 1,
            },
        ]);
    });

    it('executes the three scans serially in the required order', async () => {
        const queries = buildNetezzaColumnsWithKeysQueries('DB1');
        const roles: string[] = [];

        const rows = await loadNetezzaColumnsWithKeysRows(
            queries,
            async (_sql, role) => {
                roles.push(role);
                if (role === 'columns') {
                    return [{
                        OBJID: 1,
                        TABLENAME: 'T1',
                        SCHEMA: 'S1',
                        DBNAME: 'DB1',
                        ATTNAME: 'ID',
                        FORMAT_TYPE: 'INTEGER',
                        ATTNUM: 1,
                        DESCRIPTION: '',
                    }];
                }
                if (role === 'keys') {
                    return [{ OBJID: 1, ATTNAME: 'ID', CONTYPE: 'p' }];
                }
                return [];
            },
        );

        expect(roles).toEqual(['columns', 'keys', 'distribution']);
        expect(rows).toEqual([
            expect.objectContaining({ ATTNAME: 'ID', IS_PK: 1, IS_FK: 0 }),
        ]);
    });

    it('stops atomically when an auxiliary scan fails', async () => {
        const queries = buildNetezzaColumnsWithKeysQueries('DB1');
        const roles: string[] = [];

        await expect(loadNetezzaColumnsWithKeysRows(
            queries,
            async (_sql, role) => {
                roles.push(role);
                if (role === 'keys') {
                    throw new Error('key catalog unavailable');
                }
                return [];
            },
        )).rejects.toThrow('key catalog unavailable');
        expect(roles).toEqual(['columns', 'keys']);
    });
});
