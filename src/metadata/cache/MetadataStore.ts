/**
 * In-memory metadata cache maps and TTL logic.
 */

import type {
  CachedObjectInfo,
  ColumnMetadata,
  DatabaseMetadata,
  ObjectWithSchema,
  PerKeyEntry,
  ProcedureMetadata,
  SchemaMetadata,
  TableMetadata,
} from '../types';

/** Default cache TTL in hours */
export const DEFAULT_CACHE_TTL_HOURS = 12;

/**
 * Stale TTL multiplier: data that has exceeded CACHE_TTL but is within
 * CACHE_TTL * STALE_TTL_MULTIPLIER is still served from RAM (stale-while-revalidate)
 * while a background refresh is triggered.
 */
export const STALE_TTL_MULTIPLIER = 2;

export function computeStaleTtl(cacheTtl: number): number {
  return cacheTtl * STALE_TTL_MULTIPLIER;
}

/**
 * Owns in-memory metadata layer maps and per-key TTL validation.
 */
export class MetadataStore {
  readonly cacheTtl: number;
  readonly staleTtl: number;

  readonly dbCache = new Map<
    string,
    { data: DatabaseMetadata[]; timestamp: number }
  >();
  readonly schemaCache = new Map<string, PerKeyEntry<SchemaMetadata[]>>();
  /** Key: "CONN|DB" */
  readonly currentSchemaCache = new Map<string, PerKeyEntry<string>>();
  /** Key: "CONN|DB" — DEFSCHEMA from _V_DATABASE */
  readonly defaultSchemaCache = new Map<string, PerKeyEntry<string>>();
  /** Key: "CONN" — Netezza SHOW ENABLE_SCHEMA_DBO_CHECK */
  readonly netezzaSchemasEnabledCache = new Map<string, PerKeyEntry<boolean>>();
  /** Key: "CONN|DB.SCHEMA" or "CONN|DB.." */
  readonly tableCache = new Map<string, PerKeyEntry<TableMetadata[]>>();
  readonly procedureCache = new Map<string, PerKeyEntry<ProcedureMetadata[]>>();
  /** Key: "CONN|DB.SCHEMA.TABLE" */
  readonly columnCache = new Map<string, PerKeyEntry<ColumnMetadata[]>>();
  /** Key: tableCache key -> {tableName -> OBJID} */
  readonly tableIdMap = new Map<string, PerKeyEntry<Map<string, number>>>();
  /** Key: "CONN|DB" -> ['TABLE', 'VIEW', ...] */
  readonly typeGroupCache = new Map<string, PerKeyEntry<string[]>>();
  readonly objectsByTypeCache = new Map<
    string,
    PerKeyEntry<ObjectWithSchema[]>
  >();
  /** Key = "CONN|DB.SCHEMA.TABLE" (upper case) */
  readonly objectLookupIndex = new Map<string, CachedObjectInfo>();
  /** Key = "CONN|DB..TABLENAME" (upper case) */
  readonly tableNameOnlyIndex = new Map<string, CachedObjectInfo>();
  /** connectionName -> Set<UPPER_DB_NAME> */
  readonly deadDatabases = new Map<string, Set<string>>();

  constructor(ttlHours: number = DEFAULT_CACHE_TTL_HOURS) {
    this.cacheTtl = ttlHours * 60 * 60 * 1000;
    this.staleTtl = computeStaleTtl(this.cacheTtl);
  }

  /**
   * Entries remain servable until staleTtl elapses (stale-while-revalidate).
   */
  isEntryValid(timestamp: number): boolean {
    return Date.now() - timestamp < this.staleTtl;
  }

  getTotalEntryCount(): number {
    return (
      this.dbCache.size +
      this.schemaCache.size +
      this.currentSchemaCache.size +
      this.defaultSchemaCache.size +
      this.netezzaSchemasEnabledCache.size +
      this.tableCache.size +
      this.columnCache.size +
      this.procedureCache.size +
      this.tableIdMap.size +
      this.typeGroupCache.size +
      this.objectsByTypeCache.size +
      this.objectLookupIndex.size +
      this.tableNameOnlyIndex.size
    );
  }

  clearLayerMaps(): void {
    this.dbCache.clear();
    this.schemaCache.clear();
    this.currentSchemaCache.clear();
    this.defaultSchemaCache.clear();
    this.netezzaSchemasEnabledCache.clear();
    this.tableCache.clear();
    this.procedureCache.clear();
    this.columnCache.clear();
    this.tableIdMap.clear();
    this.typeGroupCache.clear();
    this.objectsByTypeCache.clear();
    this.objectLookupIndex.clear();
    this.tableNameOnlyIndex.clear();
    this.deadDatabases.clear();
  }
}
