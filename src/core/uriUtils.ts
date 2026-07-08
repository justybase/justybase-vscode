/**
 * Normalize URI key for consistent map lookups.
 * Handles Windows drive letter casing differences.
 */
export function normalizeUriKey(uri: string): string {
    if (uri.startsWith('file:///')) {
        const driveMatch = uri.match(/^file:\/\/\/([A-Z]):\//i);
        if (driveMatch) {
            const drive = driveMatch[1].toLowerCase();
            return `file:///${drive}:${uri.substring(10)}`;
        }
    }

    return uri;
}
