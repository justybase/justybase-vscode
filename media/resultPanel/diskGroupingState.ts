export type DiskGroupingExpandedKeysProvider = (resultSetIndex: number) => string[];

let expandedKeysProvider: DiskGroupingExpandedKeysProvider = () => [];

/**
 * Keeps persistence independent from the disk grouping implementation. The
 * grouping module registers its state-backed provider during initialization.
 */
export function registerDiskGroupingExpandedKeysProvider(
    provider: DiskGroupingExpandedKeysProvider,
): void {
    expandedKeysProvider = provider;
}

export function getDiskGroupingExpandedKeys(resultSetIndex: number): string[] {
    return expandedKeysProvider(resultSetIndex);
}
