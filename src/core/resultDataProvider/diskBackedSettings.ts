import { getExtensionConfiguration } from '../../compatibility/configuration';
import {
    DISK_BACKED_DEFAULT_MEMORY_ROW_THRESHOLD,
    DISK_BACKED_DEFAULT_MEMORY_BYTE_THRESHOLD,
    DISK_BACKED_DEFAULT_ROW_THRESHOLD,
} from './types';
import type { DiskBackedResultsSettings } from './types';

const DEFAULT_ENABLED = true;
const DEFAULT_ROW_THRESHOLD = DISK_BACKED_DEFAULT_ROW_THRESHOLD;
const DEFAULT_MEMORY_ROW_THRESHOLD = DISK_BACKED_DEFAULT_MEMORY_ROW_THRESHOLD;
const DEFAULT_INSERT_BATCH_SIZE = 50_000;
const DEFAULT_IDLE_SPILL_MINUTES = 0;
const DEFAULT_IDLE_SPILL_ROW_THRESHOLD = 10_000;

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
