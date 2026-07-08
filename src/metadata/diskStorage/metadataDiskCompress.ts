/**
 * Host-side gzip compression — worker thread when available, sync fallback in tests.
 */

import * as path from 'path';
import { Worker } from 'worker_threads';
import { gzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);

interface CompressResponse {
    id: number;
    ok: boolean;
    buffer?: Buffer;
    error?: string;
}

let worker: Worker | undefined;
let nextRequestId = 1;
const pendingRequests = new Map<number, {
    resolve: (buffer: Buffer) => void;
    reject: (error: Error) => void;
}>();

function resolveWorkerPath(): string {
    return path.join(__dirname, 'metadataDiskCompress.worker.js');
}

export function isWorkerCompressEnabled(): boolean {
    return process.env.NODE_ENV !== 'test' && process.env.METADATA_DISK_WORKER !== '0';
}

function rejectAllPending(error: Error): void {
    for (const pending of pendingRequests.values()) {
        pending.reject(error);
    }
    pendingRequests.clear();
    worker = undefined;
}

function ensureWorker(): Worker {
    if (worker) {
        return worker;
    }

    const instance = new Worker(resolveWorkerPath());
    instance.on('message', (response: CompressResponse) => {
        const pending = pendingRequests.get(response.id);
        if (!pending) {
            return;
        }
        pendingRequests.delete(response.id);
        if (response.ok && response.buffer) {
            pending.resolve(response.buffer);
            return;
        }
        pending.reject(new Error(response.error ?? 'Metadata disk worker compression failed'));
    });
    instance.on('error', (error: Error) => {
        rejectAllPending(error);
    });
    instance.on('exit', (code) => {
        if (pendingRequests.size === 0) {
            worker = undefined;
            return;
        }
        const reason = code === 0
            ? 'Metadata disk worker exited before completing compression'
            : `Metadata disk worker exited with code ${code}`;
        rejectAllPending(new Error(reason));
    });
    worker = instance;
    return instance;
}

function compressViaWorker(data: unknown, level: number): Promise<Buffer> {
    const id = nextRequestId++;
    const instance = ensureWorker();
    return new Promise<Buffer>((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        instance.postMessage({ id, type: 'compress', data, level });
    });
}

export async function compressJsonToGzip(data: unknown, level = 6): Promise<Buffer> {
    if (!isWorkerCompressEnabled()) {
        const encoded = Buffer.from(JSON.stringify(data), 'utf8');
        return gzipAsync(encoded, { level });
    }

    try {
        return await compressViaWorker(data, level);
    } catch {
        const encoded = Buffer.from(JSON.stringify(data), 'utf8');
        return gzipAsync(encoded, { level });
    }
}

export function terminateCompressWorker(): void {
    if (!worker) {
        return;
    }
    rejectAllPending(new Error('Metadata disk worker terminated'));
    void worker.terminate();
}
