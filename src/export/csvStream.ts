import * as fs from 'fs';
import { createGzip, createZstdCompress } from 'zlib';
import type { Writable } from 'stream';

export type CsvCompression = 'none' | 'gzip' | 'zstd';

export function resolveCsvCompressionFromPath(filePath: string): CsvCompression {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.csv.gz')) {
        return 'gzip';
    }
    if (lower.endsWith('.csv.zst') || lower.endsWith('.csv.zstd')) {
        return 'zstd';
    }
    return 'none';
}

export function csvExtensionForCompression(compression: CsvCompression): string {
    switch (compression) {
        case 'gzip':
            return 'csv.gz';
        case 'zstd':
            return 'csv.zst';
        default:
            return 'csv';
    }
}

export interface CsvFileWriter {
    stream: Writable;
    finalize: () => Promise<void>;
}

function createZstdCompressor(): Writable {
    if (typeof createZstdCompress !== 'function') {
        throw new Error('Zstandard compression is not supported by this Node.js runtime');
    }
    return createZstdCompress();
}

export function createCsvFileWriter(
    filePath: string,
    compression: CsvCompression = resolveCsvCompressionFromPath(filePath)
): CsvFileWriter {
    if (compression === 'none') {
        const stream = fs.createWriteStream(filePath, {
            encoding: 'utf8',
            highWaterMark: 64 * 1024,
        });
        return {
            stream,
            finalize: () =>
                new Promise<void>((resolve, reject) => {
                    stream.once('error', reject);
                    stream.once('finish', resolve);
                    stream.end();
                }),
        };
    }

    const fileStream = fs.createWriteStream(filePath);
    const compressor = compression === 'gzip' ? createGzip() : createZstdCompressor();
    compressor.pipe(fileStream);

    return {
        stream: compressor,
        finalize: () =>
            new Promise<void>((resolve, reject) => {
                const onError = (err: Error) => reject(err);
                compressor.once('error', onError);
                fileStream.once('error', onError);
                fileStream.once('finish', () => resolve());
                compressor.end();
            }),
    };
}
