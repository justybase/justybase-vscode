/**
 * Worker thread — JSON.stringify + gzip off the extension host main thread.
 */

import { parentPort } from 'worker_threads';
import { gzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);

interface CompressRequest {
    id: number;
    type: 'compress';
    data: unknown;
    level: number;
}

interface CompressResponse {
    id: number;
    ok: boolean;
    buffer?: Buffer;
    error?: string;
}

parentPort?.on('message', (message: CompressRequest) => {
    if (message?.type !== 'compress') {
        return;
    }

    void (async () => {
        try {
            const encoded = Buffer.from(JSON.stringify(message.data), 'utf8');
            const compressed = await gzipAsync(encoded, { level: message.level });
            const response: CompressResponse = {
                id: message.id,
                ok: true,
                buffer: compressed,
            };
            parentPort?.postMessage(response);
        } catch (error: unknown) {
            const response: CompressResponse = {
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
            parentPort?.postMessage(response);
        }
    })();
});
