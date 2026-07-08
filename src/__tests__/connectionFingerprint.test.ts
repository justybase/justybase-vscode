import { describe, expect, it } from '@jest/globals';
import {
    computeConnectionFingerprint,
    computeFingerprintFromConnectionDetails,
} from '../metadata/diskStorage/connectionFingerprint';

describe('connectionFingerprint', () => {
    it('should produce stable hash for same input', () => {
        const input = { host: 'nz.example.com', port: 5480, database: 'DB1', dbType: 'netezza' as const };
        const a = computeConnectionFingerprint(input);
        const b = computeConnectionFingerprint(input);
        expect(a).toBe(b);
        expect(a).toHaveLength(64);
    });

    it('should change hash when host changes', () => {
        const base = { host: 'nz1.example.com', port: 5480, database: 'DB1', dbType: 'netezza' as const };
        const other = { ...base, host: 'nz2.example.com' };
        expect(computeConnectionFingerprint(base)).not.toBe(computeConnectionFingerprint(other));
    });

    it('should normalize host and database case', () => {
        const lower = computeConnectionFingerprint({
            host: 'HOST',
            port: 1,
            database: 'DB',
        });
        const upper = computeConnectionFingerprint({
            host: 'host',
            port: 1,
            database: 'db',
        });
        expect(lower).toBe(upper);
    });

    it('should compute from connection details', () => {
        const fp = computeFingerprintFromConnectionDetails({
            host: 'h',
            port: 5480,
            database: 'd',
            user: 'u',
            password: 'secret',
            name: 'conn',
        });
        expect(fp).toMatch(/^[a-f0-9]{64}$/);
    });
});
