import type { ERDData, TableNode } from '../../src/schema/erdProvider';

export interface LayoutPoint {
    x: number;
    y: number;
}

interface StoredLayout {
    version: number;
    positions: Record<string, LayoutPoint>;
}

const TABLE_WIDTH = 284;
const COLUMN_GAP = 390;
const ROW_GAP = 230;
const INITIAL_MARGIN = 80;

export function buildTableAliases(tables: TableNode[]): Map<string, string> {
    const aliases = new Map<string, string>();
    for (const table of tables) {
        aliases.set(normalizeName(table.fullName), table.fullName);
        aliases.set(normalizeName(`${table.schema}.${table.tableName}`), table.fullName);
        const shortName = normalizeName(table.tableName);
        if (!aliases.has(shortName)) aliases.set(shortName, table.fullName);
    }
    return aliases;
}

/**
 * Build a stable, component-aware layered layout without a runtime graph
 * dependency. Relationship components are arranged left-to-right by BFS
 * level, while disconnected tables form their own compact components.
 */
export function computeInitialLayout(data: ERDData, aliases: Map<string, string>): Map<string, LayoutPoint> {
    const adjacency = new Map<string, Set<string>>();
    data.tables.forEach(table => adjacency.set(table.fullName, new Set()));

    for (const relationship of data.relationships) {
        const source = aliases.get(normalizeName(relationship.fromTable));
        const target = aliases.get(normalizeName(relationship.toTable));
        if (!source || !target || source === target) continue;
        adjacency.get(source)?.add(target);
        adjacency.get(target)?.add(source);
    }

    const components: string[][] = [];
    const visited = new Set<string>();
    for (const table of data.tables) {
        if (visited.has(table.fullName)) continue;
        const component: string[] = [];
        const queue = [table.fullName];
        visited.add(table.fullName);
        while (queue.length) {
            const current = queue.shift();
            if (!current) continue;
            component.push(current);
            const neighbors = [...(adjacency.get(current) ?? [])].sort((a, b) => a.localeCompare(b));
            for (const neighbor of neighbors) {
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    queue.push(neighbor);
                }
            }
        }
        components.push(component);
    }

    components.sort((a, b) => {
        const degree = (key: string) => adjacency.get(key)?.size ?? 0;
        const aMax = Math.max(...a.map(degree));
        const bMax = Math.max(...b.map(degree));
        return bMax - aMax || a[0].localeCompare(b[0]);
    });

    const positions = new Map<string, LayoutPoint>();
    let cursorX = INITIAL_MARGIN;
    let cursorY = INITIAL_MARGIN;
    let rowHeight = 0;

    for (const component of components) {
        const root = [...component].sort((a, b) => {
            const degreeDifference = (adjacency.get(b)?.size ?? 0) - (adjacency.get(a)?.size ?? 0);
            return degreeDifference || a.localeCompare(b);
        })[0];

        const levels = buildLevels(root, component, adjacency);
        const maxLevelSize = Math.max(...levels.map(level => level.length), 1);
        const componentWidth = Math.max(1, levels.length) * COLUMN_GAP + TABLE_WIDTH;
        const componentHeight = Math.max(1, maxLevelSize) * ROW_GAP + 150;

        if (cursorX > INITIAL_MARGIN && cursorX + componentWidth > 2200) {
            cursorX = INITIAL_MARGIN;
            cursorY += rowHeight + 160;
            rowHeight = 0;
        }

        levels.forEach((level, levelIndex) => {
            const levelHeight = Math.max(1, level.length) * ROW_GAP;
            const offsetY = cursorY + Math.max(0, (componentHeight - levelHeight) / 2);
            level.forEach((key, index) => {
                positions.set(key, {
                    x: cursorX + levelIndex * COLUMN_GAP,
                    y: offsetY + index * ROW_GAP
                });
            });
        });

        cursorX += componentWidth + 180;
        rowHeight = Math.max(rowHeight, componentHeight);
    }

    return positions;
}

export function restorePositions(
    initial: Map<string, LayoutPoint>,
    raw: string | null,
    expectedVersion: number
): Map<string, LayoutPoint> {
    const positions = new Map(initial);
    if (!raw) return positions;

    const stored = JSON.parse(raw) as Partial<StoredLayout>;
    if (stored.version !== expectedVersion || !stored.positions) return positions;

    for (const [tableKey, position] of Object.entries(stored.positions)) {
        if (
            positions.has(tableKey)
            && typeof position?.x === 'number'
            && typeof position?.y === 'number'
            && Number.isFinite(position.x)
            && Number.isFinite(position.y)
        ) {
            positions.set(tableKey, { x: position.x, y: position.y });
        }
    }
    return positions;
}

export function normalizeName(value: string): string {
    return value.trim().toLocaleUpperCase();
}

function buildLevels(root: string, component: string[], adjacency: Map<string, Set<string>>): string[][] {
    const componentSet = new Set(component);
    const distances = new Map<string, number>([[root, 0]]);
    const queue = [root];

    while (queue.length) {
        const current = queue.shift();
        if (!current) continue;
        const neighbors = [...(adjacency.get(current) ?? [])]
            .filter(neighbor => componentSet.has(neighbor))
            .sort((a, b) => a.localeCompare(b));
        for (const neighbor of neighbors) {
            if (!distances.has(neighbor)) {
                distances.set(neighbor, (distances.get(current) ?? 0) + 1);
                queue.push(neighbor);
            }
        }
    }

    const levels: string[][] = [];
    for (const key of component) {
        const level = distances.get(key) ?? 0;
        levels[level] ??= [];
        levels[level].push(key);
    }
    levels.forEach(level => level.sort((a, b) => a.localeCompare(b)));
    return levels;
}
