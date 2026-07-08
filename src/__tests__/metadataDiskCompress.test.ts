import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { compressJsonToGzip, terminateCompressWorker } from '../metadata/diskStorage/metadataDiskCompress';

const mockWorkerInstances: MockWorker[] = [];

class MockWorker extends EventEmitter {
    postMessage = jest.fn();
    terminate = jest.fn(async () => undefined);
}

jest.mock('worker_threads', () => ({
    Worker: jest.fn().mockImplementation(() => {
        const instance = new MockWorker();
        mockWorkerInstances.push(instance);
        return instance;
    }),
}));

describe('metadataDiskCompress', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
        delete process.env.METADATA_DISK_WORKER;
        terminateCompressWorker();
        mockWorkerInstances.length = 0;
        jest.clearAllMocks();
    });

    it('should settle pending compression when worker exits and fall back to main-thread gzip', async () => {
        process.env.NODE_ENV = 'production';
        process.env.METADATA_DISK_WORKER = '1';

        const pending = compressJsonToGzip({ hello: 'world' });
        const worker = mockWorkerInstances[0];
        expect(worker).toBeDefined();

        worker.emit('exit', 1);

        const buffer = await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('compression hung')), 500);
            }),
        ]);

        expect(buffer[0]).toBe(0x1f);
        expect(buffer[1]).toBe(0x8b);
    });
});
