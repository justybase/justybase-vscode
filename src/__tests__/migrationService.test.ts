import type { DatabaseConnection, DatabaseDataReader } from '../contracts/database';
import type { ConnectionDetails } from '../types';
import { MigrationService } from '../migration/migrationService';
import type { MigrationPlan, MigrationRequest } from '../migration/types';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { writeToTarget } from '../migration/targetWriter';

jest.mock('../core/connectionFactory', () => ({
    createConnectedDatabaseConnectionFromDetails: jest.fn(),
    getRequiredDatabaseDdlProvider: jest.fn(),
}));

jest.mock('../migration/targetWriter', () => ({
    writeToTarget: jest.fn(),
}));

function createReader(value: unknown, hasRow = true, typeName = 'NUMBER'): DatabaseDataReader {
    return {
        read: jest.fn().mockResolvedValue(hasRow),
        fieldCount: 1,
        getName: jest.fn().mockReturnValue('ID'),
        getValue: jest.fn().mockReturnValue(value),
        getTypeName: jest.fn().mockReturnValue(typeName),
        close: jest.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseDataReader;
}

function createConnection(commandSql: string[]): DatabaseConnection {
    return {
        createCommand: jest.fn((sql: string) => {
            commandSql.push(sql);
            if (sql.includes('__mig_src')) {
                throw new Error('ORA-00911: invalid character');
            }
            const isCount = sql.startsWith('SELECT COUNT(*)');
            return {
                commandTimeout: 0,
                executeReader: jest.fn().mockResolvedValue(createReader(isCount ? 1 : 42)),
            };
        }),
        close: jest.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseConnection;
}

const oracleDetails: ConnectionDetails = {
    name: 'oracle-source',
    host: 'oracle.example.test',
    port: 1521,
    database: 'ORCL',
    user: 'TESTUSER',
    password: 'secret',
    dbType: 'oracle',
};

const request: MigrationRequest = {
    source: {
        mode: 'sql',
        connectionName: 'oracle-source',
        sql: 'SELECT * FROM TESTUSER.SALES;',
    },
    target: {
        connectionName: 'netezza-target',
        database: 'JUST_DATA',
        schema: 'ADMIN',
        table: 'SALES_COPY',
        appendToExistingTable: false,
    },
    sampleSize: 1,
};

describe('MigrationService source SQL execution', () => {
    const createConnectionMock = jest.mocked(createConnectedDatabaseConnectionFromDetails);
    const writeToTargetMock = jest.mocked(writeToTarget);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('uses Oracle-compatible SQL during analysis and row counting', async () => {
        const commandSql: string[] = [];
        const connection = createConnection(commandSql);
        createConnectionMock.mockResolvedValue(connection);

        const service = new MigrationService({
            connectionManager: {
                getConnection: jest.fn().mockResolvedValue(oracleDetails),
                getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            },
        });

        const analysis = await service.analyzeSource(request);
        const totalRows = await service.countSourceRows(request, analysis.sourceContext);

        expect(totalRows).toBe(1);
        expect(commandSql).toEqual([
            'SELECT * FROM TESTUSER.SALES',
            'SELECT COUNT(*) FROM (\nSELECT * FROM TESTUSER.SALES\n) MIG_SRC',
        ]);
        expect(commandSql.every(sql => !sql.includes('__mig_src'))).toBe(true);
    });

    it('does not count automatically during the streaming phase', async () => {
        const commandSql: string[] = [];
        const connection = createConnection(commandSql);
        createConnectionMock.mockResolvedValue(connection);
        writeToTargetMock.mockResolvedValue({
            planOnly: false,
            rowsInserted: 1,
        });

        const service = new MigrationService({
            connectionManager: {
                getConnection: jest.fn()
                    .mockResolvedValueOnce(oracleDetails)
                    .mockResolvedValueOnce({
                        name: 'netezza-target',
                        host: 'netezza.example.test',
                        database: 'JUST_DATA',
                        user: 'ADMIN',
                        dbType: 'netezza',
                    }),
                getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            },
        });

        const sourceContext = {
            kind: 'oracle' as const,
            connectionDetails: oracleDetails,
        };
        const plan: MigrationPlan = {
            sourceKind: 'oracle',
            targetKind: 'netezza',
            sourceMode: 'sql',
            columns: [],
            createTableDdl: 'CREATE TABLE ADMIN.SALES_COPY (ID INT)',
            warnings: [],
            targetQualifiedName: 'JUST_DATA.ADMIN.SALES_COPY',
        };

        const result = await service.execute(request, plan, sourceContext);

        expect(result.success).toBe(true);
        expect(commandSql).toEqual([
            'SELECT * FROM TESTUSER.SALES',
        ]);
    });

    it('uses complete result metadata without reading a sample row', async () => {
        const reader = createReader(42, true, 'NUMBER(10,2)');
        const commandSql: string[] = [];
        const connection = {
            createCommand: jest.fn((sql: string) => {
                commandSql.push(sql);
                return {
                    commandTimeout: 0,
                    executeReader: jest.fn().mockResolvedValue(reader),
                };
            }),
            close: jest.fn().mockResolvedValue(undefined),
        } as unknown as DatabaseConnection;
        createConnectionMock.mockResolvedValue(connection);

        const service = new MigrationService({
            connectionManager: {
                getConnection: jest.fn().mockResolvedValue(oracleDetails),
                getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            },
        });

        const analysis = await service.analyzeSource(request);

        expect(commandSql).toEqual(['SELECT * FROM TESTUSER.SALES']);
        expect(reader.read).not.toHaveBeenCalled();
        expect(analysis.sampleCells).toBeUndefined();
        expect(analysis.columns[0]).toMatchObject({
            driverType: 'NUMBER(10,2)',
            requiresValueSampling: false,
        });
    });

    it('passes user-edited CREATE TABLE DDL to the target writer', async () => {
        const commandSql: string[] = [];
        createConnectionMock.mockResolvedValue(createConnection(commandSql));
        writeToTargetMock.mockResolvedValue({ planOnly: false, rowsInserted: 1 });

        const service = new MigrationService({
            connectionManager: {
                getConnection: jest.fn()
                    .mockResolvedValueOnce(oracleDetails)
                    .mockResolvedValueOnce({
                        name: 'netezza-target',
                        host: 'netezza.example.test',
                        database: 'JUST_DATA',
                        user: 'ADMIN',
                        dbType: 'netezza',
                    }),
                getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            },
        });

        const plan: MigrationPlan = {
            sourceKind: 'oracle',
            targetKind: 'netezza',
            sourceMode: 'sql',
            columns: [],
            createTableDdl: 'CREATE TABLE ADMIN.SALES_COPY (ID INT)',
            warnings: [],
            targetQualifiedName: 'JUST_DATA.ADMIN.SALES_COPY',
        };
        const sourceContext = { kind: 'oracle' as const, connectionDetails: oracleDetails };
        const customDdl = 'CREATE TABLE ADMIN.SALES_COPY (ID BIGINT)';

        await service.execute(request, plan, sourceContext, undefined, { customCreateTableDdl: customDdl });

        const writerInput = writeToTargetMock.mock.calls[0][0];
        expect(writerInput.customCreateTableDdl).toBe(customDdl);
    });
});
