# Metadata Cache Contract

Maintainer reference for cache layers, write semantics, TTL, events, and host↔LSP synchronization.

## Cache layers and keys

| Layer | Key format | Write semantics |
| --- | --- | --- |
| `database` | `CONN` | Replace all databases for the connection |
| `schema` | `CONN\|DB` | Replace all schemas for the database |
| `currentSchema` | `CONN\|DB` | Replace default/current schema for that connection/database |
| `table` | `CONN\|DB.SCHEMA` or `CONN\|DB..` | **Complete replace** for that key; rebuilds lookup indexes |
| `column` | `CONN\|DB.SCHEMA.TABLE` | Prefetch: fill-missing only; explorer refresh: replace |
| `procedure` | `CONN\|DB.SCHEMA` or `CONN\|DB..` | Replace per key |
| `typeGroup` | `CONN\|DB` | Merge with dialect defaults |
| `objectLookup` / `objectsByType` | derived | Invalidated on `setTables` / `invalidateSchema`; rebuilt lazily |

Connection names are passed through as provided by callers (some lookup methods normalize to uppercase).

## Table cache write policy

### `setTables` — complete replacement

`MetadataCache.setTables(connection, key, data, idMap)` **replaces** the entire table list for `key`. It does not merge with prior entries.

Callers that refresh only one object type (TABLE, VIEW, NICKNAME, ALIAS) within a schema **must** merge before calling `setTables`. Use `mergeTableLikeObjectsForSchema` or `mergeAndSetTables`.

For `DB..` keys, `mergeAndSetTables` falls back to `getTablesAllSchemas` when the aggregate key is missing, so per-schema TABLE rows are preserved during a database-level VIEW refresh.

**Prefetch** groups UNION results by schema and calls `setTables` per schema key with the full result set for that schema.

**Schema explorer** refreshes one type at a time and merges with existing cache entries of other types.

### Example: refresh VIEW when TABLE already cached

1. Explorer loads VIEW list from the server.
2. `mergeTableLikeObjectsForSchema(existingTables, newViews, 'VIEW')` keeps TABLE rows, replaces VIEW rows.
3. `setTables` writes the merged array.

Skipping step 2 removes all TABLE entries for that schema key.

## TTL and prefetch freshness

- `cacheTtl` — configured via `cacheTTL` (default 12 hours).
- `staleTtl` — `2 × cacheTtl`; entries may still be served until stale window ends, then evicted on read.
- **Prefetch freshness** (`isConnectionPrefetchFresh`) uses `cacheTtl` only, not `staleTtl`.
- `currentSchema` uses the same TTL/stale window as `schema`.

## Invalidation

### `invalidateSchema(connection, db, schema?)`

Removes for the target scope:

- Table cache entry (`CONN\|DB.SCHEMA` or `CONN\|DB..`)
- Aggregated `CONN\|DB..` table cache when a specific schema is invalidated
- Procedure cache (schema + all-schemas aggregate when applicable)
- Column cache keys for the schema
- Lookup indexes via `removeTableCacheEntry`

Fires `onDidInvalidate`.

### `clearCache()`

Wipes all in-memory layers, bumps `_cacheGeneration` (cancels in-flight disk/column loads), clears stats, fires `onDidInvalidate`.

## Events

| Event | When | Typical subscribers |
| --- | --- | --- |
| `onDidInvalidate` | `invalidateSchema`, `clearCache` | Semantic tokens, LSP notification |
| `onDidExternalRefresh` | Cross-window disk re-hydration per connection | Schema browser, LSP notification |
| `onDidPrefetchProgress` | Prefetch stages | Status bar |
| `onDidNeedColumnRecovery` | Column disk load failure | Prefetch coordinator |

## Netezza-specific behavior

- **`DB..TABLE`** — name-only lookup index; first-match wins across schemas; winner updates when first-match schema is removed.
- **Multi-schema** — refreshing schema S1 does not remove schema S2 entries (separate cache keys).
- **Table-like types** — TABLE, VIEW, NICKNAME, ALIAS, SYNONYM, SEQUENCE, MATERIALIZED VIEW, SYSTEM VIEW, and related types share the `table` cache layer; explorer merge is per `objType`.
- **Prefetch UNION (Netezza)** — stage 3 loads `NZ_PREFETCH_CATALOG_OBJECT_TYPES`: TABLE, VIEW, EXTERNAL TABLE, SYNONYM, SEQUENCE, MATERIALIZED VIEW, SYSTEM VIEW into `tableCache`. PROCEDURE uses the separate `procedure` layer (stage 4). Type groups are prefetched per DB (stage 2, after schemas).

## Host ↔ LSP synchronization

- **Canonical store:** extension-host `MetadataCache`.
- **LSP cache:** `MetadataBridge` (list + tableInfo, 12h TTL) in the language-server process.
- **Sync path:** `onDidInvalidate` / `onDidExternalRefresh` → `NETEZZA_METADATA_CACHE_INVALIDATED_NOTIFICATION` → `metadataBridge.clearAll()`.
- **Validation epoch:** LSP diagnostics track `metadataEpoch`; stale validation results are dropped when epoch changes after cache invalidation.

LSP metadata requests are served by `handleMetadataRequest` reading the host cache via RPC.

## Disk persistence and cross-window sync

When disk persistence is enabled (`justybase.metadataCache.diskPersistence`, default `true`):

- On startup, a small per-connection manifest hydrates the database list immediately; heavy **metadata** layers (schema, table, procedure, typeGroup) hydrate from disk in the background.
- **Columns** stay in per-database column files (`*.columns.json.gz`) until loaded on demand.
- Prefetch checkpoints metadata to disk; column files are written at checkpoint/dispose.
- Checkpoints are marked `isComplete: false`. They may be loaded for recovery, but never restore `isConnectionPrefetchFresh`.
- Only a verified complete snapshot (`isComplete: true`) restores prefetch freshness. Completion requires database, schema, table, procedure/type catalog stages, plus column cache entries for table/view/external-table objects.
- Another VS Code window writing the v2 index triggers `onExternalCacheUpdate` → re-hydrate metadata → `onDidExternalRefresh`.

Self-writes are skipped when this window holds the prefetch lock.

The manifest is written after metadata and column payloads, and the v2 index is written last. Startup accepts a manifest as fresh only when its timestamp/fingerprint matches the index and the snapshot is complete. Stale or partial snapshots are still usable as local data while background prefetch refreshes them.

### Column load paths (restart-safe)

| API | When used | Behavior |
| --- | --- | --- |
| `ensureColumnsLoaded(connection, db)` | Completion legacy path, small catalogs | Full per-DB column file → all layers into RAM; marks DB as fully loaded |
| `ensureColumnsLoadedForTableKey(connection, layerKey)` | Schema tree, `MetadataProvider`, `columnCacheLookup` | Prefer single layer; see below |

**`ensureColumnsLoadedForTableKey` order:**

1. Return if `getColumns(connection, layerKey)` already in RAM.
2. Return if DB already fully loaded (`columnsLoadedDatabases`).
3. If column file exists on disk → `loadColumnLayerFromDisk` (decode **one** `DB.SCHEMA.TABLE` layer).
4. If catalog is **not** large → fall back to `ensureColumnsLoaded` (full DB hydrate).

**Large catalogs** (`isLargeTableCatalog`, default threshold **500** table-like objects per DB, constant `LARGE_DB_TABLE_LIKE_OBJECT_THRESHOLD` in `schemaTreeDataSource.ts`):

- Skip full DB hydrate and eager column preload for that database.
- Load only requested table layers on demand (schema tree expand, completion).
- Parsed column files are cached in RAM (`parsedColumnFileCache`) so the second table in the same DB reuses the gzip parse without re-reading disk.

**Schema tree** (`SchemaProvider.getChildren` for `netezza:TABLE|VIEW|…`) calls `ensureColumnsLoadedForTableKey` then reads RAM. It does **not** issue SQL when `hasTreeReadyColumnCache` passes (columns present with `isPk` defined). Column rows written to cache use `normalizeColumnCacheEntry` so missing `isDistributionKey` does not cause refetch loops.

**Completion** (`MetadataProvider.getTableColumnsMetadata`) uses the same `ensureColumnsLoadedForTableKey` entry point before `getColumns`.

### Views catalog completeness (in-memory only)

`viewsCatalogLoaded` is a **RAM-only** `Set` keyed `CONN|DB.SCHEMA` (normalized). It is **not** serialized to disk. After restart, flags are restored indirectly:

| Source | When `markViewsCatalogLoaded` runs |
| --- | --- |
| Prefetch UNION (`prefetchAllObjects`) | After every per-schema `setTables` (views may be zero) |
| Disk metadata hydrate | After each table layer `setTables` in `hydrateConnectionMetadataChunked` |
| Live views fetch | After `MetadataProvider.getViews` writes merged VIEW rows |
| Explorer partial `setTables` | Only when batch contains `objType === 'VIEW'` |

**Completion / `getViews` for `DB..`:** if cache has table-like rows but zero VIEW rows, return `[]` without SQL when:

- `isViewsCatalogLoaded(connection, cacheKey)` for the scope key, or
- `areViewsCatalogLoadedForDatabase(connection, db)` — every per-schema table layer for that DB has the flag.

Without these flags, `getViews` may show **“Fetching views…”** even when the database truly has no views.

### Objects catalog completeness (in-memory only)

`objectsCatalogLoaded` is a **RAM-only** `Set` keyed `CONN|DB.SCHEMA|OBJTYPE` (normalized layer key). It complements `viewsCatalogLoaded` for all prefetched table-cache types and uses `CONN|DB|PROCEDURE` for the procedure layer.

| Source | When catalog flags are set |
| --- | --- |
| Prefetch UNION (stage 3) | `markPrefetchObjectTypesCatalogLoaded` after each per-schema `setTables` |
| Prefetch procedures (stage 4) | `markProcedureCatalogLoaded` per database |
| Disk metadata hydrate | Same marks after `hydrateConnectionMetadataChunked` |
| Schema tree live fetch | `markObjectsCatalogLoaded` / `markProcedureCatalogLoaded` on write-back |

**Schema tree (`typeGroup:*`):** `SchemaProvider.getChildren` reads `procedureCache` for PROCEDURE and `getObjectsByType` for table-cache types before issuing SQL. Empty results are served without SQL when `areObjectsCatalogLoadedForDatabase` (table types) or `isProcedureCatalogLoaded` (procedures) is true.

**SYNONYM disk roundtrip:** `REFOBJNAME` is persisted in the table layer (`KNOWN_TABLE_KEYS`).

**Type groups after restart:** disk-hydrated `typeGroup` layers skip `triggerTypeGroupsRefresh`. When missing, `deriveTypeGroupsFromCache` builds a fallback list from cached `objType` values and procedure presence.

### Disk layout reminder

- Metadata index: `globalStorage/metadata-cache-v3/index.json.gz`

### Multi-window disk protocol (v3)

The disk cache uses an independent `metadata-cache-v3` directory. v2 is never
loaded, migrated, or removed, so an older extension process cannot share
payloads with v3.

The v3 index is the source of truth and contains a global `generation`, a
monotonic `revision`, and `nextFence`. A prefetch receives a connection lease,
the generation observed at acquisition, and a fence token allocated under the
global writer lease. Checkpoints and the final snapshot commit only while that
lease is valid. A commit is rejected when its generation is old or its fence is
older than the connection's committed fence.

Locks have random owner and lease identifiers. Their lock record is immutable;
heartbeat files are unique to the lease. Consequently a former owner cannot
renew, delete, or overwrite a lock acquired after expiry.

`clearCache()` is global: it increments the generation and commits an empty
index under the global writer lease. It does not remove another process's
locks. Windows observing the generation change clear RAM, invalidate LSP data,
and discard in-flight hydration. Disposal does not write an all-RAM snapshot.
- Per connection: metadata JSON + optional `DB.columns.json.gz` per database with column layers

## Regression tests

Disk restart and schema-tree column expand are covered without a live database:

```bash
npm run test:metadata-cache:integration
```

Tests simulate: populate cache → `dispose` (disk write) → new `MetadataCache` → `initialize()` → column/object-list access without `runQueryRaw` (TABLE, PROCEDURE, SEQUENCE, SYNONYM, MATERIALIZED VIEW, SYSTEM VIEW, schemas).

Key files:

- `src/__tests__/integration/metadataCacheRestart.integration.test.ts`
- `src/__tests__/fixtures/metadataCacheRestartFixture.ts`

## Related modules

| Module | Role |
| --- | --- |
| `src/metadata/cache/MetadataCache.ts` | Facade |
| `src/metadata/cache/MetadataStore.ts` | In-memory maps + TTL |
| `src/metadata/cache/columnLoader.ts` | Lazy column hydrate, per-layer disk load, eager preload |
| `src/metadata/cache/schemaTreeDataSource.ts` | `getTablesForScope`, `hasTreeReadyColumnCache`, large-catalog threshold |
| `src/metadata/cache/layerAccess.ts` | Layer I/O, `isLargeTableCatalog`, `areViewsCatalogLoadedForDatabase` |
| `src/metadata/diskStorage/metadataColumnCodec.ts` | Column file v3 encode/decode, `decodeColumnLayerFromFile` |
| `src/metadata/prefetch.ts` | Staged connection prefetch |
| `src/metadata/cache/MetadataPrefetchTarget.ts` | Prefetch write contract (breaks import cycle) |
| `src/metadata/cache/MetadataStorageReader.ts` | Read-only maps for search |
| `src/metadata/columnCacheLookup.ts` | Async column cache reads for hover/LSP helpers |
| `src/metadata/helpers.ts` | Key builders, `mergeTableLikeObjectsForSchema` |
| `src/providers/schemaProvider.ts` | Schema tree; column expand via `ensureColumnsLoadedForTableKey` |
| `src/providers/providers/metadataProvider.ts` | Completion metadata; `getViews` / `getTableColumnsMetadata` |
| `src/server/metadataBridge.ts` | LSP-side cache |
| `src/sqlParser/metadataCacheAdapter.ts` | Validator schema provider |
