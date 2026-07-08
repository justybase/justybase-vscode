import * as vscode from 'vscode';
import { DDLCacheManager } from '../services/copilot/DDLCacheManager';

jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: jest.fn().mockReturnValue({
            get: jest.fn()
        })
    }
}), { virtual: true });

describe('DDLCacheManager', () => {
    let cacheManager: DDLCacheManager;

    beforeEach(() => {
        jest.clearAllMocks();
        cacheManager = new DDLCacheManager();
    });

    describe('getCachedDDL', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('should return cached DDL when valid', async () => {
            const cacheKey = 'TEST_DB|PUBLIC|users';
            const cachedDDL = 'CREATE TABLE users (id INT);';
            const cacheEntry = { ddl: cachedDDL, timestamp: Date.now() - 1000 };

            cacheManager['ddlCache'].set(cacheKey, cacheEntry);

            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(3600000)
            });

            const fetcher = jest.fn().mockResolvedValue('NEW DDL');
            const result = await cacheManager.getCachedDDL(cacheKey, fetcher);

            expect(result).toBe(cachedDDL);
            expect(fetcher).not.toHaveBeenCalled();
        });

        it('should fetch new DDL when cache is expired', async () => {
            const cacheKey = 'TEST_DB|PUBLIC|users';
            const expiredDDL = 'CREATE TABLE users (id INT);';
            const cacheEntry = { ddl: expiredDDL, timestamp: Date.now() - 4000000 };

            cacheManager['ddlCache'].set(cacheKey, cacheEntry);

            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(3600000)
            });

            const newDDL = 'CREATE TABLE users (id INT, name VARCHAR);';
            const fetcher = jest.fn().mockResolvedValue(newDDL);
            const result = await cacheManager.getCachedDDL(cacheKey, fetcher);

            expect(result).toBe(newDDL);
            expect(fetcher).toHaveBeenCalled();
            expect(cacheManager['ddlCache'].get(cacheKey)?.ddl).toBe(newDDL);
        });

        it('should fetch new DDL when not cached', async () => {
            const cacheKey = 'TEST_DB|PUBLIC|orders';

            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(3600000)
            });

            const newDDL = 'CREATE TABLE orders (id INT);';
            const fetcher = jest.fn().mockResolvedValue(newDDL);
            const result = await cacheManager.getCachedDDL(cacheKey, fetcher);

            expect(result).toBe(newDDL);
            expect(fetcher).toHaveBeenCalled();
            expect(cacheManager['ddlCache'].has(cacheKey)).toBe(true);
        });

        it('should use default TTL when not configured', async () => {
            const cacheKey = 'TEST_DB|PUBLIC|products';
            const cacheEntry = { ddl: 'OLD DDL', timestamp: Date.now() - 4000000 };

            cacheManager['ddlCache'].set(cacheKey, cacheEntry);

            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn((key: string) => {
                    if (key === 'cacheTTL') {
                        return undefined;
                    }
                    return 3600000;
                })
            });

            const fetcher = jest.fn().mockResolvedValue('NEW DDL');
            await cacheManager.getCachedDDL(cacheKey, fetcher);

            expect(fetcher).toHaveBeenCalled();
        });

        it('should use custom TTL when configured', async () => {
            const cacheKey = 'TEST_DB|PUBLIC|customers';
            const cacheEntry = { ddl: 'OLD DDL', timestamp: Date.now() - 500000 };

            cacheManager['ddlCache'].set(cacheKey, cacheEntry);

            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn((key: string) => {
                    if (key === 'cacheTTL') {
                        return 1000000;
                    }
                    return undefined;
                })
            });

            const fetcher = jest.fn().mockResolvedValue('NEW DDL');
            const result = await cacheManager.getCachedDDL(cacheKey, fetcher);

            expect(result).toBe('OLD DDL');
            expect(fetcher).not.toHaveBeenCalled();
        });

        it('should cache fetched DDL with current timestamp', async () => {
            const cacheKey = 'TEST_DB|PUBLIC|new_table';

            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(3600000)
            });

            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            const newDDL = 'CREATE TABLE new_table (id INT);';
            const fetcher = jest.fn().mockResolvedValue(newDDL);
            await cacheManager.getCachedDDL(cacheKey, fetcher);

            const cachedEntry = cacheManager['ddlCache'].get(cacheKey);
            expect(cachedEntry?.ddl).toBe(newDDL);
            expect(cachedEntry?.timestamp).toBe(now);

            jest.restoreAllMocks();
        });

        it('should handle fetcher errors', async () => {
            const cacheKey = 'TEST_DB|PUBLIC|error_table';

            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(3600000)
            });

            const fetcher = jest.fn().mockRejectedValue(new Error('Database connection failed'));

            await expect(cacheManager.getCachedDDL(cacheKey, fetcher)).rejects.toThrow('Database connection failed');
        });

        it('should handle multiple concurrent requests for same key', async () => {
            const cacheKey = 'TEST_DB|PUBLIC|concurrent_table';

            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(3600000)
            });

            const newDDL = 'CREATE TABLE concurrent_table (id INT);';
            const fetcher = jest.fn().mockResolvedValue(newDDL);

            const [result1, result2] = await Promise.all([
                cacheManager.getCachedDDL(cacheKey, fetcher),
                cacheManager.getCachedDDL(cacheKey, fetcher)
            ]);

            expect(result1).toBe(newDDL);
            expect(result2).toBe(newDDL);
            // Note: The current implementation doesn't deduplicate concurrent requests
            // so the fetcher will be called twice. This test documents current behavior.
            expect(fetcher).toHaveBeenCalledTimes(2);
        });

        it('should handle cache TTL of 0 (always fetch)', async () => {
            const cacheKey = 'TEST_DB|PUBLIC|always_fetch';
            const cacheEntry = { ddl: 'OLD DDL', timestamp: Date.now() };

            cacheManager['ddlCache'].set(cacheKey, cacheEntry);

            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(0)
            });

            const fetcher = jest.fn().mockResolvedValue('NEW DDL');
            const result = await cacheManager.getCachedDDL(cacheKey, fetcher);

            expect(result).toBe('NEW DDL');
            expect(fetcher).toHaveBeenCalled();
        });
    });

    describe('clear', () => {
        it('should clear all cached entries', () => {
            const cacheKey1 = 'TEST_DB|PUBLIC|users';
            const cacheKey2 = 'TEST_DB|PUBLIC|orders';
            const cacheEntry1 = { ddl: 'DDL 1', timestamp: Date.now() };
            const cacheEntry2 = { ddl: 'DDL 2', timestamp: Date.now() };

            cacheManager['ddlCache'].set(cacheKey1, cacheEntry1);
            cacheManager['ddlCache'].set(cacheKey2, cacheEntry2);

            expect(cacheManager['ddlCache'].size).toBe(2);

            cacheManager.clear();

            expect(cacheManager['ddlCache'].size).toBe(0);
        });

        it('should handle clearing empty cache', () => {
            expect(cacheManager['ddlCache'].size).toBe(0);

            expect(() => cacheManager.clear()).not.toThrow();
            expect(cacheManager['ddlCache'].size).toBe(0);
        });
    });

    describe('cache management', () => {
        it('should store multiple entries with different keys', async () => {
            const keys = [
                'DB1|SCHEMA1|TABLE1',
                'DB2|SCHEMA2|TABLE2',
                'DB3|SCHEMA3|TABLE3'
            ];
            const ddls = [
                'CREATE TABLE1',
                'CREATE TABLE2',
                'CREATE TABLE3'
            ];

            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(3600000)
            });

            for (let i = 0; i < keys.length; i++) {
                const ddl = ddls[i];
                await cacheManager.getCachedDDL(keys[i], () => Promise.resolve(ddl));
            }

            expect(cacheManager['ddlCache'].size).toBe(keys.length);

            for (let i = 0; i < keys.length; i++) {
                expect(cacheManager['ddlCache'].get(keys[i])?.ddl).toBe(ddls[i]);
            }
        });

        it('should update existing cache entry', async () => {
            const cacheKey = 'TEST_DB|PUBLIC|update_test';
            const oldDDL = 'OLD DDL';
            const newDDL = 'NEW DDL';

            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(3600000)
            });

            await cacheManager.getCachedDDL(cacheKey, () => Promise.resolve(oldDDL));
            expect(cacheManager['ddlCache'].get(cacheKey)?.ddl).toBe(oldDDL);

            // Make the cache entry expire by setting an old timestamp
            const cachedEntry = cacheManager['ddlCache'].get(cacheKey);
            if (cachedEntry) {
                cachedEntry.timestamp = Date.now() - 4000000; // Expired
            }

            await cacheManager.getCachedDDL(cacheKey, () => Promise.resolve(newDDL));
            expect(cacheManager['ddlCache'].get(cacheKey)?.ddl).toBe(newDDL);
        });

        it('should handle cache keys with special characters', async () => {
            const cacheKeys = [
                'DB|SCHEMA|table-name_with.dots',
                'DB|SCHEMA|table_name',
                'DB|SCHEMA|TABLE_NAME'
            ];

            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(3600000)
            });

            for (const key of cacheKeys) {
                await cacheManager.getCachedDDL(key, () => Promise.resolve(`DDL for ${key}`));
            }

            expect(cacheManager['ddlCache'].size).toBe(cacheKeys.length);

            for (const key of cacheKeys) {
                expect(cacheManager['ddlCache'].get(key)?.ddl).toContain(key);
            }
        });
    });
});
