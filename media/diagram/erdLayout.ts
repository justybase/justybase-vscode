import type { ERDData } from '../../src/schema/erdProvider';
import { computeInitialLayout, restorePositions } from '../erdView/layout';
import type { LayoutPoint } from '../erdView/layout';

export const ERD_LAYOUT_VERSION = 2 as const;

export interface ErdViewport {
    x: number;
    y: number;
    zoom: number;
}

export interface ErdSavedLayout {
    version: 2;
    positions: Record<string, LayoutPoint>;
    viewport?: ErdViewport;
}

export interface ErdLayoutState {
    positions: Map<string, LayoutPoint>;
    viewport?: ErdViewport;
}

function storageAvailable(): Storage | undefined {
    try {
        return typeof window !== 'undefined' && window.localStorage ? window.localStorage : undefined;
    } catch {
        return undefined;
    }
}

export function erdLayoutKey(data: Pick<ERDData, 'database' | 'schema'>, version: number = ERD_LAYOUT_VERSION): string {
    return `netezza.erd.layout.v${version}:${data.database}.${data.schema}`;
}

function validPoint(value: unknown): value is LayoutPoint {
    if (!value || typeof value !== 'object') return false;
    const point = value as { x?: unknown; y?: unknown };
    return typeof point.x === 'number' && Number.isFinite(point.x)
        && typeof point.y === 'number' && Number.isFinite(point.y);
}

function parseLayout(raw: string | null): { version?: number; positions?: Record<string, LayoutPoint>; viewport?: unknown } | undefined {
    if (!raw) return undefined;
    try {
        const parsed = JSON.parse(raw) as Partial<ErdSavedLayout>;
        return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
        return undefined;
    }
}

export function loadErdLayout(data: ERDData): ErdLayoutState {
    const initial = computeInitialLayout(data, buildAliasesFromData(data));
    const storage = storageAvailable();
    if (!storage) return { positions: initial };

    const v2 = parseLayout(storage.getItem(erdLayoutKey(data)));
    if (v2?.version === ERD_LAYOUT_VERSION && v2.positions) {
        const positions = new Map(initial);
        for (const [tableKey, position] of Object.entries(v2.positions)) {
            if (positions.has(tableKey) && validPoint(position)) positions.set(tableKey, position);
        }
        return { positions, viewport: validViewport(v2.viewport) ? v2.viewport : undefined };
    }

    // v1 stored only positions. Read it once and expose the migrated result to
    // the caller; the next save writes the v2 envelope.
    const legacy = parseLayout(storage.getItem(erdLayoutKey(data, 1)));
    if (legacy?.version === 1 && legacy.positions) {
        const restored = restorePositions(initial, JSON.stringify(legacy), 1);
        return { positions: restored };
    }
    return { positions: initial };
}

function validViewport(value: unknown): value is ErdViewport {
    if (!value || typeof value !== 'object') return false;
    const viewport = value as Partial<ErdViewport>;
    return Number.isFinite(viewport.x) && Number.isFinite(viewport.y) && Number.isFinite(viewport.zoom);
}

function buildAliasesFromData(data: ERDData): Map<string, string> {
    const aliases = new Map<string, string>();
    for (const table of data.tables) {
        aliases.set(table.fullName.toLocaleUpperCase(), table.fullName);
        aliases.set(`${table.schema}.${table.tableName}`.toLocaleUpperCase(), table.fullName);
        aliases.set(table.tableName.toLocaleUpperCase(), table.fullName);
    }
    return aliases;
}

export function saveErdLayout(data: ERDData, positions: Map<string, LayoutPoint>, viewport?: ErdViewport): void {
    const storage = storageAvailable();
    if (!storage) return;
    const saved: ErdSavedLayout = {
        version: ERD_LAYOUT_VERSION,
        positions: Object.fromEntries([...positions.entries()].filter(([key]) => data.tables.some(table => table.fullName === key))),
        viewport,
    };
    try {
        storage.setItem(erdLayoutKey(data), JSON.stringify(saved));
    } catch {
        // Webviews can run with storage disabled or full. The in-memory layout
        // remains usable and is the safe fallback.
    }
}
