import * as vscode from 'vscode';
import type { DatabaseCommand, DatabaseDataReader } from '@justybase/contracts';
import { logWithFallback } from '../utils/logger';
import { createCsvFileWriter } from './csvStream';
import { cancelCommandAndCloseReader, ExportCancelledError, isCancellationError } from '../core/cancellation';

// import * as odbc from 'odbc'; // Removed odbc dependency

import { NzConnection, ConnectionDetails } from '../types';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';

// ConnectionDetails used directly - no parseConnectionString needed

export async function exportToCsv(
    connectionDetails: ConnectionDetails,
    query: string,
    filePath: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    timeout?: number,
    cancellationToken?: vscode.CancellationToken
): Promise<void> {
    let connection: NzConnection | null = null;
    let command: DatabaseCommand | undefined;
    let reader: DatabaseDataReader | undefined;
    let cancellationDisposable: vscode.Disposable | undefined;
    let cancellationRequested = false;
    const cleanupContext = { timeoutMs: 5_000 };

    try {
        // Check cancellation before starting
        if (cancellationToken?.isCancellationRequested) {
            throw new ExportCancelledError(filePath, 0, 'Export cancelled by user');
        }

        if (progress) {
            progress.report({ message: 'Connecting to database...' });
        }

        connection = await createConnectedDatabaseConnectionFromDetails(connectionDetails);

        if (progress) {
            progress.report({ message: 'Executing query...' });
        }

        // executeReader returns a reader that allows streaming rows
        command = connection.createCommand(query);
        if (timeout) {
            command.commandTimeout = timeout;
        }
        const requestCancellation = () => {
            cancellationRequested = true;
            void cancelCommandAndCloseReader(command, reader, cleanupContext);
        };
        cancellationDisposable = cancellationToken?.onCancellationRequested(requestCancellation);

        try {
            reader = await command.executeReader();
        } catch (error: unknown) {
            if (cancellationRequested || cancellationToken?.isCancellationRequested || isCancellationError(error)) {
                requestCancellation();
                await cancelCommandAndCloseReader(command, reader, cleanupContext);
                throw new ExportCancelledError(filePath, 0);
            }
            throw error;
        }

        if (cancellationToken?.isCancellationRequested || cancellationRequested) {
            requestCancellation();
            await cancelCommandAndCloseReader(command, reader, cleanupContext);
            throw new ExportCancelledError(filePath, 0);
        }

        if (progress) {
            progress.report({ message: 'Writing to CSV...' });
        }

        const csvWriter = createCsvFileWriter(filePath);
        const writeStream = csvWriter.stream;

        // Get headers
        const headers: string[] = [];
        for (let i = 0; i < reader.fieldCount; i++) {
            headers.push(reader.getName(i));
        }

        // Write headers
        if (headers.length > 0) {
            writeStream.write(headers.map(escapeCsvField).join(',') + '\n');
        }

        // Stream rows
        let totalRows = 0;
        let rowBuffer: string[] = []; // Buffer multiple rows before writing
        const BUFFER_SIZE = 500; // Increased buffer size
        let wasCancelled = false;
        let readError: unknown;

        try {
            while (await reader.read()) {
                // Check for cancellation during data fetch
                if (cancellationToken?.isCancellationRequested || cancellationRequested) {
                    requestCancellation();
                    wasCancelled = true;
                    if (progress) {
                        progress.report({ message: `Export cancelled - finalizing ${totalRows} rows...` });
                    }
                    break; // Exit loop but finalize file with partial data
                }

                totalRows++;

                // Build row string
                const rowValues: string[] = [];
                for (let i = 0; i < reader.fieldCount; i++) {
                    rowValues.push(escapeCsvField(reader.getValue(i)));
                }

                rowBuffer.push(rowValues.join(','));

                // Write buffer when it reaches BUFFER_SIZE
                if (rowBuffer.length >= BUFFER_SIZE) {
                    const canWrite = writeStream.write(rowBuffer.join('\n') + '\n');
                    rowBuffer = []; // Clear buffer

                    // Handle backpressure
                    if (!canWrite) {
                        await new Promise<void>(resolve => writeStream.once('drain', resolve));
                    }

                    // Yield to event loop to allow cancellation callback to execute
                    await new Promise(resolve => setImmediate(resolve));

                    // Check again after yielding
                    if (cancellationToken?.isCancellationRequested || cancellationRequested) {
                        requestCancellation();
                        wasCancelled = true;
                        if (progress) {
                            progress.report({ message: `Export cancelled - finalizing ${totalRows} rows...` });
                        }
                        break;
                    }

                    if (progress && totalRows % 1000 === 0) {
                        progress.report({ message: `Processed ${totalRows} rows...` });
                    }
                }
            }
        } catch (readErr: unknown) {
            if (cancellationRequested || cancellationToken?.isCancellationRequested || isCancellationError(readErr)) {
                requestCancellation();
                wasCancelled = true;
                progress?.report({ message: `Export cancelled - finalizing ${totalRows} rows...` });
            } else {
                readError = readErr;
                const errMsg = readErr instanceof Error ? readErr.message : String(readErr);
                progress?.report({ message: `Error after ${totalRows} rows: ${errMsg}` });
            }
        }

        // Write remaining buffered rows
        if (rowBuffer.length > 0) {
            writeStream.write(rowBuffer.join('\n') + '\n');
        }

        await csvWriter.finalize();

        if (readError) {
            throw readError;
        }
        if (wasCancelled || cancellationToken?.isCancellationRequested || cancellationRequested) {
            progress?.report({ message: `Export cancelled - partial data saved (${totalRows} rows)` });
            throw new ExportCancelledError(filePath, totalRows);
        }
        progress?.report({ message: `Completed: ${totalRows} rows exported` });
    } finally {
        cancellationDisposable?.dispose();
        if (cancellationRequested) {
            await cancelCommandAndCloseReader(command, reader, cleanupContext);
        } else if (reader) {
            try {
                await reader.close();
            } catch (e: unknown) {
                logWithFallback('error', 'Error closing CSV reader:', e);
            }
        }
        if (connection) {
            try {
                await connection.close();
            } catch (e: unknown) {
                logWithFallback('error', 'Error closing connection:', e);
            }
        }
    }
}

export function escapeCsvField(field: unknown): string {
    if (field === null || field === undefined) {
        return '';
    }

    let stringValue: string;
    if (typeof field === 'bigint') {
        if (field >= Number.MIN_SAFE_INTEGER && field <= Number.MAX_SAFE_INTEGER) {
            stringValue = Number(field).toString();
        } else {
            stringValue = field.toString();
        }
    } else if (field instanceof Date) {
        // Format date as ISO string
        stringValue = field.toISOString();
    } else if (typeof field === 'object' && Buffer.isBuffer(field)) {
        // Handle binary data as hex string
        stringValue = field.toString('hex');
    } else if (typeof field === 'object') {
        stringValue = JSON.stringify(field);
    } else {
        stringValue = String(field);
    }

    // Escape quotes
    if (
        stringValue.includes('"') ||
        stringValue.includes(',') ||
        stringValue.includes('\n') ||
        stringValue.includes('\r')
    ) {
        return `"${stringValue.replace(/"/g, '""')}"`;
    }

    return stringValue;
}
