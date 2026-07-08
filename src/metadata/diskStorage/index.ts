export {
    CACHE_SCHEMA_VERSION,
    COLUMN_FILE_SCHEMA_VERSION,
    METADATA_MANIFEST_SCHEMA_VERSION,
    LEGACY_CACHE_SCHEMA_VERSION,
    CACHE_FILE_NAME,
    SAVE_DEBOUNCE_MS,
    createEmptySerializedCache,
    createEmptyV2Index,
    type SerializedCache,
    type SerializedConnectionCache,
    type SerializedConnectionManifest,
    type SerializedConnectionMetadata,
    type LoadedConnectionManifest,
    type LoadedConnectionMetadata,
    type SerializedColumnFile,
    type V2DiskIndex,
} from './metadataDiskTypes';
export {
    CACHE_V2_DIR_NAME,
    encodeDatabaseFileSegment,
    decodeDatabaseFileSegment,
    getCacheV2Dir,
    getV2IndexPath,
    getConnectionManifestPath,
    getLegacySanitizedColumnFilePath,
    isActiveColumnFileEntry,
    extractDatabaseFromLayerKey,
} from './metadataDiskPaths';
export { computeConnectionFingerprint, computeFingerprintFromConnectionDetails } from './connectionFingerprint';
export { MetadataDiskLock, LOCK_TTL_MS, sanitizeConnectionNameForLock, getLockFileName } from './metadataDiskLock';
export {
    serializeConnectionFromCache,
    serializeConnectionMetadataFromCache,
    serializeColumnsByDatabase,
    hydrateConnectionIntoCache,
    hydrateConnectionMetadataIntoCache,
    hydrateConnectionMetadataChunked,
    hydrateColumnsFromDatabase,
    isConnectionCacheComplete,
    isConnectionMetadataComplete,
    mergeMetadataWithColumnFiles,
    buildTableIdMap,
    collectConnectionNamesFromCache,
} from './metadataDiskSerializer';
export { encodeColumnLayers, decodeColumnFile, decodeColumnLayerFromFile, resolveColumnLayerKeyInFile, parseColumnLayerKey } from './metadataColumnCodec';
export { compressJsonToGzip, isWorkerCompressEnabled } from './metadataDiskCompress';
export { MetadataDiskStorage, type DiskLoadResult } from './metadataDiskStorage';
export { MetadataDiskIndexWatcher } from './metadataDiskWatcher';
