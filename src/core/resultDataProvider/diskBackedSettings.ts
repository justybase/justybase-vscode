import { getExtensionConfiguration } from '../../compatibility/configuration';
import {
    DISK_BACKED_DEFAULT_BUDGET_BYTES,
    DISK_BACKED_DEFAULT_MEMORY_ROW_THRESHOLD,
    DISK_BACKED_DEFAULT_MEMORY_BYTE_THRESHOLD,
    DISK_BACKED_DEFAULT_ROW_THRESHOLD,
    DISK_BACKED_MAX_BUDGET_BYTES,
    DISK_BACKED_MIN_BUDGET_BYTES,
} from './types';
import type { DiskBackedResultsSettings } from './types';

const DEFAULT_ENABLED = true;
const DEFAULT_ROW_THRESHOLD = DISK_BACKED_DEFAULT_ROW_THRESHOLD;
const DEFAULT_MEMORY_ROW_THRESHOLD = DISK_BACKED_DEFAULT_MEMORY_ROW_THRESHOLD;
const DEFAULT_INSERT_BATCH_SIZE = 50_000;
const DEFAULT_IDLE_SPILL_MINUTES = 0;
const DEFAULT_IDLE_SPILL_ROW_THRESHOLD = 10_000;
const DEFAULT_DISK_BUDGET_MB = DISK_BACKED_DEFAULT_BUDGET_BYTES / (1024 * 1024);
const MIN_DISK_BUDGET_MB = DISK_BACKED_MIN_BUDGET_BYTES / (1024 * 1024);
const MAX_DISK_BUDGET_MB = DISK_BACKED_MAX_BUDGET_BYTES / (1024 * 1024);

/** Converts the configured megabyte value to bytes and clamps it to the supported rails. */
export function resolveDiskBudgetBytes(megabytes: number | undefined): number {
    const requested = Number.isFinite(megabytes) ? Number(megabytes) : DEFAULT_DISK_BUDGET_MB;
    const clampedMb = Math.min(MAX_DISK_BUDGET_MB, Math.max(MIN_DISK_BUDGET_MB, Math.trunc(requested)));
    return clampedMb * 1024 * 1024;
}

/** Effective on-disk budget; partial settings objects from tests fall back to the default. */
export function getDiskBudgetBytes(
    settings: DiskBackedResultsSettings = getDiskBackedResultsSettings(),
): number {
    const configured = settings.diskBudgetBytes;
    return Number.isFinite(configured) && (configured as number) > 0
        ? (configured as number)
        : DISK_BACKED_DEFAULT_BUDGET_BYTES;
}

export function getDiskBackedResultsSettings(): DiskBackedResultsSettings {
    const config = getExtensionConfiguration('results');
    return {
        enabled: config.get<boolean>('diskBackedResults.enabled', DEFAULT_ENABLED) ?? DEFAULT_ENABLED,
        rowThreshold: config.get<number>('diskBackedResults.rowThreshold', DEFAULT_ROW_THRESHOLD)
            ?? DEFAULT_ROW_THRESHOLD,
        memoryRowThreshold: config.get<number>(
            'diskBackedResults.memoryRowThreshold',
            DEFAULT_MEMORY_ROW_THRESHOLD,
        ) ?? DEFAULT_MEMORY_ROW_THRESHOLD,
        memoryByteThreshold: config.get<number>(
            'diskBackedResults.memoryByteThreshold',
            DISK_BACKED_DEFAULT_MEMORY_BYTE_THRESHOLD,
        ) ?? DISK_BACKED_DEFAULT_MEMORY_BYTE_THRESHOLD,
        insertBatchSize: config.get<number>('diskBackedResults.insertBatchSize', DEFAULT_INSERT_BATCH_SIZE)
            ?? DEFAULT_INSERT_BATCH_SIZE,
        idleSpillMinutes: config.get<number>('diskBackedResults.idleSpillMinutes', DEFAULT_IDLE_SPILL_MINUTES)
            ?? DEFAULT_IDLE_SPILL_MINUTES,
        idleSpillRowThreshold: config.get<number>(
            'diskBackedResults.idleSpillRowThreshold',
            DEFAULT_IDLE_SPILL_ROW_THRESHOLD,
        ) ?? DEFAULT_IDLE_SPILL_ROW_THRESHOLD,
        diskBudgetBytes: resolveDiskBudgetBytes(
            config.get<number>('diskBackedResults.diskBudgetMb', DEFAULT_DISK_BUDGET_MB),
        ),
    };
}

/** Row count at which in-memory buffers should spill to SQLite. */
export function getEffectiveSpillThreshold(settings: DiskBackedResultsSettings = getDiskBackedResultsSettings()): number {
    return Math.min(settings.memoryRowThreshold, settings.rowThreshold);
}

export function isDiskBackedResultsAvailable(settings: DiskBackedResultsSettings = getDiskBackedResultsSettings()): boolean {
    if (!settings.enabled) {
        return false;
    }
    try {
         
        require('node:sqlite');
        return true;
    } catch {
        return false;
    }
}
