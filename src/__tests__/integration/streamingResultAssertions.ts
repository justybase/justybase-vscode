import { expect } from '@jest/globals';
import { StreamingManager, type StreamingChunk } from '../../core/streaming/StreamingManager';
import type { NzConnection } from '../../types';

/**
 * Regression guard for readers that publish their row description
 * asynchronously (PostgreSQL is the canonical case). The shared streaming path
 * must wait for the first read before capturing columns; otherwise the result
 * grid receives rows with zero columns and renders an empty result.
 */
export async function expectStreamingQueryMetadata(
    connection: unknown,
    sql: string,
    expectedColumns?: readonly string[],
): Promise<void> {
    const manager = new StreamingManager();
    const chunks: StreamingChunk[] = [];

    try {
        const result = await manager.executeWithStreaming(
            connection as NzConnection,
            sql,
            100,
            25,
            undefined,
            undefined,
            chunk => {
                chunks.push(chunk);
            },
        );

        expect(result.error).toBeUndefined();
        expect(result.status).toBe('success');
        expect(result.totalRows).toBeGreaterThan(0);

        const firstChunk = chunks.find(chunk => chunk.isFirstChunk);
        expect(firstChunk).toBeDefined();
        expect(firstChunk?.columns.length).toBeGreaterThan(0);
        expect(firstChunk?.rows.length).toBeGreaterThan(0);

        if (expectedColumns) {
            expect(firstChunk?.columns.map(column => column.name)).toEqual([...expectedColumns]);
        }
    } finally {
        await manager.dispose();
    }
}
