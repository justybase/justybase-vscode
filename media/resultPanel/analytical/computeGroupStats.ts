// In-browser grouped statistics engine for the Analytical view.
// Three passes over the loaded rows: (1) composite keys per row, (2) choose the largest groups,
// (3) per-group and population accumulation. The async driver yields to the UI between row chunks
// and stops when the caller cancels, so large results never block the webview for long.

import type { ExploreColumnRole } from '../explore/types.js';
import { parseNumericValue } from '../explore/columnClassification.js';
import { ColumnAccumulator } from './accumulators.js';
import { compareGroupKeys, decodeGroupKey, encodeGroupKey, formatGroupLabel } from './groupKey.js';
import { quartilesFromRanks, type Quartiles } from './quantiles.js';
import {
    ANALYTICAL_CHUNK_ROWS,
    ANALYTICAL_RARE_MAX_OCCURRENCES,
    ANALYTICAL_RARE_MAX_EXAMPLES,
    ANALYTICAL_GROUP_DISTINCT_CAP,
    ANALYTICAL_MAX_ANALYZED_COLUMNS,
    ANALYTICAL_MAX_GROUPS,
    ANALYTICAL_MAX_IN_MEMORY_ROWS,
    ANALYTICAL_MAX_KEYS,
    ANALYTICAL_POPULATION_DISTINCT_CAP,
    type AnalyticalColumnStats,
    type AnalyticalDataset,
    type AnalyticalGroup,
    type AnalyticalGroupColumnRef,
    type SkippedEvaluation,
} from './types.js';

/** Identifier-like columns (almost every value distinct) are excluded from the analysis. */
const IDENTIFIER_DISTINCT_RATIO = 0.9;
const IDENTIFIER_MIN_ROWS = 10;

/** Owner marker for a value seen in more than one group (or in a group that is not listed). */
const OWNER_SHARED = -2;
/** Rare-value gates: stricter than the identifier rule and only for columns with a useful spread. */
const RARE_MIN_DISTINCT = 3;
const RARE_MIN_NON_NULL = 100;
const RARE_MAX_DISTINCT_RATIO = 0.5;
const RARE_MIN_GROUPS = 3;

export interface GroupStatsColumn {
    index: number;
    name: string;
    role: ExploreColumnRole;
}

export interface GroupStatsInput {
    columns: readonly GroupStatsColumn[];
    rows: ReadonlyArray<readonly unknown[]>;
    groupColumns: readonly AnalyticalGroupColumnRef[];
    maxGroups?: number;
    /** Compute quartiles for numeric columns (robust mode). Costs one extra pass per column. */
    quantiles?: boolean;
}

/** Quartiles of one analysed column: the population and each kept group, keyed by output slot. */
interface ColumnQuartiles {
    population: Quartiles | null;
    bySlot: Map<number, Quartiles>;
}

export interface GroupStatsRunOptions {
    isCancelled?: () => boolean;
    yieldToUi?: () => Promise<void>;
    chunkRows?: number;
}

export class GroupStatsRowLimitError extends Error {
    constructor(readonly rowCount: number) {
        super(`Result has ${rowCount} rows, above the in-browser analysis limit of ${ANALYTICAL_MAX_IN_MEMORY_ROWS}`);
        this.name = 'GroupStatsRowLimitError';
    }
}

class GroupStatsBuilder {
    private readonly rowCount: number;
    private readonly groupIndexes: number[];
    private readonly analyzed: GroupStatsColumn[];
    private readonly analyzedTruncated: boolean;
    private readonly keyIdOfRow: Int32Array;
    private readonly keyIds = new Map<string, number>();
    private readonly keyNames: string[] = [];
    private readonly keyCounts: number[] = [];
    private unlistedRows = 0;
    private slotOfKey = new Int32Array(0);
    private keptKeyIds: number[] = [];
    private populationAcc: ColumnAccumulator[] = [];
    private groupAcc: Array<Array<ColumnAccumulator | undefined>> = [];
    /** Per analysed column: value -> id of the one group that holds it, or OWNER_SHARED. Null when not tracked. */
    private readonly ownerByValue: Array<Map<string, number> | null> = [];
    private readonly maxGroups: number;
    private readonly quantilesWanted: boolean;
    private quartilesByColumn: Array<ColumnQuartiles | undefined> = [];

    constructor(private readonly input: GroupStatsInput) {
        this.rowCount = input.rows.length;
        if (this.rowCount > ANALYTICAL_MAX_IN_MEMORY_ROWS) {
            throw new GroupStatsRowLimitError(this.rowCount);
        }
        this.maxGroups = input.maxGroups ?? ANALYTICAL_MAX_GROUPS;
        this.quantilesWanted = input.quantiles === true;
        this.groupIndexes = input.groupColumns.map(ref => ref.index);
        const groupSet = new Set(this.groupIndexes);
        const candidates = input.columns.filter(column => !groupSet.has(column.index));
        this.analyzedTruncated = candidates.length > ANALYTICAL_MAX_ANALYZED_COLUMNS;
        this.analyzed = candidates.slice(0, ANALYTICAL_MAX_ANALYZED_COLUMNS);
        this.keyIdOfRow = new Int32Array(this.rowCount);
        this.populationAcc = this.analyzed.map(column => new ColumnAccumulator(column.role, ANALYTICAL_POPULATION_DISTINCT_CAP));
        this.ownerByValue = this.analyzed.map(column => (
            column.role === 'dimension' || column.role === 'unknown' ? new Map<string, number>() : null
        ));
    }

    /** Pass 1: composite key per row. Rows whose key is new past the key cap are counted as unlisted. */
    keyRange(from: number, to: number): void {
        if (this.groupIndexes.length === 0) {
            return;
        }
        for (let i = from; i < to; i++) {
            const row = this.input.rows[i];
            const key = encodeGroupKey(this.groupIndexes.map(index => row[index]));
            let id = this.keyIds.get(key);
            if (id === undefined) {
                if (this.keyNames.length >= ANALYTICAL_MAX_KEYS) {
                    this.keyIdOfRow[i] = -1;
                    this.unlistedRows += 1;
                    continue;
                }
                id = this.keyNames.length;
                this.keyIds.set(key, id);
                this.keyNames.push(key);
                this.keyCounts.push(0);
            }
            this.keyCounts[id] += 1;
            this.keyIdOfRow[i] = id;
        }
    }

    /** Pass 2: pick the largest groups (ties broken by key) and map key ids to output slots. */
    selectGroups(): void {
        if (this.groupIndexes.length === 0) {
            this.slotOfKey = new Int32Array(0);
            this.keptKeyIds = [];
            return;
        }
        const order = this.keyNames.map((_, id) => id).sort((a, b) => {
            const byCount = this.keyCounts[b] - this.keyCounts[a];
            if (byCount !== 0) return byCount;
            return compareGroupKeys(this.keyNames[a], this.keyNames[b]);
        });
        this.keptKeyIds = order.slice(0, this.maxGroups);
        this.slotOfKey = new Int32Array(this.keyNames.length).fill(-1);
        this.keptKeyIds.forEach((id, slot) => {
            this.slotOfKey[id] = slot;
        });
        this.groupAcc = this.keptKeyIds.map(() => new Array<ColumnAccumulator | undefined>(this.analyzed.length));
        for (const id of order.slice(this.maxGroups)) {
            this.unlistedRows += this.keyCounts[id];
        }
    }

    /** Pass 3: accumulate population and kept-group statistics for every analysed column. */
    accumulateRange(from: number, to: number): void {
        for (let i = from; i < to; i++) {
            const row = this.input.rows[i];
            const id = this.keyIdOfRow[i];
            const slot = this.groupIndexes.length === 0 ? 0 : (id >= 0 ? this.slotOfKey[id] : -1);
            const groupCells = slot >= 0 ? this.groupAcc[slot] : undefined;
            for (let j = 0; j < this.analyzed.length; j++) {
                const column = this.analyzed[j];
                const value = row[column.index];
                this.populationAcc[j].add(value);
                this.trackOwner(j, value, id);
                if (groupCells) {
                    let acc = groupCells[j];
                    if (!acc) {
                        acc = new ColumnAccumulator(column.role, ANALYTICAL_GROUP_DISTINCT_CAP);
                        groupCells[j] = acc;
                    }
                    acc.add(value);
                }
            }
        }
    }

    /** Number of analysed columns that get quartiles (measures only, when requested). */
    quartileColumnCount(): number {
        return this.quantilesWanted ? this.analyzed.length : 0;
    }

    /**
     * Pass 4 (robust mode only), one column at a time: gathers the numeric values of the column per kept
     * group and for the population into typed arrays, sorts them and reads the quartiles. Only one
     * column's buffers exist at a time, so the peak is about two Float64Arrays of the column's size.
     */
    collectQuartiles(j: number): void {
        const column = this.analyzed[j];
        const populationCount = this.populationAcc[j].numericCount;
        if (column.role !== 'measure' || populationCount === 0) {
            this.quartilesByColumn[j] = { population: null, bySlot: new Map() };
            return;
        }
        const slots = this.keptKeyIds.length;
        const offsetOfSlot = new Float64Array(slots + 1);
        for (let slot = 0; slot < slots; slot++) {
            offsetOfSlot[slot + 1] = offsetOfSlot[slot] + (this.groupAcc[slot][j]?.numericCount ?? 0);
        }
        const groupValues = new Float64Array(offsetOfSlot[slots]);
        const populationValues = new Float64Array(populationCount);
        const cursor = Float64Array.from(offsetOfSlot.subarray(0, slots));
        let populationCursor = 0;

        for (let i = 0; i < this.rowCount; i++) {
            const value = this.input.rows[i][column.index];
            if (value === null || value === undefined || value === '') {
                continue;
            }
            const numeric = parseNumericValue(value);
            if (numeric === null) {
                continue;
            }
            populationValues[populationCursor++] = numeric;
            const id = this.keyIdOfRow[i];
            const slot = this.groupIndexes.length === 0 ? 0 : (id >= 0 ? this.slotOfKey[id] : -1);
            if (slot >= 0) {
                groupValues[cursor[slot]++] = numeric;
            }
        }

        const bySlot = new Map<number, Quartiles>();
        for (let slot = 0; slot < slots; slot++) {
            const start = offsetOfSlot[slot];
            const end = offsetOfSlot[slot + 1];
            if (end === start) continue;
            const sorted = groupValues.subarray(start, end).sort();
            const quartiles = quartilesFromRanks(sorted.length, index => sorted[index]);
            if (quartiles) bySlot.set(slot, quartiles);
        }
        populationValues.sort();
        const population = quartilesFromRanks(populationValues.length, index => populationValues[index]);
        this.quartilesByColumn[j] = { population, bySlot };
    }

    /** Records which group first holds a value; a second group (or an unlisted row) marks it shared. */
    private trackOwner(j: number, value: unknown, keyId: number): void {
        const owners = this.ownerByValue[j];
        if (!owners || value === null || value === undefined || value === '') {
            return;
        }
        const key = String(value);
        const owner = keyId >= 0 ? keyId : OWNER_SHARED;
        const seen = owners.get(key);
        if (seen === undefined) {
            if (owners.size >= ANALYTICAL_POPULATION_DISTINCT_CAP) {
                // Past the cap ownership is unknown for new values, so the column stops claiming rarity.
                this.ownerByValue[j] = null;
                return;
            }
            owners.set(key, owner);
        } else if (seen !== owner) {
            owners.set(key, OWNER_SHARED);
        }
    }

    /** RARE_VALUE per listed group: values that occur in no other group and at most a few times. */
    private collectRareValues(populationStats: readonly AnalyticalColumnStats[]): Map<number, Map<number, { total: number; examples: string[] }>> {
        const rareBySlot = new Map<number, Map<number, { total: number; examples: string[] }>>();
        const totalGroups = this.groupIndexes.length === 0 ? 0 : this.keyNames.length;
        if (totalGroups < RARE_MIN_GROUPS) {
            return rareBySlot;
        }
        this.analyzed.forEach((_column, j) => {
            const owners = this.ownerByValue[j];
            const stats = populationStats[j];
            const nonNull = stats.rowCount - stats.nullCount;
            const eligible = owners !== null
                && stats.distinctCount >= RARE_MIN_DISTINCT
                && !stats.distinctApprox
                && nonNull >= RARE_MIN_NON_NULL
                && stats.distinctCount / nonNull <= RARE_MAX_DISTINCT_RATIO;
            if (!eligible || !owners) {
                return;
            }
            const counts = this.populationAcc[j].topValues(Number.POSITIVE_INFINITY);
            for (const { value, count } of counts) {
                if (count > ANALYTICAL_RARE_MAX_OCCURRENCES) continue;
                const owner = owners.get(value);
                if (owner === undefined || owner < 0) continue;
                const slot = this.slotOfKey[owner];
                if (slot === undefined || slot < 0) continue;
                const perColumn = rareBySlot.get(slot) ?? new Map<number, { total: number; examples: string[] }>();
                const entry = perColumn.get(j) ?? { total: 0, examples: [] };
                entry.total += 1;
                entry.examples.push(value);
                perColumn.set(j, entry);
                rareBySlot.set(slot, perColumn);
            }
        });
        for (const perColumn of rareBySlot.values()) {
            for (const entry of perColumn.values()) {
                entry.examples = entry.examples.sort().slice(0, ANALYTICAL_RARE_MAX_EXAMPLES);
            }
        }
        return rareBySlot;
    }

    finish(): AnalyticalDataset {
        const totalRows = this.rowCount;
        const populationStats = this.populationAcc.map((acc, j) => acc.toStats(this.analyzed[j].index, this.analyzed[j].name));
        const rareBySlot = this.collectRareValues(populationStats);
        const identifierIndexes = new Set<number>();
        const kept: Array<{ column: GroupStatsColumn; j: number }> = [];
        this.analyzed.forEach((column, j) => {
            if (isIdentifierStats(populationStats[j], column.role)) {
                identifierIndexes.add(column.index);
            } else {
                kept.push({ column, j });
            }
        });
        for (const { j } of kept) {
            const quartiles = this.quartilesByColumn[j];
            if (!quartiles?.population) continue;
            const numeric = populationStats[j].numeric;
            if (numeric) numeric.quartiles = quartiles.population;
        }
        const population = kept.map(({ j }) => populationStats[j]);

        const groups: AnalyticalGroup[] = this.keptKeyIds.map((id, slot) => {
            const key = this.keyNames[id];
            const rowCount = this.keyCounts[id];
            const values = decodeGroupKey(key);
            const columns = kept.map(({ column, j }) => {
                const acc = this.groupAcc[slot][j] ?? new ColumnAccumulator(column.role, ANALYTICAL_GROUP_DISTINCT_CAP);
                const stats = acc.toStats(column.index, column.name);
                const rare = rareBySlot.get(slot)?.get(j);
                if (rare) {
                    stats.rare = { total: rare.total, examples: rare.examples };
                }
                const quartiles = this.quartilesByColumn[j]?.bySlot.get(slot);
                if (stats.numeric && quartiles) {
                    stats.numeric.quartiles = quartiles;
                }
                return stats;
            });
            return {
                key,
                values,
                label: formatGroupLabel(values),
                rowCount,
                share: totalRows > 0 ? rowCount / totalRows : 0,
                columns,
                flags: [],
                score: 0,
                anomalous: false,
            };
        });

        const excludedColumns = [
            ...this.groupIndexes,
            ...Array.from(identifierIndexes),
        ];

        // Report the rules the engine could not evaluate, so the view can say the analysis was partial.
        const skipped: SkippedEvaluation[] = [];
        this.analyzed.forEach((column, j) => {
            if (identifierIndexes.has(column.index)) return;
            if (column.role === 'dimension' || column.role === 'unknown') {
                const groupApprox = this.groupAcc.some(cells => cells[j]?.overflow === true);
                if (populationStats[j].distinctApprox || groupApprox) {
                    skipped.push({ columnIndex: column.index, rules: ['TOP_VALUE_DOMINANCE'], reason: 'approximate' });
                }
            }
            if (this.quantilesWanted && column.role === 'measure' && !this.quartilesByColumn[j]?.population) {
                skipped.push({ columnIndex: column.index, rules: ['MEAN_SHIFT', 'RANGE_OUTLIER', 'HIGH_VARIABILITY'], reason: 'not-numeric' });
            }
        });

        return {
            mode: 'memory',
            groupColumns: this.input.groupColumns.map(ref => ({ ...ref })),
            totalRows,
            examinedRows: totalRows,
            population,
            groups,
            totalGroups: this.groupIndexes.length === 0 ? 0 : this.keyNames.length,
            unlistedRows: this.unlistedRows,
            groupsTruncated: this.keptKeyIds.length < this.keyNames.length || this.unlistedRows > 0,
            analyzedColumnsTruncated: this.analyzedTruncated,
            excludedColumns,
            coverage: skipped.length > 0
                ? { quantiles: this.quantilesWanted, skipped }
                : { quantiles: this.quantilesWanted },
        };
    }
}

/** Shared by the in-memory and disk-backed paths so both exclude identifier-like columns the same way. */
export function isIdentifierStats(stats: AnalyticalColumnStats, role: ExploreColumnRole): boolean {
    if (role === 'measure') {
        return false;
    }
    if (stats.rowCount < IDENTIFIER_MIN_ROWS) {
        return false;
    }
    const nonNull = stats.rowCount - stats.nullCount;
    return nonNull > 0 && stats.distinctCount / nonNull >= IDENTIFIER_DISTINCT_RATIO;
}

/** Synchronous run, for tests and small results. */
export function computeGroupStatsSync(input: GroupStatsInput): AnalyticalDataset {
    const builder = new GroupStatsBuilder(input);
    const total = input.rows.length;
    for (let from = 0; from < total; from += ANALYTICAL_CHUNK_ROWS) {
        builder.keyRange(from, Math.min(total, from + ANALYTICAL_CHUNK_ROWS));
    }
    builder.selectGroups();
    for (let from = 0; from < total; from += ANALYTICAL_CHUNK_ROWS) {
        builder.accumulateRange(from, Math.min(total, from + ANALYTICAL_CHUNK_ROWS));
    }
    for (let j = 0; j < builder.quartileColumnCount(); j++) {
        builder.collectQuartiles(j);
    }
    return builder.finish();
}

/**
 * Cooperative run for the webview. Yields between chunks and returns null when cancelled,
 * so a superseded computation (new grouping, new execution, dispose) stops without a result.
 */
export async function computeGroupStats(
    input: GroupStatsInput,
    options: GroupStatsRunOptions = {},
): Promise<AnalyticalDataset | null> {
    const chunk = options.chunkRows ?? ANALYTICAL_CHUNK_ROWS;
    const isCancelled = options.isCancelled ?? (() => false);
    const yieldToUi = options.yieldToUi ?? (() => Promise.resolve());
    const builder = new GroupStatsBuilder(input);
    const total = input.rows.length;

    for (let from = 0; from < total; from += chunk) {
        if (isCancelled()) return null;
        builder.keyRange(from, Math.min(total, from + chunk));
        await yieldToUi();
    }
    if (isCancelled()) return null;
    builder.selectGroups();

    for (let from = 0; from < total; from += chunk) {
        if (isCancelled()) return null;
        builder.accumulateRange(from, Math.min(total, from + chunk));
        await yieldToUi();
    }
    for (let j = 0; j < builder.quartileColumnCount(); j++) {
        if (isCancelled()) return null;
        builder.collectQuartiles(j);
        await yieldToUi();
    }
    if (isCancelled()) return null;
    return builder.finish();
}
