const mockCreateConnectedDatabaseConnectionFromDetails = jest.fn();
const mockRegisterImportStream = jest.fn();
const mockUnregisterImportStream = jest.fn();

jest.mock('../core/connectionFactory', () => ({
    createConnectedDatabaseConnectionFromDetails: mockCreateConnectedDatabaseConnectionFromDetails,
    getDatabaseConnectionConstructor: jest.fn(() => ({
        registerImportStream: mockRegisterImportStream,
        unregisterImportStream: mockUnregisterImportStream,
    })),
}));

import type { Readable } from 'stream';
import type { TargetWriterInput } from '../migration/targetWriter';
import { writeToTarget } from '../migration/targetWriter';

function createNetezzaWriterInput(): TargetWriterInput {
    return {
        targetKind: 'netezza',
        target: {
            connectionName: 'netezza-target',
            database: 'JUST_DATA',
            schema: 'ADMIN',
            table: 'DESTINATION',
            appendToExistingTable: false,
        },
        targetDetails: {
            name: 'netezza-target',
            host: 'netezza.example.test',
            port: 5480,
            database: 'JUST_DATA',
            user: 'ADMIN',
            password: 'secret',
            dbType: 'netezza',
        },
        columns: [{
            sourceIndex: 0,
            targetName: 'ID',
            canonicalType: 'INTEGER',
            renderedType: 'INTEGER',
            notNull: false,
            isPk: false,
        }],
        rows: (async function* (): AsyncGenerator<string[]> {
            yield ['1'];
        })(),
        totalRows: 1,
        startedAt: Date.now(),
        progressCallback: jest.fn(),
    };
}

describe('Netezza target writer stream cleanup', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('unregisters and destroys the stream when connection creation fails', async () => {
        const connectionError = new Error('connection failed');
        mockCreateConnectedDatabaseConnectionFromDetails.mockRejectedValueOnce(connectionError);

        await expect(writeToTarget(createNetezzaWriterInput())).rejects.toBe(connectionError);

        expect(mockRegisterImportStream).toHaveBeenCalledTimes(1);
        expect(mockUnregisterImportStream).toHaveBeenCalledTimes(1);

        const stream = mockRegisterImportStream.mock.calls[0]?.[1] as Readable;
        expect(stream.destroyed).toBe(true);
    });
});
