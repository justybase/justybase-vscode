/**
 * Platform-neutral metadata rules.
 *
 * This package deliberately contains no database I/O, timers, logging or
 * product-specific imports. Adapters provide identifiers, timestamps and
 * persistence around these values.
 */

export type MetadataIdentifierSource = 'user' | 'catalog';

export interface MetadataIdentifier {
  value: string;
  source: MetadataIdentifierSource;
  quoted?: boolean;
}

/** Naming rules are supplied by the database dialect, never inferred globally. */
export interface MetadataIdentifierPolicy {
  normalizeUser(value: string, quoted?: boolean): string;
  normalizeCatalog(value: string): string;
}

export const casePreservingIdentifierPolicy: MetadataIdentifierPolicy = {
  normalizeUser: value => value,
  normalizeCatalog: value => value,
};

export interface MetadataKeyParts {
  namespace?: string;
  ownerId?: string;
  connectionId: string;
  layer: string;
  database?: MetadataIdentifier;
  schema?: MetadataIdentifier;
  objectName?: MetadataIdentifier;
  objectType?: string;
  columnName?: MetadataIdentifier;
}

export interface ParsedMetadataKey {
  namespace?: string;
  ownerId?: string;
  connectionId: string;
  layer: string;
  database?: string;
  schema?: string;
  objectName?: string;
  objectType?: string;
  columnName?: string;
}

export interface MetadataKeyCodec {
  build(parts: MetadataKeyParts): string;
  parse(key: string): ParsedMetadataKey | null;
}

export interface TimedMetadataEntry<T> {
  value: T;
  timestamp: number;
}

export type MetadataTtlState = 'fresh' | 'stale' | 'expired';

export interface MetadataObjectLike {
  name: string;
  database?: string;
  schema?: string;
  objectType?: string;
  objectId?: number | string;
}

export interface MetadataObjectIndexEntry {
  key: string;
  nameOnlyKey: string;
  objectId?: number | string;
  objectType?: string;
  database?: string;
  schema?: string;
  name: string;
}

export interface MetadataObjectIndexes {
  byQualifiedName: ReadonlyMap<string, MetadataObjectIndexEntry>;
  byName: ReadonlyMap<string, MetadataObjectIndexEntry>;
  byObjectId: ReadonlyMap<string, MetadataObjectIndexEntry>;
}

export interface MetadataCompletenessInput {
  databaseLoaded: boolean;
  schemaLoaded: boolean;
  objectsLoaded: boolean;
  proceduresLoaded: boolean;
  typeGroupsLoaded: boolean;
  expectedColumnKeys: readonly string[];
  loadedColumnKeys: ReadonlySet<string>;
}

export interface MetadataCompletenessReport {
  complete: boolean;
  missingStages: string[];
  missingColumnKeys: string[];
}

export interface MetadataInvalidationScope {
  connectionId: string;
  database?: string;
  schema?: string;
}

export interface MetadataGenerationToken {
  connectionId: string;
  generation: number;
}

export interface MetadataSnapshotLayer<T> {
  key: string;
  entry: TimedMetadataEntry<T>;
}

export function identifierValue(identifier: string | MetadataIdentifier, policy: MetadataIdentifierPolicy): string {
  if (typeof identifier === 'string') return policy.normalizeUser(identifier, false);
  return identifier.source === 'catalog'
    ? policy.normalizeCatalog(identifier.value)
    : policy.normalizeUser(identifier.value, identifier.quoted === true);
}
