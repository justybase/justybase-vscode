import type { DiskQuerySpec } from './types.js';

export function diskQuerySpecHasFilters(spec: DiskQuerySpec | undefined): boolean {
    if (!spec) {
        return false;
    }
    if (spec.globalSearch?.trim()) {
        return true;
    }
    return (spec.columnFilters ?? []).some((filter) => {
        if ((filter.conditions?.length ?? 0) > 0) {
            return true;
        }
        return (filter.values?.length ?? 0) > 0;
    });
}

export function diskQuerySpecIsActive(spec: DiskQuerySpec | undefined): boolean {
    if (!spec) {
        return false;
    }
    return diskQuerySpecHasFilters(spec) || (spec.sorting?.length ?? 0) > 0;
}
