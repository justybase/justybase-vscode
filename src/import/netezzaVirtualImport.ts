import { Readable } from 'stream';

import { getDatabaseConnectionConstructor } from '../core/connectionFactory';

/**
 * Register a stream for Netezza's transient external-table protocol.
 *
 * The 2.4.4 Netezza driver consumes the registered stream with async
 * iteration and applies socket backpressure before sending the next DATA
 * frame. The SQL must reference the returned name verbatim in FROM EXTERNAL.
 */
export function registerNetezzaImportStream(
    streamName: string,
    stream: Readable,
): () => void {
    const connectionConstructor = getDatabaseConnectionConstructor('netezza');
    if (!connectionConstructor.registerImportStream || !connectionConstructor.unregisterImportStream) {
        throw new Error('Active Netezza driver does not support virtual import streams.');
    }

    connectionConstructor.registerImportStream(streamName, stream);
    let registered = true;

    return () => {
        if (!registered) {
            return;
        }
        registered = false;
        connectionConstructor.unregisterImportStream?.(streamName);
    };
}

/**
 * Names are deliberately not filesystem paths. The driver first checks its
 * virtual stream registry and therefore never asks the Netezza server or the
 * local filesystem to resolve this value as a real file.
 */
export function buildNetezzaVirtualImportName(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.txt`;
}

export function destroyNetezzaImportStream(stream: Readable | undefined): void {
    if (!stream || stream.destroyed) {
        return;
    }
    stream.destroy();
}
