import { expect } from '@jest/globals';
import type {
    DatabaseCommand,
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseDataReader,
} from '../../contracts/database';

export async function closeReaderTwice(reader: DatabaseDataReader): Promise<void> {
    await reader.close();
    await reader.close();
}

export async function expectQueryReturnsRow(
    connection: DatabaseConnection,
    sql: string,
): Promise<void> {
    const reader = await connection.createCommand(sql).executeReader();
    try {
        expect(await reader.read()).toBe(true);
        expect(reader.fieldCount).toBeGreaterThan(0);
    } finally {
        await reader.close();
    }
}

export async function expectReaderCloseAndReuse(
    connection: DatabaseConnection,
    readerSql: string,
    controlSql: string,
): Promise<void> {
    const reader = await connection.createCommand(readerSql).executeReader();
    await closeReaderTwice(reader);
    await expectQueryReturnsRowEventually(connection, controlSql);
}

export async function expectQueryReturnsRowEventually(
    connection: DatabaseConnection,
    sql: string,
    options: { timeoutMs?: number; retryAfterMs?: number } = {},
): Promise<void> {
    const deadline = Date.now() + (options.timeoutMs ?? 5_000);
    const retryAfterMs = options.retryAfterMs ?? 100;
    let lastError: unknown;

    while (Date.now() < deadline) {
        try {
            await expectQueryReturnsRow(connection, sql);
            return;
        } catch (error: unknown) {
            lastError = error;
            if (!isBusyConnectionError(error)) {
                throw error;
            }
            await delay(retryAfterMs);
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error(`Control query did not run before the ${options.timeoutMs ?? 5_000}ms timeout.`);
}

export async function expectConnectionCloseIsIdempotent(
    createConnection: (config: DatabaseConnectionConfig) => DatabaseConnection,
    config: DatabaseConnectionConfig,
): Promise<void> {
    const connection = createConnection(config);
    try {
        await connection.connect();
        await connection.close();
        await connection.close();
    } finally {
        await connection.close().catch(() => undefined);
    }
}

export interface CancelledReaderOutcome {
    kind: 'reader' | 'error';
    reader?: DatabaseDataReader;
    error?: unknown;
}

export interface CancelledReaderConsumptionOutcome {
    kind: 'completed' | 'error';
    rowsRead: number;
    error?: unknown;
}

export async function cancelReaderExecution(
    command: DatabaseCommand,
    execution: Promise<DatabaseDataReader>,
    options: { cancelAfterMs?: number; cancelTimeoutMs?: number; settleTimeoutMs?: number } = {},
): Promise<CancelledReaderOutcome> {
    const outcome: Promise<CancelledReaderOutcome> = execution.then(
        reader => ({ kind: 'reader', reader }),
        (error: unknown) => ({ kind: 'error', error }),
    );

    await delay(options.cancelAfterMs ?? 100);
    await withTimeout(
        command.cancel(),
        options.cancelTimeoutMs ?? options.settleTimeoutMs ?? 15_000,
        'Database command cancellation did not settle within the timeout.',
    );

    const settled = await withTimeout(
        outcome,
        options.settleTimeoutMs ?? 15_000,
        'Cancelled database reader did not settle within the timeout.',
    );

    if (settled.kind === 'reader' && settled.reader) {
        await closeReaderTwice(settled.reader);
    }

    return settled;
}

export async function cancelReaderConsumption(
    command: DatabaseCommand,
    reader: DatabaseDataReader,
    options: { cancelAfterMs?: number; cancelTimeoutMs?: number; settleTimeoutMs?: number } = {},
): Promise<CancelledReaderConsumptionOutcome> {
    let rowsRead = 0;
    const consumption: Promise<CancelledReaderConsumptionOutcome> = (async () => {
        while (await reader.read()) {
            rowsRead += 1;
        }
        return { kind: 'completed' as const, rowsRead };
    })().catch((error: unknown) => ({ kind: 'error', rowsRead, error }));

    await delay(options.cancelAfterMs ?? 100);
    await withTimeout(
        command.cancel(),
        options.cancelTimeoutMs ?? options.settleTimeoutMs ?? 15_000,
        'Database command cancellation did not settle within the timeout.',
    );

    const settled = await withTimeout(
        consumption,
        options.settleTimeoutMs ?? 15_000,
        'Cancelled database reader did not settle within the timeout.',
    );
    await closeReaderTwice(reader);
    return settled;
}

export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isBusyConnectionError(error: unknown): boolean {
    return /already executing|active command|connection is busy/i.test(String(error));
}
