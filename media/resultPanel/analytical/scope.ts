// Analysis scope of the Analytical view.
//
// The SQL Results panel always analyses the whole result (no provider is registered). The Analysis
// Document registers a provider, so its scope toggle can switch the analysis between the full result
// and the rows that survive the active filters — in memory by the shared predicate, on disk by the
// store's scoped group statistics.

import type { DiskQuerySpec } from '../types.js';

let scopeProvider: (() => DiskQuerySpec | undefined) | undefined;

export function setAnalyticalScopeProvider(provider: (() => DiskQuerySpec | undefined) | undefined): void {
    scopeProvider = provider;
}

export function getAnalyticalScope(): DiskQuerySpec | undefined {
    return scopeProvider?.();
}

/** Suffix that makes the compute cache invalidate when the scope changes. */
export function analyticalScopeKey(spec: DiskQuerySpec | undefined): string {
    if (!spec) {
        return 'scope:full';
    }
    return `scope:${JSON.stringify(spec)}`;
}
