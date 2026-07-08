import { DDLCacheEntry } from './types';
import { getExtensionConfiguration } from '../../compatibility/configuration';

export class DDLCacheManager {
    private ddlCache = new Map<string, DDLCacheEntry>();

    /**
     * Gets cached DDL or fetches it using the provided fetcher
     */
    public async getCachedDDL(
        key: string,
        fetcher: () => Promise<string>
    ): Promise<string> {
        const cached = this.ddlCache.get(key);
        const now = Date.now();

        // Return cached if still valid
        const ddlCacheTTL = getExtensionConfiguration('ddl').get<number>('cacheTTL', 3600000) ?? 3600000;
        if (cached && (now - cached.timestamp) < ddlCacheTTL) {
            // console.log(`[DDLCacheManager] Using cached DDL for ${key}`);
            return cached.ddl;
        }

        // Fetch fresh DDL
        const ddl = await fetcher();
        this.ddlCache.set(key, { ddl, timestamp: now });
        return ddl;
    }

    /**
     * Clears DDL cache
     */
    public clear(): void {
        this.ddlCache.clear();
    }
}
