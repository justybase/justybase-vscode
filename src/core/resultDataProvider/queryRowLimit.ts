import { getExtensionConfiguration } from '../../compatibility/configuration';
import { diskBackedStoreRegistry } from './diskBackedStoreRegistry';
import {
  getDiskBackedResultsSettings,
  getDiskBudgetBytes,
  isDiskBackedResultsAvailable,
} from './diskBackedSettings';

/**
 * Resolves how many rows a query execution may fetch.
 *
 * Disk-backed results stream rows into SQLite once the spill threshold is
 * reached, so `justybase.query.rowLimit` no longer has to truncate a user
 * query at that point. The full result reaches the grid and the configured
 * row cap keeps protecting memory-only executions. An explicit per-query cap
 * (catalog lookups, analysis, exports, previews) always wins.
 */
export function resolveQueryMaxRows(configuredRowLimit: number, explicitMaxRows?: number): number {
  if (explicitMaxRows !== undefined) return explicitMaxRows;

  const queryConfig = getExtensionConfiguration('query');
  if (queryConfig.get<boolean>('enforceRowLimitWhenDiskBacked', false) === true) {
    return configuredRowLimit;
  }

  const settings = getDiskBackedResultsSettings();
  if (!isDiskBackedResultsAvailable(settings)) return configuredRowLimit;

  // Once the shared on-disk budget is spent a new store cannot spill, so the
  // memory-only row cap is the last remaining guard against unbounded growth.
  if (diskBackedStoreRegistry.totalDiskBytes() >= getDiskBudgetBytes(settings)) {
    return configuredRowLimit;
  }

  return Number.MAX_SAFE_INTEGER;
}
