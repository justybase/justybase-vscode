/**
 * Read-only view of in-memory metadata cache maps.
 * Used by search/prefetch modules to avoid importing MetadataCache (circular deps).
 */

import type {
  ColumnMetadata,
  PerKeyEntry,
  SchemaMetadata,
  TableMetadata,
} from '../types';

export interface MetadataStorageReader {
  readonly tableCache: Map<string, PerKeyEntry<TableMetadata[]>>;
  readonly schemaCache: Map<string, PerKeyEntry<SchemaMetadata[]>>;
  readonly columnCache: Map<string, PerKeyEntry<ColumnMetadata[]>>;
}
