import type { ResultSet } from '../types.js';

/**
 * Explicit data context for the Explore surface. Explore used to read the
 * legacy grid globals; keeping the context local lets the shared panel mount
 * Explore without booting the legacy result grid.
 */
export interface ExploreContext {
    readonly sourceUri?: string;
    readonly resultSetIndex: number;
    readonly resultSet?: ResultSet;
}

let current: ExploreContext = { resultSetIndex: 0 };

export function setExploreContext(context: ExploreContext): void {
    current = context;
}

export function clearExploreContext(): void {
    current = { resultSetIndex: 0 };
}

export function getExploreSourceUri(): string | undefined {
    return current.sourceUri;
}

export function getExploreResultSetIndex(): number {
    return current.resultSetIndex;
}

export function getExploreResultSetAt(index: number): ResultSet | undefined {
    return index === current.resultSetIndex ? current.resultSet : undefined;
}
