import { getColumns, getDistributionInfo, getKeysInfo, getOrganizeInfo } from '../ddlGenerator';
import { getRequiredDatabaseDdlProvider } from '../core/connectionFactory';
import { compareProcedures, compareTableStructures, KeyInfo } from '../schema/schemaComparer';
import { ConnectionDetails, NzConnection, NzDataReader } from '../types';

jest.mock('../ddlGenerator', () => ({
    getColumns: jest.fn(),
    getKeysInfo: jest.fn(),
    getDistributionInfo: jest.fn(),
    getOrganizeInfo: jest.fn()
}));

jest.mock('../core/connectionFactory', () => {
    const actual = jest.requireActual('../core/connectionFactory');
    return {
        ...actual,
        getRequiredDatabaseDdlProvider: jest.fn()
    };
});

const mockNzConnectionConstructor = jest.fn();

jest.mock('@justybase/netezza-driver', () => ({
    NzConnection: mockNzConnectionConstructor
}));

const getColumnsMock = getColumns as unknown as jest.Mock;
const getKeysInfoMock = getKeysInfo as unknown as jest.Mock;
const getDistributionInfoMock = getDistributionInfo as unknown as jest.Mock;
const getOrganizeInfoMock = getOrganizeInfo as unknown as jest.Mock;
const getRequiredDatabaseDdlProviderMock = getRequiredDatabaseDdlProvider as unknown as jest.Mock;

const connectionDetails: ConnectionDetails = {
    host: 'localhost',
    port: 5480,
    database: 'MASTERDB',
    user: 'admin',
    password: 'secret'
};

const createKey = (
    type: string,
    columns: string[],
    overrides: Partial<KeyInfo> = {}
): KeyInfo => ({
    type,
    typeChar: type === 'PRIMARY KEY' ? 'p' : 'f',
    columns,
    pkDatabase: overrides.pkDatabase ?? null,
    pkSchema: overrides.pkSchema ?? null,
    pkRelation: overrides.pkRelation ?? null,
    pkColumns: overrides.pkColumns ?? [],
    updateType: overrides.updateType ?? 'NO ACTION',
    deleteType: overrides.deleteType ?? 'NO ACTION'
});

const createReader = (rows: Record<string, unknown>[]): NzDataReader => {
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    let currentIndex = -1;

    return {
        fieldCount: columns.length,
        read: jest.fn().mockImplementation(async () => {
            currentIndex += 1;
            return currentIndex < rows.length;
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockResolvedValue(undefined),
        getName: jest.fn((index: number) => columns[index]),
        getTypeName: jest.fn().mockReturnValue('VARCHAR'),
        getValue: jest.fn((index: number) => rows[currentIndex]?.[columns[index]])
    };
};

const createConnectionWithReaders = (rowsPerQuery: Record<string, unknown>[][]): jest.Mocked<NzConnection> => {
    const readers = [...rowsPerQuery];
    return {
        connect: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        createCommand: jest.fn().mockImplementation((_sql: string) => ({
            executeReader: jest.fn().mockResolvedValue(createReader(readers.shift() || []))
        })),
        on: jest.fn(),
        removeListener: jest.fn()
    } as unknown as jest.Mocked<NzConnection>;
};

describe('schemaComparer', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getRequiredDatabaseDdlProviderMock.mockReturnValue({
            getColumns: getColumnsMock,
            getKeysInfo: getKeysInfoMock,
            getDistributionInfo: getDistributionInfoMock,
            getOrganizeInfo: getOrganizeInfoMock
        });
    });

    describe('compareTableStructures', () => {
        it('compares source and target tables with detailed diffs', async () => {
            const mockConnection = createConnectionWithReaders([]);
            mockNzConnectionConstructor.mockImplementation(() => mockConnection);

            getColumnsMock
                .mockResolvedValueOnce([
                    { name: 'ID', fullTypeName: 'INTEGER', notNull: true, defaultValue: null, description: null },
                    { name: 'NAME', fullTypeName: 'VARCHAR(100)', notNull: false, defaultValue: null, description: null }
                ])
                .mockResolvedValueOnce([
                    { name: 'ID', fullTypeName: 'BIGINT', notNull: true, defaultValue: null, description: null },
                    { name: 'EMAIL', fullTypeName: 'VARCHAR(255)', notNull: false, defaultValue: null, description: null }
                ]);
            getKeysInfoMock
                .mockResolvedValueOnce(
                    new Map<string, KeyInfo>([
                        ['PK_USERS', createKey('PRIMARY KEY', ['ID'])],
                        ['FK_USERS_ORG', createKey('FOREIGN KEY', ['ORG_ID'], { pkRelation: 'ORG', pkColumns: ['ID'] })]
                    ])
                )
                .mockResolvedValueOnce(
                    new Map<string, KeyInfo>([
                        ['PK_USERS', createKey('PRIMARY KEY', ['ID', 'EMAIL'])],
                        ['FK_USERS_ROLE', createKey('FOREIGN KEY', ['ROLE_ID'], { pkRelation: 'ROLE', pkColumns: ['ID'] })]
                    ])
                );
            getDistributionInfoMock.mockResolvedValueOnce(['ID']).mockResolvedValueOnce(['EMAIL']);
            getOrganizeInfoMock.mockResolvedValueOnce(['NAME']).mockResolvedValueOnce(['NAME']);

            const result = await compareTableStructures(
                connectionDetails,
                'SRC_DB',
                'PUBLIC',
                'USERS',
                'TRG_DB',
                'PUBLIC',
                'USERS'
            );

            expect(result.source.database).toBe('SRC_DB');
            expect(result.target.database).toBe('TRG_DB');
            expect(result.summary.columnsAdded).toBe(1);
            expect(result.summary.columnsRemoved).toBe(1);
            expect(result.summary.columnsModified).toBe(1);
            expect(result.summary.columnsUnchanged).toBe(0);
            expect(result.summary.keysAdded).toBe(1);
            expect(result.summary.keysRemoved).toBe(1);
            expect(result.summary.keysModified).toBe(1);
            expect(result.distributionMatch).toBe(false);
            expect(result.organizationMatch).toBe(true);
            expect(result.columnDiffs.some(diff => diff.status === 'modified' && diff.name === 'ID')).toBe(true);
            expect(result.keyDiffs.some(diff => diff.status === 'modified' && diff.name === 'PK_USERS')).toBe(true);
            expect(mockConnection.connect).toHaveBeenCalled();
            expect(mockConnection.close).toHaveBeenCalled();
        });

        it('always closes connection when comparison fails', async () => {
            const mockConnection = createConnectionWithReaders([]);
            mockNzConnectionConstructor.mockImplementation(() => mockConnection);
            getColumnsMock.mockRejectedValueOnce(new Error('metadata failure'));

            await expect(
                compareTableStructures(connectionDetails, 'A', 'S', 'T1', 'B', 'S', 'T2')
            ).rejects.toThrow('metadata failure');

            expect(mockConnection.close).toHaveBeenCalled();
        });
    });

    describe('compareProcedures', () => {
        it('returns match summary when procedures are equivalent', async () => {
            const sourceProcRow = [
                {
                    PROCEDURE: 'PROC_A',
                    PROCEDURESIGNATURE: 'PROC_A(INT)',
                    ARGUMENTS: 'P_ID INT',
                    RETURNS: 'INT',
                    EXECUTEDASOWNER: 1,
                    PROCEDURESOURCE: 'BEGIN\nRETURN 1;\nEND;',
                    DESCRIPTION: 'source'
                }
            ];
            const targetProcRow = [
                {
                    PROCEDURE: 'PROC_A',
                    PROCEDURESIGNATURE: 'PROC_A(INT)',
                    ARGUMENTS: 'P_ID INT',
                    RETURNS: 'INT',
                    EXECUTEDASOWNER: 1,
                    PROCEDURESOURCE: 'BEGIN\nRETURN 1;\nEND;',
                    DESCRIPTION: 'target'
                }
            ];
            const mockConnection = createConnectionWithReaders([sourceProcRow, targetProcRow]);
            mockNzConnectionConstructor.mockImplementation(() => mockConnection);

            const result = await compareProcedures(
                connectionDetails,
                'DB1',
                'PUBLIC',
                'PROC_A(INT)',
                'DB2',
                'PUBLIC',
                'PROC_A(INT)'
            );

            expect(result.argumentsMatch).toBe(true);
            expect(result.returnsMatch).toBe(true);
            expect(result.executeAsOwnerMatch).toBe(true);
            expect(result.sourceMatch).toBe(true);
            expect(result.sourceDiff).toEqual([]);
            expect(mockConnection.createCommand).toHaveBeenCalledTimes(2);
            expect(mockConnection.close).toHaveBeenCalled();
        });

        it('returns diff when procedures differ', async () => {
            const sourceProcRow = [
                {
                    PROCEDURE: 'PROC_B',
                    PROCEDURESIGNATURE: 'PROC_B(INT)',
                    ARGUMENTS: 'P_ID INT',
                    RETURNS: 'INT',
                    EXECUTEDASOWNER: 1,
                    PROCEDURESOURCE: 'BEGIN\nRETURN 1;\nEND;',
                    DESCRIPTION: 'source'
                }
            ];
            const targetProcRow = [
                {
                    PROCEDURE: 'PROC_B',
                    PROCEDURESIGNATURE: 'PROC_B(INT)',
                    ARGUMENTS: 'P_ID BIGINT',
                    RETURNS: 'VARCHAR(10)',
                    EXECUTEDASOWNER: 0,
                    PROCEDURESOURCE: 'BEGIN\nRETURN \'OK\';\nEND;',
                    DESCRIPTION: 'target'
                }
            ];
            const mockConnection = createConnectionWithReaders([sourceProcRow, targetProcRow]);
            mockNzConnectionConstructor.mockImplementation(() => mockConnection);

            const result = await compareProcedures(
                connectionDetails,
                'DB1',
                'PUBLIC',
                'PROC_B(INT)',
                'DB2',
                'PUBLIC',
                'PROC_B(INT)'
            );

            expect(result.argumentsMatch).toBe(false);
            expect(result.returnsMatch).toBe(false);
            expect(result.executeAsOwnerMatch).toBe(false);
            expect(result.sourceMatch).toBe(false);
            expect(result.sourceDiff.some(line => line.startsWith('- '))).toBe(true);
            expect(result.sourceDiff.some(line => line.startsWith('+ '))).toBe(true);
        });

        it('throws when procedure metadata is missing and still closes connection', async () => {
            const mockConnection = createConnectionWithReaders([[]]);
            mockNzConnectionConstructor.mockImplementation(() => mockConnection);

            await expect(
                compareProcedures(
                    connectionDetails,
                    'DB1',
                    'PUBLIC',
                    'MISSING_PROC()',
                    'DB2',
                    'PUBLIC',
                    'MISSING_PROC()'
                )
            ).rejects.toThrow('not found');

            expect(mockConnection.close).toHaveBeenCalled();
        });
    });
});
