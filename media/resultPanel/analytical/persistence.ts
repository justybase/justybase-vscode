// Per-result persistence for the Analytical view, kept in webview host state (_analyticalStates).
// Mirrors the Explore persistence contract: one entry per result identity, capped at 50 entries.

import { getHostState, setHostState } from '../protocol.js';
import type { AnalyticalPersistedState } from './types.js';

const MAX_PERSISTED_RESULTS = 50;

interface HostAnalyticalStateHolder {
    _analyticalStates?: Record<string, AnalyticalPersistedState>;
}

export function loadAnalyticalStateRaw(key: string): unknown {
    const hostState = getHostState() as HostAnalyticalStateHolder | null;
    return hostState?._analyticalStates?.[key];
}

export function saveAnalyticalState(key: string, state: AnalyticalPersistedState): void {
    const hostState = (getHostState() as HostAnalyticalStateHolder | null) || {};
    if (!hostState._analyticalStates) {
        hostState._analyticalStates = {};
    }
    hostState._analyticalStates[key] = state;
    for (const oldKey of Object.keys(hostState._analyticalStates)) {
        if (Object.keys(hostState._analyticalStates).length <= MAX_PERSISTED_RESULTS) break;
        if (oldKey !== key) delete hostState._analyticalStates[oldKey];
    }
    setHostState(hostState);
}
