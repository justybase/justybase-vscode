/**
 * Live Netezza: verify short per-command timeouts (All rows) do not permanently
 * poison the persistent tab connection for subsequent SQL on the same session.
 *
 * Prerequisites:
 * - NZ_DEV_PASSWORD (optionally via .env.local when using live-test-matrix)
 * - Optional: NZ_DEV_HOST, NZ_DEV_PORT, NZ_DEV_DATABASE, NZ_DEV_USER
 *
 * Run:
 *   npx jest --config jest.live.config.js \
 *     src/__tests__/integration/allRowsTimeoutSession.live.integration.test.ts \
 *     --runInBand --verbose
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { NzConnection } from '@justybase/netezza-driver';
import type { DatabaseConnection } from '../../contracts/database';
import { streamingManager } from '../../core/queryCancellation';
import { ConnectionManager } from '../../core/connectionManager';
import { executeRawQuery } from '../../core/singleQueryExecutor';
import {
    waitForPersistentConnectionReady,
} from '../../core/connectionReadiness';
import {
    ALL_ROWS_AGGREGATIONS_TIMEOUT_SECONDS,
    ALL_ROWS_APPLY_FILTER_TIMEOUT_SECONDS,
    ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS,
} from '../../results/allRowsOperationTimeouts';

const skipTests = !process.env.NZ_DEV_PASSWORD;
const describeIfDb = skipTests ? describe.skip : describe;
const itIfDb = skipTests ? it.skip : it;

const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || '192.168.0.144',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password',
};

const DOCUMENT_URI = 'file:///integration/all-rows-timeout-session.sql';
const CONNECTION_NAME = 'live-all-rows-timeout';

/** User-provided slow query (>10s on dev Netezza). */
const SLOW_SQL = `SELECT F1.PRODUCTKEY, COUNT(DISTINCT (F1.PRODUCTKEY / F2.PRODUCTKEY))
FROM
( SELECT * FROM JUST_DATA..FACTPRODUCTINVENTORY LIMIT 8000) F1,
( SELECT * FROM JUST_DATA..FACTPRODUCTINVENTORY LIMIT 8000) F2
GROUP BY 1
LIMIT 500`;

const FAST_SQL = 'SELECT 42 AS ANSWER FROM JUST_DATA.ADMIN.DIMDATE LIMIT 1';

function asDatabaseConnection(connection: NzConnection): DatabaseConnection {
    return connection as unknown as DatabaseConnection;
}

function isTimeoutError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /timeout|timed out|time.?out/i.test(message);
}

async function getCurrentSid(connection: NzConnection): Promise<string> {
    const cmd = connection.createCommand('SELECT CURRENT_SID');
    const reader = await cmd.executeReader();
    try {
        if (!(await reader.read())) {
            throw new Error('CURRENT_SID returned no rows');
        }
        return String(reader.getValue(0));
    } finally {
        await reader.close();
    }
}

function createPersistentConnectionManager(connection: NzConnection): ConnectionManager {
    return {
        getDocumentKeepConnectionOpen: () => true,
        getDocumentPersistentConnection: async () => connection,
        getConnection: async () => DB_CONFIG,
        getConnectionForExecution: () => CONNECTION_NAME,
        getActiveConnectionName: () => CONNECTION_NAME,
        setDocumentLastSessionId: () => undefined,
        closeDocumentPersistentConnection: async () => undefined,
    } as unknown as ConnectionManager;
}

async function waitUntilConnectionAcceptsCommands(
    connManager: ConnectionManager,
    connection: NzConnection,
): Promise<string> {
    await waitForPersistentConnectionReady(connManager, DOCUMENT_URI, CONNECTION_NAME);
    return getCurrentSid(connection);
}

describeIfDb('All rows timeout session isolation (live Netezza)', () => {
    let connection: NzConnection;

    beforeAll(async () => {
        connection = new NzConnection(DB_CONFIG);
        await connection.connect();
    }, 30_000);

    afterAll(async () => {
        if (connection) {
            connection.close();
        }
    });

    itIfDb(
        'streamingManager: short timeout on slow SQL leaves same session usable for next query',
        async () => {
            const sidBefore = await getCurrentSid(connection);

            let timeoutError: unknown;
            try {
                await streamingManager.executeAndFetch(
                    asDatabaseConnection(connection),
                    SLOW_SQL,
                    500,
                    ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS,
                    DOCUMENT_URI,
                );
            } catch (error) {
                timeoutError = error;
            }
            expect(timeoutError).toBeDefined();
            expect(isTimeoutError(timeoutError)).toBe(true);

            const sidAfterTimeout = await waitUntilConnectionAcceptsCommands(
                createPersistentConnectionManager(connection),
                connection,
            );
            expect(sidAfterTimeout).toBe(sidBefore);

            const followUp = await streamingManager.executeAndFetch(
                asDatabaseConnection(connection),
                FAST_SQL,
                1,
                60,
                DOCUMENT_URI,
            );
            expect(followUp.error).toBeUndefined();
            expect(followUp.results[0]?.rows[0]?.[0]).toBe(42);

            const sidAfterFollowUp = await getCurrentSid(connection);
            expect(sidAfterFollowUp).toBe(sidBefore);
        },
        180_000,
    );

    itIfDb(
        'executeRawQuery: All rows timeout override affects only that command on persistent tab connection',
        async () => {
            const connManager = createPersistentConnectionManager(connection);
            const logger = {
                outputChannel: undefined,
                logCallback: undefined,
            };
            const sidBefore = await getCurrentSid(connection);

            await expect(
                executeRawQuery(
                    connManager,
                    CONNECTION_NAME,
                    true,
                    DOCUMENT_URI,
                    SLOW_SQL,
                    500,
                    logger,
                    {},
                    ALL_ROWS_AGGREGATIONS_TIMEOUT_SECONDS,
                ),
            ).rejects.toThrow(/timeout|timed out|time.?out/i);

            const sidAfterTimeout = await waitUntilConnectionAcceptsCommands(
                createPersistentConnectionManager(connection),
                connection,
            );
            expect(sidAfterTimeout).toBe(sidBefore);

            const normalResult = await executeRawQuery(
                connManager,
                CONNECTION_NAME,
                true,
                DOCUMENT_URI,
                FAST_SQL,
                undefined,
                logger,
            );
            expect(normalResult.data[0]?.[0]).toBe(42);

            const sidAfterNormal = await getCurrentSid(connection);
            expect(sidAfterNormal).toBe(sidBefore);
        },
        180_000,
    );

    itIfDb(
        'executeRawQuery: immediate follow-up after short timeout does not return busy connection error',
        async () => {
            const connManager = createPersistentConnectionManager(connection);
            const logger = {
                outputChannel: undefined,
                logCallback: undefined,
            };
            const sidBefore = await getCurrentSid(connection);

            await expect(
                executeRawQuery(
                    connManager,
                    CONNECTION_NAME,
                    true,
                    DOCUMENT_URI,
                    SLOW_SQL,
                    500,
                    logger,
                    {},
                    ALL_ROWS_APPLY_FILTER_TIMEOUT_SECONDS,
                ),
            ).rejects.toThrow(/timeout|timed out|time.?out/i);

            const followUp = await executeRawQuery(
                connManager,
                CONNECTION_NAME,
                true,
                DOCUMENT_URI,
                FAST_SQL,
                undefined,
                logger,
            );
            expect(followUp.data[0]?.[0]).toBe(42);

            const sidAfterFollowUp = await getCurrentSid(connection);
            expect(sidAfterFollowUp).toBe(sidBefore);
        },
        180_000,
    );
});

if (skipTests) {
    console.log(
        'All rows timeout session live tests skipped: set NZ_DEV_PASSWORD to run against Netezza.',
    );
}
