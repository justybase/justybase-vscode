import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { NzConnection as DriverNzConnection } from '@justybase/netezza-driver';
import { StreamingManager, type StreamingChunk } from '../../core/streaming/StreamingManager';
import type { NzConnection } from '../../types';
import {
    createNetezzaLiveConnection,
    netezzaLiveEnabled,
    readRows,
} from './netezzaLiveTestHarness';

const describeLive = netezzaLiveEnabled ? describe : describe.skip;

describeLive('Netezza streaming result boundary', () => {
    let connection: DriverNzConnection;

    beforeAll(async () => {
        connection = createNetezzaLiveConnection();
        await connection.connect();
    }, 30_000);

    afterAll(async () => {
        await connection?.close();
    });

    it('streams the exact 102000-row inventory query and leaves the connection reusable', async () => {
        const manager = new StreamingManager();
        let deliveredRows = 0;
        let finalChunkCount = 0;

        const result = await manager.executeWithStreaming(
            connection as unknown as NzConnection,
            'SELECT * FROM JUST_DATA.ADMIN.FACTPRODUCTINVENTORY LIMIT 102000',
            200_000,
            5_000,
            undefined,
            undefined,
            (chunk: StreamingChunk) => {
                deliveredRows += chunk.rows.length;
                if (chunk.isLastChunk) finalChunkCount++;
            },
        );

        expect(result.error).toBeUndefined();
        expect(result.status).toBe('success');
        expect(result.totalRows).toBe(102_000);
        expect(deliveredRows).toBe(102_000);
        expect(finalChunkCount).toBe(1);
        expect(result.timing).toEqual(expect.objectContaining({
            rowsRead: 102_000,
            status: 'success',
        }));
        expect(result.timing?.resultCompletionWaitMs).toBeGreaterThanOrEqual(0);
        expect(result.timing?.readerCloseMs).toBeGreaterThanOrEqual(0);

        await expect(readRows(connection, 'SELECT 1')).resolves.toHaveLength(1);
    }, 120_000);
});
