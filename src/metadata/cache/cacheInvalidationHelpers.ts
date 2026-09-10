import type { MetadataStore } from './MetadataStore';

/** Remove derived object-type lookup entries for one connection/database. */
export function invalidateObjectsByTypeForDb(
  store: MetadataStore,
  connectionName: string,
  dbName: string,
): void {
  const prefix = `${connectionName}|${dbName}|`;
  const keysToDelete: string[] = [];
  for (const key of store.objectsByTypeCache.keys()) {
    if (key.startsWith(prefix)) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    store.objectsByTypeCache.delete(key);
  }
}
