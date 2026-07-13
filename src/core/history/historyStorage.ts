import * as fs from 'fs';
import * as path from 'path';
import { encode, decode } from '@msgpack/msgpack';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { QueryHistoryEntry, StorageData, HistoryStats } from './types';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// Compression level: 1 (fastest) to 9 (best compression), default is 6
const COMPRESSION_LEVEL = 6;
const MAX_ARCHIVE_SIZE_FOR_COUNT = 50 * 1024 * 1024; // 50MB
const MAX_ARCHIVE_AGE_DAYS = 730; // 2 years (2 lata)

interface ArchiveMetadata {
    version: number;
    entryCount: number;
    archiveSizeBytes: number;
    archiveMtimeMs: number;
    updatedAt: number;
}

interface ArchiveStatsSnapshot {
    archivedEntries: number;
    archiveSizeMB: number;
    archiveSizeBytes: number;
    archiveMtimeMs: number;
}

export class HistoryStorage {
    private readonly historyFilePath: string;
    private readonly archiveFilePath: string;
    private readonly historyJsonPath: string;
    private readonly archiveJsonPath: string;
    private readonly archiveMetadataPath: string;
    private static readonly STORAGE_VERSION = 1;
    private writeQueue: Promise<void> = Promise.resolve();
    private archiveQueue: Promise<void> = Promise.resolve();
    private migrationPromise: Promise<QueryHistoryEntry[] | null> | null = null;
    private archiveMigrationPromise: Promise<QueryHistoryEntry[] | null> | null = null;
    private archiveStatsPromise: Promise<ArchiveStatsSnapshot> | null = null;
    private archiveStatsCache: ArchiveStatsSnapshot | null = null;

    constructor(private storagePath: string) {
        this.historyFilePath = path.join(storagePath, 'query-history.msgpack.gz');
        this.archiveFilePath = path.join(storagePath, 'query-history-archive.msgpack.gz');
        this.historyJsonPath = path.join(storagePath, 'query-history.json');
        this.archiveJsonPath = path.join(storagePath, 'query-history-archive.json');
        this.archiveMetadataPath = path.join(storagePath, 'query-history-archive.meta.json');
        this.ensureDirectory();
    }

    private ensureDirectory(): void {
        try {
            if (!fs.existsSync(this.storagePath)) {
                fs.mkdirSync(this.storagePath, { recursive: true });
            }
        } catch (e) {
            console.error('[HistoryStorage] Error creating storage directory:', e);
        }
    }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    private validateStorageData(data: unknown): data is StorageData {
        if (!data || typeof data !== 'object') {
            return false;
        }
        const obj = data as Record<string, unknown>;
        return Array.isArray(obj.entries) && typeof obj.version === 'number';
    }

    private validateEntries(data: unknown): QueryHistoryEntry[] {
        if (Array.isArray(data)) {
            return data;
        }
        if (data && typeof data === 'object') {
            const obj = data as Record<string, unknown>;
            if (Array.isArray(obj.entries)) {
                return obj.entries as QueryHistoryEntry[];
            }
        }
        return [];
    }

    private filterEntriesByAge(entries: QueryHistoryEntry[]): QueryHistoryEntry[] {
        const cutoffDate = Date.now() - (MAX_ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000);
        return entries.filter(entry => {
            // Assuming QueryHistoryEntry has timestamp field
            // If timestamp is in different format, adjust it
            const entryTime = entry.timestamp || 0;
            return entryTime > cutoffDate;
        });
    }

    private async writeAtomic(filePath: string, data: Buffer): Promise<void> {
        const tempPath = `${filePath}.tmp`;
        try {
            await fs.promises.writeFile(tempPath, data);
            await fs.promises.rename(tempPath, filePath);
        } catch (error) {
            // Clean up temp file if it exists
            try {
                if (await this.fileExists(tempPath)) {
                    await fs.promises.unlink(tempPath);
                }
            } catch { /* ignore cleanup errors */ }
            throw error;
        }
    }

    private async writeCompressed(data: StorageData): Promise<void> {
        try {
            const encoded = encode(data);
            const compressed = await gzipAsync(Buffer.from(encoded), { level: COMPRESSION_LEVEL });
            await this.writeAtomic(this.historyFilePath, compressed);
        } catch (error) {
            console.error('[HistoryStorage] Error writing compressed file:', error);
            throw error;
        }
    }

    private async readCompressed(): Promise<StorageData | null> {
        try {
            const compressed = await fs.promises.readFile(this.historyFilePath);
            if (!compressed || compressed.length === 0) {
                return null;
            }
            const decompressed = await gunzipAsync(compressed);
            const decoded = decode(decompressed);

            if (!this.validateStorageData(decoded)) {
                console.warn('[HistoryStorage] Invalid storage data format');
                return null;
            }

            return decoded;
        } catch (error) {
            console.error('[HistoryStorage] Error reading compressed file:', error);
            throw error;
        }
    }

    private async writeArchiveCompressed(data: StorageData): Promise<void> {
        try {
            const encoded = encode(data);
            const compressed = await gzipAsync(Buffer.from(encoded), { level: COMPRESSION_LEVEL });
            await this.writeAtomic(this.archiveFilePath, compressed);
            this.invalidateArchiveStats();
            try {
                const stats = await fs.promises.stat(this.archiveFilePath);
                await this.writeArchiveMetadata(data.entries.length, stats);
            } catch (metadataError) {
                console.warn('[HistoryStorage] Archive saved but metadata update failed:', metadataError);
            }
        } catch (error) {
            console.error('[HistoryStorage] Error writing compressed archive:', error);
            throw error;
        }
    }

    private invalidateArchiveStats(): void {
        this.archiveStatsCache = null;
        this.archiveStatsPromise = null;
    }

    private async writeArchiveMetadata(entryCount: number, stats: fs.Stats): Promise<void> {
        const metadata: ArchiveMetadata = {
            version: HistoryStorage.STORAGE_VERSION,
            entryCount,
            archiveSizeBytes: stats.size,
            archiveMtimeMs: stats.mtimeMs,
            updatedAt: Date.now(),
        };
        await this.writeAtomic(this.archiveMetadataPath, Buffer.from(JSON.stringify(metadata), 'utf8'));
        this.archiveStatsCache = {
            archivedEntries: entryCount,
            archiveSizeMB: parseFloat((stats.size / (1024 * 1024)).toFixed(2)),
            archiveSizeBytes: stats.size,
            archiveMtimeMs: stats.mtimeMs,
        };
    }

    private async readArchiveMetadata(stats: fs.Stats): Promise<ArchiveMetadata | null> {
        try {
            const raw = await fs.promises.readFile(this.archiveMetadataPath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<ArchiveMetadata>;
            if (
                parsed.version !== HistoryStorage.STORAGE_VERSION
                || typeof parsed.entryCount !== 'number'
                || parsed.archiveSizeBytes !== stats.size
                || parsed.archiveMtimeMs !== stats.mtimeMs
            ) {
                return null;
            }
            return parsed as ArchiveMetadata;
        } catch {
            return null;
        }
    }

    private async loadArchiveStats(): Promise<ArchiveStatsSnapshot> {
        const exists = await this.fileExists(this.archiveFilePath);
        if (!exists) {
            return {
                archivedEntries: 0,
                archiveSizeMB: 0,
                archiveSizeBytes: 0,
                archiveMtimeMs: 0,
            };
        }

        const stats = await fs.promises.stat(this.archiveFilePath);
        const cached = this.archiveStatsCache;
        if (
            cached
            && cached.archiveSizeBytes === stats.size
            && cached.archiveMtimeMs === stats.mtimeMs
        ) {
            return cached;
        }

        const metadata = await this.readArchiveMetadata(stats);
        let archivedEntries: number;
        if (metadata) {
            archivedEntries = metadata.entryCount;
        } else if (stats.size < MAX_ARCHIVE_SIZE_FOR_COUNT) {
            const entries = await this.getArchiveEntries();
            archivedEntries = entries.length;
            try {
                await this.writeArchiveMetadata(archivedEntries, stats);
            } catch (metadataError) {
                console.warn('[HistoryStorage] Unable to backfill archive metadata:', metadataError);
            }
        } else {
            archivedEntries = -1;
        }

        const snapshot: ArchiveStatsSnapshot = {
            archivedEntries,
            archiveSizeMB: parseFloat((stats.size / (1024 * 1024)).toFixed(2)),
            archiveSizeBytes: stats.size,
            archiveMtimeMs: stats.mtimeMs,
        };
        this.archiveStatsCache = snapshot;
        return snapshot;
    }

    private getArchiveStats(): Promise<ArchiveStatsSnapshot> {
        if (!this.archiveStatsPromise) {
            this.archiveStatsPromise = this.loadArchiveStats().finally(() => {
                this.archiveStatsPromise = null;
            });
        }
        return this.archiveStatsPromise;
    }

    private async readArchiveCompressed(): Promise<StorageData | null> {
        try {
            const compressed = await fs.promises.readFile(this.archiveFilePath);
            if (!compressed || compressed.length === 0) {
                return null;
            }
            const decompressed = await gunzipAsync(compressed);
            const decoded = decode(decompressed);

            if (!decoded || typeof decoded !== 'object') {
                console.warn('[HistoryStorage] Invalid archive data format');
                return null;
            }

            return decoded as StorageData;
        } catch (error) {
            console.error('[HistoryStorage] Error reading compressed archive:', error);
            throw error;
        }
    }

    private async migrateFromJson(
        jsonPath: string,
        targetPath: string,
        writeFn: (data: StorageData) => Promise<void>
    ): Promise<QueryHistoryEntry[] | null> {
        const jsonExists = await this.fileExists(jsonPath);
        const targetExists = await this.fileExists(targetPath);

        if (!jsonExists || targetExists) {
            return null;
        }

        try {
            const raw = await fs.promises.readFile(jsonPath, 'utf-8');
            if (!raw || !raw.trim()) {
                return null;
            }

            const parsed = JSON.parse(raw);
            const entries = this.validateEntries(parsed);

            if (entries.length === 0) {
                return null;
            }

            const storageData: StorageData = {
                entries: entries,
                version: HistoryStorage.STORAGE_VERSION
            };

            await writeFn(storageData);
            await fs.promises.unlink(jsonPath);
            console.log(`[HistoryStorage] Migrated from JSON: ${jsonPath}`);

            return entries;
        } catch (e) {
            console.warn(`[HistoryStorage] Error migrating from JSON (${jsonPath}):`, e);
            return null;
        }
    }

    private async migrateFromUncompressed(
        uncompressedPath: string,
        targetPath: string,
        writeFn: (data: StorageData) => Promise<void>
    ): Promise<QueryHistoryEntry[] | null> {
        const uncompressedExists = await this.fileExists(uncompressedPath);
        const targetExists = await this.fileExists(targetPath);

        if (!uncompressedExists || targetExists) {
            return null;
        }

        try {
            const raw = await fs.promises.readFile(uncompressedPath);
            if (!raw || raw.length === 0) {
                return null;
            }

            const decoded = decode(raw);
            const entries = this.validateEntries(decoded);

            if (entries.length === 0) {
                return null;
            }

            const storageData: StorageData = {
                entries: entries,
                version: HistoryStorage.STORAGE_VERSION
            };

            await writeFn(storageData);
            await fs.promises.unlink(uncompressedPath);
            console.log(`[HistoryStorage] Migrated from uncompressed: ${uncompressedPath}`);

            return entries;
        } catch (e) {
            console.warn(`[HistoryStorage] Error migrating from uncompressed (${uncompressedPath}):`, e);
            return null;
        }
    }

    private async migrateActiveIfNeeded(): Promise<QueryHistoryEntry[] | null> {
        if (this.migrationPromise) {
            return this.migrationPromise;
        }

        this.migrationPromise = (async () => {
            // Try JSON migration first
            let entries = await this.migrateFromJson(
                this.historyJsonPath,
                this.historyFilePath,
                (data) => this.writeCompressed(data)
            );

            if (entries) {
                return entries;
            }

            // Try uncompressed msgpack migration
            const uncompressedPath = this.historyFilePath.replace('.msgpack.gz', '.msgpack');
            entries = await this.migrateFromUncompressed(
                uncompressedPath,
                this.historyFilePath,
                (data) => this.writeCompressed(data)
            );

            return entries;
        })();

        return this.migrationPromise;
    }

    private async migrateArchiveIfNeededInternal(): Promise<QueryHistoryEntry[] | null> {
        if (this.archiveMigrationPromise) {
            return this.archiveMigrationPromise;
        }

        this.archiveMigrationPromise = (async () => {
            // Try JSON migration first
            let entries = await this.migrateFromJson(
                this.archiveJsonPath,
                this.archiveFilePath,
                (data) => this.writeArchiveCompressed(data)
            );

            if (entries) {
                return entries;
            }

            // Try uncompressed msgpack migration
            const uncompressedPath = this.archiveFilePath.replace('.msgpack.gz', '.msgpack');
            entries = await this.migrateFromUncompressed(
                uncompressedPath,
                this.archiveFilePath,
                (data) => this.writeArchiveCompressed(data)
            );

            return entries;
        })();

        return this.archiveMigrationPromise;
    }

    private async _getArchiveEntriesInternal(): Promise<QueryHistoryEntry[]> {
        try {
            // Check for migration
            const migrated = await this.migrateArchiveIfNeededInternal();
            if (migrated) {
                return migrated;
            }

            const exists = await this.fileExists(this.archiveFilePath);
            if (!exists) {
                return [];
            }

            const stored = await this.readArchiveCompressed();
            return this.validateEntries(stored);
        } catch (e) {
            console.error('[HistoryStorage] Error reading archive:', e);
            return [];
        }
    }

    public async loadActive(): Promise<QueryHistoryEntry[]> {
        return new Promise((resolve, reject) => {
            this.writeQueue = this.writeQueue.then(async () => {
                try {
                    // Check for migration
                    const migrated = await this.migrateActiveIfNeeded();
                    if (migrated) {
                        resolve(migrated);
                        return;
                    }

                    const exists = await this.fileExists(this.historyFilePath);
                    if (!exists) {
                        resolve([]);
                        return;
                    }

                    const stored = await this.readCompressed();
                    resolve(stored?.entries || []);
                } catch (e) {
                    console.warn('[HistoryStorage] Corrupted history file, returning empty:', e);
                    resolve([]);
                }
            }).catch(reject);
        });
    }

    public async saveActive(entries: QueryHistoryEntry[]): Promise<void> {
        const task = async () => {
            try {
                const data: StorageData = {
                    entries: entries,
                    version: HistoryStorage.STORAGE_VERSION
                };
                await this.writeCompressed(data);
            } catch (error) {
                console.error('[HistoryStorage] Error saving active history:', error);
            }
        };

        this.writeQueue = this.writeQueue.then(task, task);
        return this.writeQueue;
    }

    public async getArchiveEntries(): Promise<QueryHistoryEntry[]> {
        return new Promise((resolve, reject) => {
            this.archiveQueue = this.archiveQueue.then(async () => {
                try {
                    const entries = await this._getArchiveEntriesInternal();
                    resolve(entries);
                } catch (e) {
                    reject(e);
                }
            }).catch(reject);
        });
    }

    public async appendToArchive(newEntries: QueryHistoryEntry[]): Promise<void> {
        const task = async () => {
            try {
                const existing = await this._getArchiveEntriesInternal();

                // newEntries are items being archived (oldest from active)
                // existing are already archived items
                // Combined order: [newly archived (semi-old...old), existing (old+1...ancient)]
                const combined = [...newEntries, ...existing];

                // Filter out entries older than 2 years
                const filtered = this.filterEntriesByAge(combined);

                const data: StorageData = {
                    entries: filtered,
                    version: HistoryStorage.STORAGE_VERSION
                };

                await this.writeArchiveCompressed(data);

                // Log if any entries were removed
                const removedCount = combined.length - filtered.length;
                if (removedCount > 0) {
                    console.log(`[HistoryStorage] Removed ${removedCount} entries older than ${MAX_ARCHIVE_AGE_DAYS} days from archive`);
                }
            } catch (error) {
                console.error('[HistoryStorage] Error appending to archive:', error);
            }
        };

        this.archiveQueue = this.archiveQueue.then(task, task);
        return this.archiveQueue;
    }

    public async clearAll(): Promise<void> {
        // Wait for all pending operations
        await Promise.all([this.writeQueue, this.archiveQueue]);

        const filesToDelete = [
            this.historyFilePath,
            this.archiveFilePath,
            this.historyFilePath.replace('.msgpack.gz', '.msgpack'),
            this.archiveFilePath.replace('.msgpack.gz', '.msgpack'),
            this.historyJsonPath,
            this.archiveJsonPath,
            this.archiveMetadataPath,
        ];

        for (const filePath of filesToDelete) {
            try {
                const exists = await this.fileExists(filePath);
                if (exists) {
                    await fs.promises.unlink(filePath);
                }
            } catch (e) {
                console.error(`[HistoryStorage] Error deleting file ${filePath}:`, e);
            }
        }

        // Reset migration promises
        this.migrationPromise = null;
        this.archiveMigrationPromise = null;
        this.invalidateArchiveStats();
    }

    public async clearArchiveOnly(): Promise<void> {
        // Wait for pending archive operations
        await this.archiveQueue;

        const filesToDelete = [
            this.archiveFilePath,
            this.archiveFilePath.replace('.msgpack.gz', '.msgpack'),
            this.archiveJsonPath,
            this.archiveMetadataPath,
        ];

        for (const filePath of filesToDelete) {
            try {
                const exists = await this.fileExists(filePath);
                if (exists) {
                    await fs.promises.unlink(filePath);
                }
            } catch (e) {
                console.error(`[HistoryStorage] Error deleting archive file ${filePath}:`, e);
            }
        }

        // Reset archive migration promise
        this.archiveMigrationPromise = null;
        this.invalidateArchiveStats();
    }

    public async getStats(activeCount: number): Promise<HistoryStats> {
        // Active file size
        let activeSizeMB = 0;
        try {
            const exists = await this.fileExists(this.historyFilePath);
            if (exists) {
                const stats = await fs.promises.stat(this.historyFilePath);
                activeSizeMB = parseFloat((stats.size / (1024 * 1024)).toFixed(2));
            }
        } catch (e) {
            console.warn('[HistoryStorage] Error getting active file stats:', e);
        }

        // Archive file size and entry count
        let archiveStats: ArchiveStatsSnapshot = {
            archivedEntries: 0,
            archiveSizeMB: 0,
            archiveSizeBytes: 0,
            archiveMtimeMs: 0,
        };
        try {
            archiveStats = await this.getArchiveStats();
        } catch (e) {
            console.warn('[HistoryStorage] Error getting archive file stats:', e);
        }

        return {
            activeEntries: activeCount,
            archivedEntries: archiveStats.archivedEntries,
            totalEntries: archiveStats.archivedEntries === -1 ? activeCount : activeCount + archiveStats.archivedEntries,
            activeFileSizeMB: activeSizeMB,
            archiveFileSizeMB: archiveStats.archiveSizeMB,
            totalFileSizeMB: parseFloat((activeSizeMB + archiveStats.archiveSizeMB).toFixed(2))
        };
    }

    /**
     * Manually clean up old entries from archive
     * This can be called periodically to ensure old data is removed
     */
    public async cleanupArchive(): Promise<void> {
        const task = async () => {
            try {
                const existing = await this._getArchiveEntriesInternal();
                const filtered = this.filterEntriesByAge(existing);

                const removedCount = existing.length - filtered.length;
                if (removedCount > 0) {
                    const data: StorageData = {
                        entries: filtered,
                        version: HistoryStorage.STORAGE_VERSION
                    };

                    await this.writeArchiveCompressed(data);
                    console.log(`[HistoryStorage] Cleanup removed ${removedCount} entries older than ${MAX_ARCHIVE_AGE_DAYS} days from archive`);
                } else {
                    console.log('[HistoryStorage] No old entries to remove from archive');
                }
            } catch (error) {
                console.error('[HistoryStorage] Error cleaning up archive:', error);
            }
        };

        this.archiveQueue = this.archiveQueue.then(task, task);
        return this.archiveQueue;
    }
}
