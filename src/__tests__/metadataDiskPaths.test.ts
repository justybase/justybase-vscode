import { describe, expect, it } from '@jest/globals';
import {
    encodeDatabaseFileSegment,
    getColumnFilePath,
    getLegacySanitizedColumnFilePath,
    isActiveColumnFileEntry,
} from '../metadata/diskStorage/metadataDiskPaths';

describe('metadataDiskPaths', () => {
    const storageDir = '/tmp/cache-root';

    it('should encode distinct database names to distinct file segments', () => {
        const a = encodeDatabaseFileSegment('PROD:1');
        const b = encodeDatabaseFileSegment('PROD_1');
        expect(a).not.toBe(b);

        const pathA = getColumnFilePath(storageDir, 'conn', 'PROD:1');
        const pathB = getColumnFilePath(storageDir, 'conn', 'PROD_1');
        expect(pathA).not.toBe(pathB);
    });

    it('should treat legacy sanitized filenames as active until rewritten', () => {
        const legacySegment = 'MY_DB';
        expect(isActiveColumnFileEntry(legacySegment, ['MY:DB'])).toBe(true);
        expect(isActiveColumnFileEntry(legacySegment, ['OTHER'])).toBe(false);
    });

    it('should recognize base64url-encoded active database files', () => {
        const dbName = 'DW/PROD';
        const segment = encodeDatabaseFileSegment(dbName);
        expect(isActiveColumnFileEntry(segment, [dbName])).toBe(true);
        expect(getLegacySanitizedColumnFilePath(storageDir, 'conn', dbName)).toContain('DW_PROD');
        expect(getColumnFilePath(storageDir, 'conn', dbName)).toContain(segment);
    });
});
