export interface ObjectMergeOptions<T> {
  objectType: string;
  getObjectType: (value: T) => string | undefined;
  getIdentity: (value: T) => string | undefined;
  normalizeObjectType?: (value: string) => string;
  sort?: (left: T, right: T) => number;
}

/**
 * Replaces only one object type and retains every other type in the layer.
 * The operation is deterministic and treats an empty incoming list as a
 * deliberate removal of the selected type.
 */
export function mergeObjectType<T>(
  existing: readonly T[],
  incoming: readonly T[],
  options: ObjectMergeOptions<T>,
): T[] {
  const normalizeObjectType = options.normalizeObjectType ?? (value => value);
  const targetType = normalizeObjectType(options.objectType);
  const retained = existing.filter(value => {
    const objectType = options.getObjectType(value);
    return objectType === undefined || normalizeObjectType(objectType) !== targetType;
  });
  const mergedByIdentity = new Map<string, T>();
  for (const value of retained) {
    const identity = options.getIdentity(value);
    if (identity !== undefined) mergedByIdentity.set(identity, value);
  }
  // A refresh is authoritative for an already-known identity. Map.set keeps
  // the existing insertion position while replacing the old payload, and the
  // last duplicate in the incoming snapshot wins deterministically.
  for (const value of incoming) {
    const identity = options.getIdentity(value);
    if (identity !== undefined) mergedByIdentity.set(identity, value);
  }
  const merged = [...mergedByIdentity.values()];
  return options.sort ? merged.sort(options.sort) : merged;
}

export function replaceSnapshot<T>(incoming: readonly T[]): T[] {
  return [...incoming];
}

export function mergeMissing<T>(existing: readonly T[], incoming: readonly T[], getIdentity: (value: T) => string): T[] {
  const result = [...existing];
  const seen = new Set(existing.map(getIdentity));
  for (const value of incoming) {
    const identity = getIdentity(value);
    if (!seen.has(identity)) {
      seen.add(identity);
      result.push(value);
    }
  }
  return result;
}
