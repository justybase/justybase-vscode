import * as fs from 'node:fs';
import type { ColumnDefinition } from '../../src/types';

export type DataGridProfile =
    | 'small'
    | 'inline'
    | 'worker-boundary-19999'
    | 'worker-boundary-20000'
    | 'large'
    | 'wide';

export interface DataGridProfileDefinition {
    profile: DataGridProfile;
    rowCount: number;
    columnCount: number;
}

export interface DataGridDataset {
    profile: DataGridProfile;
    rowCount: number;
    columnCount: number;
    columns: ColumnDefinition[];
    rows: unknown[][];
    searchTerms: {
        start: string;
        middle: string;
        missing: string;
    };
}

const PROFILE_DEFINITIONS: readonly DataGridProfileDefinition[] = [
    { profile: 'small', rowCount: 1_000, columnCount: 8 },
    { profile: 'inline', rowCount: 10_000, columnCount: 8 },
    { profile: 'worker-boundary-19999', rowCount: 19_999, columnCount: 8 },
    { profile: 'worker-boundary-20000', rowCount: 20_000, columnCount: 8 },
    { profile: 'large', rowCount: 100_000, columnCount: 16 },
    { profile: 'wide', rowCount: 10_000, columnCount: 32 },
];

const BASE_COLUMNS: readonly ColumnDefinition[] = [
    { name: 'ID', type: 'INTEGER' },
    { name: 'AMOUNT', type: 'NUMERIC(18,2)' },
    { name: 'NAME', type: 'VARCHAR(160)' },
    { name: 'EVENT_DATE', type: 'DATE' },
    { name: 'EVENT_AT', type: 'TIMESTAMP' },
    { name: 'ACTIVE', type: 'BOOLEAN' },
    { name: 'OPTIONAL_TEXT', type: 'VARCHAR(180)' },
    { name: 'LONG_TEXT', type: 'VARCHAR(512)' },
    { name: 'CATEGORY', type: 'VARCHAR(32)' },
    { name: 'RATIO', type: 'DOUBLE' },
    { name: 'QUANTITY', type: 'INTEGER' },
    { name: 'REFERENCE', type: 'VARCHAR(48)' },
    { name: 'OPTIONAL_AMOUNT', type: 'NUMERIC(18,2)' },
    { name: 'SEARCH_LABEL', type: 'VARCHAR(64)' },
    { name: 'RANKING', type: 'INTEGER' },
    { name: 'PAYLOAD', type: 'VARCHAR(256)' },
];

export const DATA_GRID_PROFILES = PROFILE_DEFINITIONS;
export const DATA_GRID_SEED = 0x5eed_2026;

export function getDataGridProfile(profile: DataGridProfile): DataGridProfileDefinition {
    const definition = PROFILE_DEFINITIONS.find((candidate) => candidate.profile === profile);
    if (!definition) {
        throw new Error(`Unknown data-grid benchmark profile: ${profile}`);
    }
    return definition;
}

function deterministicValue(index: number, salt: number): number {
    // A small integer mixer keeps generated values repeatable without Math.random().
    let value = (DATA_GRID_SEED ^ (index * 0x45d9f3b) ^ salt) >>> 0;
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
    value = Math.imul(value ^ (value >>> 13), 0x45d9f3b) >>> 0;
    return (value ^ (value >>> 16)) >>> 0;
}

function isoDate(index: number): string {
    const month = (index % 12) + 1;
    const day = (index % 28) + 1;
    return `2024-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isoTimestamp(index: number): string {
    return `${isoDate(index)} ${String(index % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:30`;
}

function longText(index: number): string {
    const base = `deterministic long value ${String(index).padStart(6, '0')} — import export search fixture `;
    return `${base}${'x'.repeat(96 + (index % 128))}`;
}

function buildColumns(columnCount: number): ColumnDefinition[] {
    return Array.from({ length: columnCount }, (_unused, index) => {
        const base = BASE_COLUMNS[index];
        if (base) {
            return { ...base };
        }
        return {
            name: `EXTRA_${String(index + 1).padStart(2, '0')}`,
            type: index % 3 === 0 ? 'INTEGER' : 'VARCHAR(96)',
        };
    });
}

function buildRow(index: number, columnCount: number, rowCount: number): unknown[] {
    const middleIndex = Math.floor(rowCount / 2);
    const row: unknown[] = [
        index + 1,
        Number((((deterministicValue(index, 1) % 100_000) / 100) - 250).toFixed(2)),
        index === 0
            ? `needle-start customer-${String(index).padStart(6, '0')}`
            : index === middleIndex
                ? `needle-middle customer-${String(index).padStart(6, '0')}`
                : `customer-${String(index).padStart(6, '0')}`,
        isoDate(index),
        isoTimestamp(index),
        index % 3 !== 0,
        index % 11 === 0 ? null : `optional-${index % 19}`,
        longText(index),
        ['engineering', 'finance', 'operations', 'sales', 'support'][index % 5],
        Number(((deterministicValue(index, 2) % 10_000) / 997).toFixed(4)),
        deterministicValue(index, 3) % 500,
        `ref-${(deterministicValue(index, 4) % 1_000_000).toString(16).padStart(6, '0')}`,
        index % 13 === 0 ? null : Number(((index % 10_000) / 3).toFixed(2)),
        index === 0 ? 'search-start' : index === middleIndex ? 'search-middle' : `label-${index % 23}`,
        (deterministicValue(index, 5) % 100) + 1,
        `payload-${String(index).padStart(6, '0')}-${'p'.repeat(32 + (index % 48))}`,
    ];

    while (row.length < columnCount) {
        const columnIndex = row.length;
        row.push(columnIndex % 3 === 0 ? deterministicValue(index, columnIndex) % 10_000 : `extra-${columnIndex}-${index % 37}`);
    }
    return row.slice(0, columnCount);
}

export function buildDataGridDataset(profile: DataGridProfile): DataGridDataset {
    const definition = getDataGridProfile(profile);
    const columns = buildColumns(definition.columnCount);
    const rows = Array.from(
        { length: definition.rowCount },
        (_unused, index) => buildRow(index, definition.columnCount, definition.rowCount),
    );
    return {
        profile,
        rowCount: definition.rowCount,
        columnCount: definition.columnCount,
        columns,
        rows,
        searchTerms: {
            start: 'needle-start',
            middle: 'needle-middle',
            missing: 'needle-absent',
        },
    };
}

export function countDatasetMatches(dataset: DataGridDataset, query: string): number {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
        return dataset.rows.length;
    }
    return dataset.rows.filter((row) => row.some((cell) => String(cell ?? 'NULL').toLowerCase().includes(normalized))).length;
}

function csvValue(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function writeDatasetCsv(dataset: DataGridDataset, filePath: string): number {
    const lines = [dataset.columns.map((column) => csvValue(column.name)).join(',')];
    for (const row of dataset.rows) {
        lines.push(row.map(csvValue).join(','));
    }
    const content = `${lines.join('\n')}\n`;
    fs.writeFileSync(filePath, content, 'utf8');
    return Buffer.byteLength(content, 'utf8');
}

export function estimateDatasetBytes(dataset: DataGridDataset): number {
    return Buffer.byteLength(JSON.stringify(dataset.rows), 'utf8');
}
