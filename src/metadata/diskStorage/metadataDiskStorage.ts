/**
 * On-disk metadata cache I/O — v2 split layout, gzip JSON, debounced writes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import type { ConnectionManager } from '../../core/connectionManager';
import type { MetadataCache } from '../../metadataCache';
import { Logger } from '../../utils/logger';
import { compressJsonToGzip } from './metadataDiskCompress';
import { encodeColumnLayers } from './metadataColumnCodec';
import { yieldToEventLoop } from '../hydrateScheduler';
import { computeFingerprintFromConnectionDetails } from './connectionFingerprint';
import {
    collectConnectionNamesFromCache,
    isConnectionCacheComplete,
    isConnectionMetadataComplete,
    mergeMetadataWithColumnFiles,
    serializeColumnsByDatabase,
    serializeConnectionMetadataFromCache,
} from './metadataDiskSerializer';
import { MetadataDiskLock } from './metadataDiskLock';
import {
    databaseFileSegmentFromColumnFileName,
    extractDatabaseFromLayerKey,
    getCacheV2Dir,
    getColumnFilePath,
    getConnectionDir,
    getConnectionManifestPath,
    getConnectionMetadataPath,
    getLegacySanitizedColumnFilePath,
    getV2IndexPath,
    isActiveColumnFileEntry,
    LEGACY_CACHE_FILE_NAME,
} from './metadataDiskPaths';
import {
    CACHE_FILE_NAME,
    CACHE_SCHEMA_VERSION,
    COLUMN_FILE_SCHEMA_VERSION,
    createEmptyV2Index,
    isSerializedCache,
    isSerializedColumnFile,
    isV2DiskIndex,
    LEGACY_CACHE_SCHEMA_VERSION,
    METADATA_MANIFEST_SCHEMA_VERSION,
    MAX_FILE_WARN_BYTES,
    MAX_STORED_CONNECTIONS,
    ORPHAN_MAX_AGE_MS,
    SAVE_DEBOUNCE_MS,
    type SerializedCache,
    type SerializedColumnFile,
    type SerializedConnectionCache,
    type SerializedConnectionManifest,
    type SerializedConnectionMetadata,
    type LoadedConnectionManifest,
    type LoadedConnectionMetadata,
    type V2ConnectionIndexEntry,
    type V2DiskIndex,
} from './metadataDiskTypes';

const gunzipAsync = promisify(gunzip);
const GZIP_LEVEL = 6;
const SAVE_LOCK_NAME = '__metadata-cache-save__';
const SAVE_LOCK_WAIT_MS = 30_000;
const SAVE_LOCK_POLL_MS = 100;
const SAVE_LOCK_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_ATTEMPTS = 3;

interface PendingSaveState {
    metadataCache: MetadataCache;
    prefetchTimestamps: Map<string, number>;
    completeness: Map<string, boolean>;
}

export interface MetadataDiskSaveOptions {
    isComplete?: boolean;
}

export interface DiskLoadResult {
    loaded: boolean;
    freshPrefetchTimestamps: Map<string, number>;
}

export class MetadataDiskStorage {
    private writeQueue: Promise<void> = Promise.resolve();
    private sessionDisabled = false;
    private inMemoryIndex: V2DiskIndex | null = null;
    private dirtyConnections = new Set<string>();
    private pendingSave: PendingSaveState | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;

    readonly lock: MetadataDiskLock;

    constructor(
        private readonly storageDir: string,
        private readonly connectionManager?: ConnectionManager,
    ) {
        this.lock = new MetadataDiskLock(storageDir);
        this.ensureDirectory();
    }

    isSessionDisabled(): boolean {
        return this.sessionDisabled;
    }

    disableForSession(reason: string): void {
        this.sessionDisabled = true;
        this.clearDebounceTimer();
        Logger.getInstance().warn(`[MetadataDisk] Disk persistence disabled for session: ${reason}`);
    }

    getCacheFilePath(): string {
        return path.join(this.storageDir, CACHE_FILE_NAME);
    }

    getLegacyCacheFilePath(): string {
        return path.join(this.storageDir, LEGACY_CACHE_FILE_NAME);
    }

    getTempFilePath(targetPath: string): string {
        return `${targetPath}.tmp`;
    }

    private ensureDirectory(): void {
        try {
            if (!fs.existsSync(this.storageDir)) {
                fs.mkdirSync(this.storageDir, { recursive: true });
            }
            const v2Dir = getCacheV2Dir(this.storageDir);
            if (!fs.existsSync(v2Dir)) {
                fs.mkdirSync(v2Dir, { recursive: true });
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.disableForSession(`cannot create storage directory: ${message}`);
        }
    }

    async cleanupTempFile(): Promise<void> {
        const tmpCandidates = [
            this.getTempFilePath(this.getLegacyCacheFilePath()),
            this.getTempFilePath(getV2IndexPath(this.storageDir)),
        ];
        for (const tmpPath of tmpCandidates) {
            try {
                await fs.promises.unlink(tmpPath);
            } catch {
                // File may not exist
            }
        }
    }

    private isGzipped(buffer: Buffer): boolean {
        return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    }

    private async readGzipJson<T>(filePath: string, validator: (value: unknown) => value is T): Promise<T | null> {
        let raw: Buffer;
        try {
            raw = await fs.promises.readFile(filePath);
        } catch {
            return null;
        }
        if (raw.length === 0) {
            return null;
        }

        try {
            const jsonText = this.isGzipped(raw)
                ? (await gunzipAsync(raw)).toString('utf8')
                : raw.toString('utf8');
            const parsed: unknown = JSON.parse(jsonText);
            // Yield between CPU-bound JSON.parse and validator call to allow
            // other pending tasks (e.g. deferred linter) to execute.
            await yieldToEventLoop();
            if (!validator(parsed)) {
                return null;
            }
            if (raw.length > MAX_FILE_WARN_BYTES) {
                Logger.getInstance().warn(
                    `[MetadataDisk] File exceeds ${MAX_FILE_WARN_BYTES} bytes (${raw.length}): ${filePath}`,
                );
            }
            return parsed;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            Logger.getInstance().warn(`[MetadataDisk] Failed to read ${filePath}: ${message}`);
            return null;
        }
    }

    private async writeGzipJson(targetPath: string, data: unknown): Promise<void> {
        const stringifyStart = Date.now();
        const compressed = await compressJsonToGzip(data, GZIP_LEVEL);
        const stringifyMs = Date.now() - stringifyStart;
        const tempPath = this.getTempFilePath(targetPath);
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.promises.writeFile(tempPath, compressed);
        await fs.promises.rename(tempPath, targetPath);
        const kb = Math.round(compressed.length / 1024);
        Logger.getInstance().debug(
            `[MetadataDisk] wrote ${kb}KB gzip → ${path.basename(targetPath)} (${stringifyMs}ms)`,
        );
    }

    /** Read the v2 index file from disk. Returns null if not found or invalid. */
    async readV2Index(): Promise<V2DiskIndex | null> {
        return this.loadV2IndexFromDisk();
    }

    private async loadV2IndexFromDisk(): Promise<V2DiskIndex | null> {
        const index = await this.readGzipJson(getV2IndexPath(this.storageDir), isV2DiskIndex);
        if (!index) {
            return null;
        }
        if (index.schemaVersion !== CACHE_SCHEMA_VERSION) {
            Logger.getInstance().warn(
                `[MetadataDisk] v2 index schema mismatch: file=${index.schemaVersion}, expected=${CACHE_SCHEMA_VERSION}`,
            );
            return null;
        }
        return index;
    }

    private async ensureInMemoryIndex(): Promise<V2DiskIndex> {
        if (this.inMemoryIndex) {
            return this.inMemoryIndex;
        }
        this.inMemoryIndex = (await this.loadV2IndexFromDisk()) ?? createEmptyV2Index();
        return this.inMemoryIndex;
    }

    /** @deprecated Legacy v1 monolith loader — used for migration tests only. */
    async loadSerialized(): Promise<SerializedCache | null> {
        const startMs = Date.now();
        const filePath = this.getLegacyCacheFilePath();
        const parsed = await this.readGzipJson(filePath, isSerializedCache);
        if (!parsed) {
            return null;
        }
        if (parsed.schemaVersion !== LEGACY_CACHE_SCHEMA_VERSION) {
            Logger.getInstance().warn(
                `[MetadataDisk] Legacy schema version mismatch: file=${parsed.schemaVersion}`,
            );
            return null;
        }
        const raw = await fs.promises.readFile(filePath);
        const kb = Math.round(raw.length / 1024);
        const connCount = Object.keys(parsed.connections).length;
        Logger.getInstance().info(
            `[MetadataDisk] legacy load: ${connCount} conn, ${Date.now() - startMs}ms, ${kb}KB gzip`,
        );
        return parsed;
    }

    async migrateLegacyIfNeeded(): Promise<void> {
        const legacyPath = this.getLegacyCacheFilePath();
        if (!fs.existsSync(legacyPath)) {
            return;
        }

        const legacy = await this.loadSerialized();
        if (!legacy) {
            try {
                await fs.promises.unlink(legacyPath);
            } catch {
                // Best-effort
            }
            return;
        }

        Logger.getInstance().info('[MetadataDisk] Migrating legacy v1 cache to v2 layout');
        const index = await this.ensureInMemoryIndex();
        for (const [connectionName, connData] of Object.entries(legacy.connections)) {
            if (!isConnectionCacheComplete(connData)) {
                continue;
            }
            await this.writeConnectionV2(connectionName, connData);
            index.connections[connectionName] = {
                prefetchCompletedAt: connData.prefetchCompletedAt,
                connectionFingerprint: connData.connectionFingerprint,
                columnDatabases: [...serializeColumnsByDatabaseFromConnection(connData).keys()],
            };
        }
        index.writtenAt = Date.now();
        await this.writeGzipJson(getV2IndexPath(this.storageDir), index);
        this.inMemoryIndex = index;

        try {
            await fs.promises.unlink(legacyPath);
        } catch {
            // Best-effort
        }
    }

    private async loadConnectionMetadata(
        connectionName: string,
    ): Promise<SerializedConnectionMetadata | null> {
        const metadataPath = getConnectionMetadataPath(this.storageDir, connectionName);
        const parsed = await this.readGzipJson(
            metadataPath,
            (value): value is SerializedConnectionMetadata => {
                if (!value || typeof value !== 'object') {
                    return false;
                }
                const obj = value as SerializedConnectionMetadata;
                return (
                    typeof obj.prefetchCompletedAt === 'number'
                    && typeof obj.connectionFingerprint === 'string'
                    && obj.database !== undefined
                    && obj.schema !== undefined
                    && obj.table !== undefined
                    && obj.procedure !== undefined
                );
            },
        );
        return parsed;
    }

    private async loadConnectionManifest(
        connectionName: string,
    ): Promise<SerializedConnectionManifest | null> {
        const manifestPath = getConnectionManifestPath(this.storageDir, connectionName);
        const parsed = await this.readGzipJson(
            manifestPath,
            (value): value is SerializedConnectionManifest => {
                if (!value || typeof value !== 'object') {
                    return false;
                }
                const obj = value as SerializedConnectionManifest;
                return (
                    typeof obj.schemaVersion === 'number'
                    && typeof obj.prefetchCompletedAt === 'number'
                    && typeof obj.connectionFingerprint === 'string'
                    && obj.database !== undefined
                    && Array.isArray(obj.columnDatabases)
                );
            },
        );
        if (!parsed || parsed.schemaVersion !== METADATA_MANIFEST_SCHEMA_VERSION) {
            return null;
        }
        return parsed;
    }

    private async loadColumnFile(filePath: string): Promise<SerializedColumnFile | null> {
        const parsed = await this.readGzipJson(filePath, isSerializedColumnFile);
        if (
            !parsed
            || (parsed.schemaVersion !== CACHE_SCHEMA_VERSION
                && parsed.schemaVersion !== COLUMN_FILE_SCHEMA_VERSION)
        ) {
            return null;
        }
        return parsed;
    }

    async loadColumnFileForDatabase(
        connectionName: string,
        databaseName: string,
    ): Promise<SerializedColumnFile | null> {
        const columnPath = getColumnFilePath(this.storageDir, connectionName, databaseName);
        let columnFile = await this.loadColumnFile(columnPath);
        if (!columnFile) {
            const legacyPath = getLegacySanitizedColumnFilePath(
                this.storageDir,
                connectionName,
                databaseName,
            );
            columnFile = await this.loadColumnFile(legacyPath);
        }
        return columnFile;
    }

    async loadConnectionMetadataOnly(
        connectionName: string,
        indexEntry: V2ConnectionIndexEntry,
    ): Promise<LoadedConnectionMetadata | null> {
        const metadata = await this.loadConnectionMetadata(connectionName);
        if (!metadata || !isConnectionMetadataComplete(metadata)) {
            return null;
        }
        return {
            ...metadata,
            columnDatabases: [...indexEntry.columnDatabases],
        };
    }

    async loadAllConnectionsMetadataOnly(): Promise<Map<string, LoadedConnectionMetadata>> {
        await this.migrateLegacyIfNeeded();
        const index = await this.loadV2IndexFromDisk();
        if (!index) {
            return new Map();
        }

        const result = new Map<string, LoadedConnectionMetadata>();
        for (const [connectionName, entry] of Object.entries(index.connections)) {
            const loaded = await this.loadConnectionMetadataOnly(connectionName, entry);
            if (loaded) {
                result.set(connectionName, loaded);
            }
        }
        return result;
    }

    async loadAllConnectionManifests(): Promise<Map<string, LoadedConnectionManifest>> {
        await this.migrateLegacyIfNeeded();
        const index = await this.loadV2IndexFromDisk();
        if (!index) {
            return new Map();
        }

        const result = new Map<string, LoadedConnectionManifest>();
        for (const [connectionName, entry] of Object.entries(index.connections)) {
            const manifest = await this.loadConnectionManifest(connectionName);
            if (
                manifest
                && manifest.prefetchCompletedAt === entry.prefetchCompletedAt
                && manifest.connectionFingerprint === entry.connectionFingerprint
            ) {
                result.set(connectionName, {
                    ...manifest,
                    columnDatabases: [...entry.columnDatabases],
                    isComplete: entry.isComplete ?? manifest.isComplete ?? true,
                    hasManifestFile: true,
                });
                continue;
            }
            if (manifest) {
                Logger.getInstance().debug(
                    `[MetadataDisk] ignored manifest for ${connectionName}: index/manifest mismatch`,
                );
            }

            result.set(connectionName, {
                schemaVersion: METADATA_MANIFEST_SCHEMA_VERSION,
                prefetchCompletedAt: entry.prefetchCompletedAt,
                connectionFingerprint: entry.connectionFingerprint,
                database: { timestamp: entry.prefetchCompletedAt, data: [] },
                columnDatabases: [...entry.columnDatabases],
                isComplete: entry.isComplete ?? true,
                hasManifestFile: false,
            });
        }
        return result;
    }

    private async loadConnectionFull(
        connectionName: string,
        indexEntry: V2ConnectionIndexEntry,
    ): Promise<SerializedConnectionCache | null> {
        const metadata = await this.loadConnectionMetadata(connectionName);
        if (!metadata || !isConnectionMetadataComplete(metadata)) {
            return null;
        }

        const columnFiles: SerializedColumnFile[] = [];
        for (const dbName of indexEntry.columnDatabases) {
            const columnFile = await this.loadColumnFileForDatabase(connectionName, dbName);
            if (columnFile) {
                columnFiles.push(columnFile);
            }
        }

        const merged = mergeMetadataWithColumnFiles(metadata, columnFiles);
        if (!isConnectionCacheComplete(merged)) {
            return null;
        }
        return merged;
    }

    async loadAllConnections(): Promise<Map<string, SerializedConnectionCache>> {
        await this.migrateLegacyIfNeeded();
        const index = await this.loadV2IndexFromDisk();
        if (!index) {
            return new Map();
        }
        const result = new Map<string, SerializedConnectionCache>();

        for (const connectionName of Object.keys(index.connections)) {
            const entry = index.connections[connectionName];
            const full = await this.loadConnectionFull(connectionName, entry);
            if (full) {
                result.set(connectionName, full);
            }
        }
        return result;
    }

    resolveConnectionFingerprint(connectionName: string): string | undefined {
        const details = this.connectionManager?.getConnectionMetadata(connectionName);
        if (!details) {
            return undefined;
        }
        return computeFingerprintFromConnectionDetails(details);
    }

    getKnownConnectionNames(): Set<string> {
        const names = new Set<string>();
        if (this.connectionManager) {
            for (const name of this.connectionManager.getConnectionNames()) {
                names.add(name);
            }
        }
        return names;
    }

    applyEvictionToIndex(index: V2DiskIndex): void {
        const now = Date.now();
        const knownNames = this.getKnownConnectionNames();

        for (const [name, conn] of Object.entries(index.connections)) {
            const age = now - (conn.prefetchCompletedAt || index.writtenAt);
            const isOrphan = knownNames.size > 0 && !knownNames.has(name);
            if (isOrphan && age > ORPHAN_MAX_AGE_MS) {
                delete index.connections[name];
            }
        }

        const remaining = Object.entries(index.connections);
        if (remaining.length > MAX_STORED_CONNECTIONS) {
            remaining.sort((a, b) => a[1].prefetchCompletedAt - b[1].prefetchCompletedAt);
            const toRemove = remaining.length - MAX_STORED_CONNECTIONS;
            const removedNames: string[] = [];
            for (let i = 0; i < toRemove; i++) {
                const name = remaining[i][0];
                delete index.connections[name];
                removedNames.push(name);
            }
            void this.removeConnectionDirs(removedNames);
        }
    }

    /** @deprecated Legacy eviction for v1 tests */
    applyEviction(cache: SerializedCache): void {
        const now = Date.now();
        const knownNames = this.getKnownConnectionNames();
        const entries = Object.entries(cache.connections);

        for (const [name, conn] of entries) {
            const age = now - (conn.prefetchCompletedAt || cache.writtenAt);
            const isOrphan = knownNames.size > 0 && !knownNames.has(name);
            if (isOrphan && age > ORPHAN_MAX_AGE_MS) {
                delete cache.connections[name];
            }
        }

        const remaining = Object.entries(cache.connections);
        if (remaining.length > MAX_STORED_CONNECTIONS) {
            remaining.sort((a, b) => a[1].prefetchCompletedAt - b[1].prefetchCompletedAt);
            const toRemove = remaining.length - MAX_STORED_CONNECTIONS;
            for (let i = 0; i < toRemove; i++) {
                delete cache.connections[remaining[i][0]];
            }
        }
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    private async withSaveLock(operation: () => Promise<void>): Promise<void> {
        for (let retry = 0; retry <= MAX_RETRY_ATTEMPTS; retry++) {
            const deadline = Date.now() + SAVE_LOCK_WAIT_MS;
            /* eslint-disable no-constant-condition */
            do {
                if (await this.lock.acquireLock(SAVE_LOCK_NAME)) {
                    try {
                        await operation();
                        return;
                    } finally {
                        await this.lock.releaseLock(SAVE_LOCK_NAME);
                    }
                }
                if (Date.now() >= deadline) {
                    break;
                }
                await this.sleep(SAVE_LOCK_POLL_MS);
            } while (true);
            /* eslint-enable no-constant-condition */

            if (retry < MAX_RETRY_ATTEMPTS) {
                Logger.getInstance().warn(
                    `[MetadataDisk] Save lock timeout (attempt ${retry + 1}/${MAX_RETRY_ATTEMPTS + 1}), retrying in ${SAVE_LOCK_RETRY_DELAY_MS}ms...`,
                );
                await this.sleep(SAVE_LOCK_RETRY_DELAY_MS);
            }
        }

        throw new Error('Could not acquire metadata cache save lock');
    }

    private enqueueWrite(operation: () => Promise<void>): Promise<void> {
        const run = this.writeQueue.then(operation);
        this.writeQueue = run.catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            Logger.getInstance().warn(`[MetadataDisk] Write failed: ${message}`);
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === 'EACCES' || code === 'ENOSPC') {
                this.disableForSession(code);
            }
        });
        return run;
    }

    private clearDebounceTimer(): void {
        if (this.debounceTimer !== undefined) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
    }

    async whenWriteQueueIdle(): Promise<void> {
        await this.writeQueue;
    }

    scheduleSave(
        metadataCache: MetadataCache,
        connectionName: string,
        prefetchCompletedAt: number,
        options?: MetadataDiskSaveOptions,
    ): void {
        if (this.sessionDisabled) {
            return;
        }

        this.dirtyConnections.add(connectionName);
        if (!this.pendingSave) {
            this.pendingSave = {
                metadataCache,
                prefetchTimestamps: new Map(),
                completeness: new Map(),
            };
        } else {
            this.pendingSave.metadataCache = metadataCache;
        }
        this.pendingSave.prefetchTimestamps.set(connectionName, prefetchCompletedAt);
        this.pendingSave.completeness.set(connectionName, options?.isComplete ?? true);

        this.clearDebounceTimer();
        this.debounceTimer = setTimeout(() => {
            void this.flushPendingWrites().catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                Logger.getInstance().warn(`[MetadataDisk] Debounced flush failed: ${message}`);
            });
        }, SAVE_DEBOUNCE_MS);
    }

    async flushPendingWrites(): Promise<void> {
        this.clearDebounceTimer();
        if (this.dirtyConnections.size === 0 || !this.pendingSave) {
            return;
        }

        const connections = [...this.dirtyConnections];
        const metadataCache = this.pendingSave.metadataCache;
        const prefetchTimestamps = new Map(this.pendingSave.prefetchTimestamps);
        const completeness = new Map(this.pendingSave.completeness);
        this.dirtyConnections.clear();

        await this.enqueueWrite(() => this.withSaveLock(async () => {
                const index = await this.ensureInMemoryIndex();
                let savedAny = false;

                for (const connectionName of connections) {
                    const fingerprint = this.resolveConnectionFingerprint(connectionName);
                    const prefetchCompletedAt = prefetchTimestamps.get(connectionName) ?? Date.now();
                    const isComplete = completeness.get(connectionName) ?? true;
                    if (!fingerprint) {
                        continue;
                    }
                    const saved = await this.saveConnectionV2(
                        metadataCache,
                        connectionName,
                        fingerprint,
                        prefetchCompletedAt,
                        index,
                        { isComplete },
                    );
                    if (saved) {
                        savedAny = true;
                    }
                }

                if (savedAny) {
                    index.schemaVersion = CACHE_SCHEMA_VERSION;
                    index.writtenAt = Date.now();
                    this.applyEvictionToIndex(index);
                    await this.writeGzipJson(getV2IndexPath(this.storageDir), index);
                    this.inMemoryIndex = index;
                    Logger.getInstance().info(
                        `[MetadataDisk] flush: ${connections.length} connection(s)`,
                    );
                }
            }));
    }

    async saveConnection(
        metadataCache: MetadataCache,
        connectionName: string,
        prefetchCompletedAt: number,
        options?: MetadataDiskSaveOptions,
    ): Promise<void> {
        this.scheduleSave(metadataCache, connectionName, prefetchCompletedAt, options);
        await this.flushPendingWrites();
    }

    private async writeConnectionV2(
        connectionName: string,
        connData: SerializedConnectionCache,
    ): Promise<void> {
        const metadata: SerializedConnectionMetadata = {
            prefetchCompletedAt: connData.prefetchCompletedAt,
            connectionFingerprint: connData.connectionFingerprint,
            database: connData.database,
            schema: connData.schema,
            table: connData.table,
            procedure: connData.procedure,
            typeGroup: connData.typeGroup,
        };
        await this.writeGzipJson(
            getConnectionMetadataPath(this.storageDir, connectionName),
            metadata,
        );

        const columnFiles = serializeColumnsByDatabaseFromConnection(connData);
        for (const [dbName, columnFile] of columnFiles) {
            await this.writeGzipJson(
                getColumnFilePath(this.storageDir, connectionName, dbName),
                columnFile,
            );
        }
        await this.writeConnectionManifest(
            connectionName,
            metadata,
            [...columnFiles.keys()],
        );
    }

    private async saveConnectionV2(
        metadataCache: MetadataCache,
        connectionName: string,
        fingerprint: string,
        prefetchCompletedAt: number,
        index: V2DiskIndex,
        options?: MetadataDiskSaveOptions,
    ): Promise<boolean> {
        const metadata = serializeConnectionMetadataFromCache(
            metadataCache,
            connectionName,
            fingerprint,
            prefetchCompletedAt,
        );
        if (!metadata || !isConnectionMetadataComplete(metadata)) {
            return false;
        }

        const columnFiles = serializeColumnsByDatabase(metadataCache, connectionName);
        const columnDatabases = [...columnFiles.keys()];

        await this.writeGzipJson(
            getConnectionMetadataPath(this.storageDir, connectionName),
            metadata,
        );

        for (const [dbName, columnFile] of columnFiles) {
            await this.writeGzipJson(
                getColumnFilePath(this.storageDir, connectionName, dbName),
                columnFile,
            );
        }

        await this.pruneStaleColumnFiles(connectionName, columnDatabases);
        const isComplete = options?.isComplete ?? true;
        await this.writeConnectionManifest(connectionName, metadata, columnDatabases, isComplete);

        index.connections[connectionName] = {
            prefetchCompletedAt,
            connectionFingerprint: fingerprint,
            columnDatabases,
            isComplete,
        };
        Logger.getInstance().info(
            `[MetadataDisk] save: ${connectionName} (${columnDatabases.length} DB column file(s))`,
        );
        return true;
    }

    private async writeConnectionManifest(
        connectionName: string,
        metadata: SerializedConnectionMetadata,
        columnDatabases: string[],
        isComplete = true,
    ): Promise<void> {
        const manifest: SerializedConnectionManifest = {
            schemaVersion: METADATA_MANIFEST_SCHEMA_VERSION,
            prefetchCompletedAt: metadata.prefetchCompletedAt,
            connectionFingerprint: metadata.connectionFingerprint,
            database: metadata.database,
            columnDatabases,
            isComplete,
        };
        await this.writeGzipJson(
            getConnectionManifestPath(this.storageDir, connectionName),
            manifest,
        );
    }

    private async pruneStaleColumnFiles(
        connectionName: string,
        activeDatabases: string[],
    ): Promise<void> {
        const connDir = getConnectionDir(this.storageDir, connectionName);
        let entries: string[];
        try {
            entries = await fs.promises.readdir(connDir);
        } catch {
            return;
        }

        for (const entry of entries) {
            const fileSegment = databaseFileSegmentFromColumnFileName(entry);
            if (!fileSegment || isActiveColumnFileEntry(fileSegment, activeDatabases)) {
                continue;
            }
            try {
                await fs.promises.unlink(path.join(connDir, entry));
            } catch {
                // Best-effort
            }
        }
    }

    private async removeConnectionDirs(connectionNames: string[]): Promise<void> {
        for (const connectionName of connectionNames) {
            const connDir = getConnectionDir(this.storageDir, connectionName);
            try {
                await fs.promises.rm(connDir, { recursive: true, force: true });
            } catch {
                // Best-effort
            }
        }
    }

    async saveAll(
        metadataCache: MetadataCache,
        prefetchTimestamps: Map<string, number>,
    ): Promise<void> {
        if (this.sessionDisabled) {
            return;
        }

        await this.flushPendingWrites();

        const connectionNames = new Set([
            ...collectConnectionNamesFromCache(metadataCache),
            ...prefetchTimestamps.keys(),
        ]);
        if (connectionNames.size === 0) {
            return;
        }

        for (const connectionName of connectionNames) {
            const prefetchCompletedAt = prefetchTimestamps.get(connectionName) ?? Date.now();
            this.scheduleSave(metadataCache, connectionName, prefetchCompletedAt);
        }
        await this.flushPendingWrites();
    }

    async deleteCacheFile(): Promise<void> {
        this.clearDebounceTimer();
        this.dirtyConnections.clear();
        this.pendingSave = null;
        this.inMemoryIndex = null;

        try {
            await this.enqueueWrite(() => this.withSaveLock(async () => {
                const legacyPath = this.getLegacyCacheFilePath();
                try {
                    await fs.promises.unlink(legacyPath);
                } catch {
                    // File may not exist
                }
                try {
                    await fs.promises.rm(getCacheV2Dir(this.storageDir), { recursive: true, force: true });
                } catch {
                    // Directory may not exist
                }
                this.ensureDirectory();
            }));
        } finally {
            await this.lock.deleteAllLockFiles();
        }
    }

    filterLoadableConnections(
        connections: Map<string, SerializedConnectionCache>,
        cacheTtlMs: number,
    ): { loadable: Map<string, SerializedConnectionCache>; freshTimestamps: Map<string, number> } {
        const loadable = new Map<string, SerializedConnectionCache>();
        const freshTimestamps = new Map<string, number>();
        const now = Date.now();

        for (const [connectionName, connData] of connections) {
            if (!isConnectionCacheComplete(connData)) {
                Logger.getInstance().debug(
                    `[MetadataDisk] skipped ${connectionName}: incomplete cache entry`,
                );
                continue;
            }

            const expectedFingerprint = this.resolveConnectionFingerprint(connectionName);
            if (!expectedFingerprint) {
                Logger.getInstance().info(
                    `[MetadataDisk] skipped ${connectionName}: connection metadata unavailable`,
                );
                continue;
            }

            if (connData.connectionFingerprint !== expectedFingerprint) {
                Logger.getInstance().info(
                    `[MetadataDisk] skipped ${connectionName}: fingerprint mismatch`,
                );
                continue;
            }

            loadable.set(connectionName, connData);
            if (now - connData.prefetchCompletedAt < cacheTtlMs) {
                freshTimestamps.set(connectionName, connData.prefetchCompletedAt);
            }
        }

        return { loadable, freshTimestamps };
    }

    filterLoadableMetadataConnections(
        connections: Map<string, LoadedConnectionMetadata>,
        cacheTtlMs: number,
    ): { loadable: Map<string, LoadedConnectionMetadata>; freshTimestamps: Map<string, number> } {
        const loadable = new Map<string, LoadedConnectionMetadata>();
        const freshTimestamps = new Map<string, number>();
        const now = Date.now();

        for (const [connectionName, connData] of connections) {
            if (!isConnectionMetadataComplete(connData)) {
                Logger.getInstance().debug(
                    `[MetadataDisk] skipped ${connectionName}: incomplete metadata entry`,
                );
                continue;
            }

            const expectedFingerprint = this.resolveConnectionFingerprint(connectionName);
            if (!expectedFingerprint) {
                Logger.getInstance().info(
                    `[MetadataDisk] skipped ${connectionName}: connection metadata unavailable`,
                );
                continue;
            }

            if (connData.connectionFingerprint !== expectedFingerprint) {
                Logger.getInstance().info(
                    `[MetadataDisk] skipped ${connectionName}: fingerprint mismatch`,
                );
                continue;
            }

            loadable.set(connectionName, connData);
            if (now - connData.prefetchCompletedAt < cacheTtlMs) {
                freshTimestamps.set(connectionName, connData.prefetchCompletedAt);
            }
        }

        return { loadable, freshTimestamps };
    }

    filterLoadableManifestConnections(
        connections: Map<string, LoadedConnectionManifest>,
        cacheTtlMs: number,
    ): { loadable: Map<string, LoadedConnectionManifest>; freshTimestamps: Map<string, number> } {
        const loadable = new Map<string, LoadedConnectionManifest>();
        const freshTimestamps = new Map<string, number>();
        const now = Date.now();

        for (const [connectionName, manifest] of connections) {
            const expectedFingerprint = this.resolveConnectionFingerprint(connectionName);
            if (!expectedFingerprint) {
                Logger.getInstance().info(
                    `[MetadataDisk] skipped ${connectionName}: connection metadata unavailable`,
                );
                continue;
            }

            if (manifest.connectionFingerprint !== expectedFingerprint) {
                Logger.getInstance().info(
                    `[MetadataDisk] skipped ${connectionName}: fingerprint mismatch`,
                );
                continue;
            }

            loadable.set(connectionName, manifest);
            if ((manifest.isComplete ?? true) && now - manifest.prefetchCompletedAt < cacheTtlMs) {
                freshTimestamps.set(connectionName, manifest.prefetchCompletedAt);
            }
        }

        return { loadable, freshTimestamps };
    }
}

function serializeColumnsByDatabaseFromConnection(
    connData: SerializedConnectionCache,
): Map<string, SerializedColumnFile> {
    const byDatabase = new Map<string, Record<string, SerializedConnectionCache['column'][string]>>();
    for (const [layerKey, entry] of Object.entries(connData.column)) {
        const dbName = extractDatabaseFromLayerKey(layerKey);
        let dbColumns = byDatabase.get(dbName);
        if (!dbColumns) {
            dbColumns = {};
            byDatabase.set(dbName, dbColumns);
        }
        dbColumns[layerKey] = entry;
    }

    const result = new Map<string, SerializedColumnFile>();
    for (const [database, column] of byDatabase) {
        result.set(database, encodeColumnLayers(database, column));
    }
    return result;
}
