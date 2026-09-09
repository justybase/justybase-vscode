import type { MetadataObjectIndexEntry, MetadataObjectIndexes, MetadataObjectLike } from './types';

export interface ObjectIndexOptions<T extends MetadataObjectLike> {
  getQualifiedKey: (value: T) => string;
  getNameOnlyKey: (value: T) => string;
  getObjectId?: (value: T) => number | string | undefined;
  getObjectType?: (value: T) => string | undefined;
}

function entryFor<T extends MetadataObjectLike>(value: T, options: ObjectIndexOptions<T>): MetadataObjectIndexEntry {
  return {
    key: options.getQualifiedKey(value),
    nameOnlyKey: options.getNameOnlyKey(value),
    objectId: options.getObjectId?.(value) ?? value.objectId,
    objectType: options.getObjectType?.(value) ?? value.objectType,
    database: value.database,
    schema: value.schema,
    name: value.name,
  };
}

export function buildObjectIndexes<T extends MetadataObjectLike>(
  values: readonly T[],
  options: ObjectIndexOptions<T>,
): MetadataObjectIndexes {
  const byQualifiedName = new Map<string, MetadataObjectIndexEntry>();
  const byName = new Map<string, MetadataObjectIndexEntry>();
  const byObjectId = new Map<string, MetadataObjectIndexEntry>();
  for (const value of values) {
    const entry = entryFor(value, options);
    byQualifiedName.set(entry.key, entry);
    if (!byName.has(entry.nameOnlyKey)) byName.set(entry.nameOnlyKey, entry);
    if (entry.objectId !== undefined) byObjectId.set(String(entry.objectId), entry);
  }
  return { byQualifiedName, byName, byObjectId };
}

export function lookupObject(
  indexes: MetadataObjectIndexes,
  qualifiedKey: string,
  nameOnlyKey?: string,
): MetadataObjectIndexEntry | undefined {
  return indexes.byQualifiedName.get(qualifiedKey)
    ?? (nameOnlyKey === undefined ? undefined : indexes.byName.get(nameOnlyKey));
}
