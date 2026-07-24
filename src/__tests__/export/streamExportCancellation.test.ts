import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exportToCsv } from '../../export/csvExporter';
import { exportQueryToStreamFile, type QueryStreamExportOptions } from '../../export/queryStreamExporter';
import { ExportCancelledError } from '../../core/cancellation';
import type { ConnectionDetails } from '../../types';
import { createConnectedDatabaseConnectionFromDetails } from '../../core/connectionFactory';

jest.mock('../../core/connectionFactory', () => ({
    createConnectedDatabaseConnectionFromDetails: jest.fn(),
}));

function makeTempFile(): string {
    return path.join(os.tmpdir(), `stream_export_cancel_${Date.now()}_${Math.random().toString(36).slice(2)}.csv`);
}

interface FakeReader {
    fieldCount: number;
    getName(index: number): string;
    getTypeName(index: number): string;
    getValue(index: number): unknown;
    read(): Promise<boolean>;
    nextResult(): Promise<boolean>;
    close(): Promise<void>;
}

function makeReader(filePath: string): FakeReader {
    let reads = 0;
    return {
        fieldCount: 1,
        getName: () => 'ID',
        getTypeName: () => 'INTEGER',
        getValue: () => 1,
        read: async () => {
            if (reads++ === 0) return true;
            throw new ExportCancelledError(filePath, 1);
        },
        nextResult: async () => false,
        close: async () => undefined,
    };
}

function makeConnection(filePath: string): {
    connection: QueryStreamExportOptions['connection'];
    reader: FakeReader;
    cancel: () => Promise<void>;
} {
    const reader = makeReader(filePath);
    const command = {
        commandTimeout: undefined,
        executeReader: async () => reader,
        cancel: async () => undefined,
    };
    const connection = {
        createCommand: () => command,
        close: async () => undefined,
    };
    return {
        connection: connection as unknown as QueryStreamExportOptions['connection'],
        reader,
        cancel: command.cancel,
    };
}

async function readAndRemove(filePath: string): Promise<string> {
    try {
        return await fs.promises.readFile(filePath, 'utf8');
    } finally {
        try {
            await fs.promises.unlink(filePath);
        } catch {
            // The export may fail before creating the output file.
        }
    }
}

describe('stream export cancellation finalization', () => {
    it('finalizes CSV output when the reader rejects with cancellation', async () => {
        const filePath = makeTempFile();
        const { connection } = makeConnection(filePath);
        jest.mocked(createConnectedDatabaseConnectionFromDetails).mockResolvedValue(connection);

        try {
            await expect(exportToCsv({} as ConnectionDetails, 'SELECT 1', filePath))
                .rejects.toBeInstanceOf(ExportCancelledError);
            await expect(readAndRemove(filePath)).resolves.toBe('ID\n1\n');
        } finally {
            jest.mocked(createConnectedDatabaseConnectionFromDetails).mockReset();
            try { await fs.promises.unlink(filePath); } catch { /* already removed */ }
        }
    });

    it('finalizes query stream output when the reader rejects with cancellation', async () => {
        const filePath = makeTempFile();
        const { connection } = makeConnection(filePath);

        try {
            await expect(exportQueryToStreamFile({
                connection,
                query: 'SELECT 1',
                filePath,
                format: 'csv',
            })).rejects.toBeInstanceOf(ExportCancelledError);
            await expect(readAndRemove(filePath)).resolves.toBe('ID\n1\n');
        } finally {
            try { await fs.promises.unlink(filePath); } catch { /* already removed */ }
        }
    });
});
