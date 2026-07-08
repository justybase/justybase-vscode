export const MAX_RANGE_CHART_ROWS = 500;
export const MAX_RANGE_CHART_COLUMNS = 20;
export const MIN_RANGE_CHART_CELLS = 4;

export interface RangeChartColumnMeta {
    id: string;
    header: string;
    dataType?: string;
    inferredNumericKind?: 'decimal' | 'integer' | 'none' | string;
}

export interface RangeChartCellSelection {
    row: number;
    col: number;
}

export interface RangeChartRowData {
    values: Record<string, unknown>;
}

export interface RangeChartSeries {
    name: string;
    columnId: string;
    values: number[];
}

export interface RangeChartDataset {
    categories: string[];
    series: RangeChartSeries[];
    categoryColumnId?: string;
    categoryColumnName?: string;
    availableCategoryColumns: Array<{ id: string; name: string }>;
    availableSeriesColumns: Array<{ id: string; name: string }>;
    warnings: string[];
    error?: string;
}

export interface ExtractRangeChartInput {
    selectedCells: RangeChartCellSelection[];
    columns: RangeChartColumnMeta[];
    rows: RangeChartRowData[];
}

const INTEGER_TYPE_ALIASES = new Set([
    'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'byteint',
    'serial', 'smallserial', 'bigserial', 'serial2', 'serial4', 'serial8',
    'int1', 'int2', 'int4', 'int8', 'int16', 'int32', 'int64',
    'utinyint', 'usmallint', 'uinteger', 'ubigint', 'hugeint', 'uhugeint',
    'uint8', 'uint16', 'uint32', 'uint64', '__inferred_integer__'
]);

const DECIMAL_TYPE_ALIASES = new Set([
    'numeric', 'decimal', 'dec', 'number', 'fixed', 'float', 'real', 'double',
    'double precision', 'money', 'smallmoney', '__inferred_decimal__'
]);

function extractBaseTypeName(type: string | undefined): string {
    if (!type) {
        return '';
    }
    return type.trim().toLowerCase().split('(')[0].trim();
}

export function isNumericColumn(column: RangeChartColumnMeta): boolean {
    if (column.inferredNumericKind === 'decimal' || column.inferredNumericKind === 'integer') {
        return true;
    }

    const baseType = extractBaseTypeName(column.dataType);
    return INTEGER_TYPE_ALIASES.has(baseType) || DECIMAL_TYPE_ALIASES.has(baseType);
}

export function parseNumericValue(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'bigint') {
        const asNumber = Number(value);
        return Number.isFinite(asNumber) ? asNumber : null;
    }

    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed || trimmed.toUpperCase() === 'NULL') {
        return null;
    }

    const normalized = trimmed.replace(/\s/g, '').replace(/,/g, '');
    if (!/^-?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(normalized)) {
        return null;
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function formatCategoryLabel(value: unknown, rowIndex: number): string {
    if (value === null || value === undefined || value === '') {
        return `Row ${rowIndex + 1}`;
    }

    return String(value);
}

function headersMatchColumns(firstRowValues: unknown[], columns: RangeChartColumnMeta[]): boolean {
    if (firstRowValues.length !== columns.length) {
        return false;
    }

    return firstRowValues.every((value, index) => {
        const header = String(columns[index]?.header ?? '').trim();
        if (!header) {
            return false;
        }
        return String(value ?? '').trim() === header;
    });
}

function getSelectionBounds(selectedCells: RangeChartCellSelection[]): {
    minRow: number;
    maxRow: number;
    minCol: number;
    maxCol: number;
} | null {
    if (selectedCells.length === 0) {
        return null;
    }

    const rows = selectedCells.map((cell) => cell.row);
    const cols = selectedCells.map((cell) => cell.col);

    return {
        minRow: Math.min(...rows),
        maxRow: Math.max(...rows),
        minCol: Math.min(...cols),
        maxCol: Math.max(...cols)
    };
}

function columnLooksNumericByValues(
    column: RangeChartColumnMeta,
    rowIndices: number[],
    rows: RangeChartRowData[],
    dataStartRow: number
): boolean {
    if (isNumericColumn(column)) {
        return true;
    }

    let numericCount = 0;
    let inspected = 0;

    for (const rowIndex of rowIndices) {
        if (rowIndex < dataStartRow) {
            continue;
        }

        const value = rows[rowIndex]?.values[column.id];
        if (value === null || value === undefined || value === '') {
            continue;
        }

        inspected += 1;
        if (parseNumericValue(value) !== null) {
            numericCount += 1;
        }
    }

    return inspected > 0 && numericCount === inspected;
}

export function extractRangeChartData(input: ExtractRangeChartInput): RangeChartDataset {
    const warnings: string[] = [];
    const bounds = getSelectionBounds(input.selectedCells);

    if (!bounds) {
        return {
            categories: [],
            series: [],
            availableCategoryColumns: [],
            availableSeriesColumns: [],
            warnings,
            error: 'No cells selected.'
        };
    }

    const rowCount = bounds.maxRow - bounds.minRow + 1;
    const colCount = bounds.maxCol - bounds.minCol + 1;

    if (input.selectedCells.length < MIN_RANGE_CHART_CELLS) {
        return {
            categories: [],
            series: [],
            availableCategoryColumns: [],
            availableSeriesColumns: [],
            warnings,
            error: 'Select at least a 2x2 range to create a chart.'
        };
    }

    if (rowCount > MAX_RANGE_CHART_ROWS || colCount > MAX_RANGE_CHART_COLUMNS) {
        return {
            categories: [],
            series: [],
            availableCategoryColumns: [],
            availableSeriesColumns: [],
            warnings,
            error: `Selection is too large (max ${MAX_RANGE_CHART_ROWS} rows and ${MAX_RANGE_CHART_COLUMNS} columns).`
        };
    }

    const selectedColumns = input.columns.slice(bounds.minCol, bounds.maxCol + 1);
    if (selectedColumns.length === 0) {
        return {
            categories: [],
            series: [],
            availableCategoryColumns: [],
            availableSeriesColumns: [],
            warnings,
            error: 'No data columns in selection.'
        };
    }

    const rowIndices: number[] = [];
    for (let rowIndex = bounds.minRow; rowIndex <= bounds.maxRow; rowIndex += 1) {
        rowIndices.push(rowIndex);
    }

    const firstRowValues = selectedColumns.map((column) => input.rows[bounds.minRow]?.values[column.id]);
    const hasHeaderRow = headersMatchColumns(firstRowValues, selectedColumns);
    const dataStartRow = hasHeaderRow ? bounds.minRow + 1 : bounds.minRow;
    const dataRowIndices = rowIndices.filter((rowIndex) => rowIndex >= dataStartRow);

    if (dataRowIndices.length === 0) {
        return {
            categories: [],
            series: [],
            availableCategoryColumns: [],
            availableSeriesColumns: [],
            warnings,
            error: 'Selection must include at least one data row.'
        };
    }

    const availableSeriesColumns = selectedColumns
        .filter((column) => columnLooksNumericByValues(column, dataRowIndices, input.rows, dataStartRow))
        .map((column) => ({ id: column.id, name: String(column.header || column.id) }));

    if (availableSeriesColumns.length === 0) {
        return {
            categories: [],
            series: [],
            availableCategoryColumns: selectedColumns.map((column) => ({
                id: column.id,
                name: String(column.header || column.id)
            })),
            availableSeriesColumns: [],
            warnings,
            error: 'Selection must include at least one numeric column.'
        };
    }

    const availableCategoryColumns = selectedColumns
        .filter((column) => !columnLooksNumericByValues(column, dataRowIndices, input.rows, dataStartRow))
        .map((column) => ({ id: column.id, name: String(column.header || column.id) }));

    const categoryColumn = availableCategoryColumns[0];
    const useSyntheticCategories = !categoryColumn;

    if (useSyntheticCategories) {
        warnings.push('No text column detected; using row labels for categories.');
    }

    const categories = dataRowIndices.map((rowIndex, index) => {
        if (useSyntheticCategories) {
            return `Row ${index + 1}`;
        }

        const value = input.rows[rowIndex]?.values[categoryColumn.id];
        return formatCategoryLabel(value, index);
    });

    const seriesColumns = selectedColumns.filter((column) =>
        availableSeriesColumns.some((seriesColumn) => seriesColumn.id === column.id)
        && (!categoryColumn || column.id !== categoryColumn.id)
    );

    const series: RangeChartSeries[] = seriesColumns.map((column) => ({
        name: String(column.header || column.id),
        columnId: column.id,
        values: dataRowIndices.map((rowIndex) => {
            const rawValue = input.rows[rowIndex]?.values[column.id];
            return parseNumericValue(rawValue) ?? 0;
        })
    }));

    if (hasHeaderRow) {
        warnings.push('First selected row treated as column headers.');
    }

    return {
        categories,
        series,
        categoryColumnId: categoryColumn?.id,
        categoryColumnName: categoryColumn?.name,
        availableCategoryColumns,
        availableSeriesColumns,
        warnings
    };
}

export function selectionHasNumericData(input: ExtractRangeChartInput): boolean {
    const dataset = extractRangeChartData(input);
    return !dataset.error && dataset.series.length > 0;
}

export function rebuildRangeChartData(
    baseInput: ExtractRangeChartInput,
    options: {
        /** Empty string forces synthetic row labels. */
        categoryColumnId?: string;
        seriesColumnIds?: string[];
    }
): RangeChartDataset {
    const dataset = extractRangeChartData(baseInput);
    if (dataset.error) {
        return dataset;
    }

    const bounds = getSelectionBounds(baseInput.selectedCells);
    if (!bounds) {
        return dataset;
    }

    const selectedColumns = baseInput.columns.slice(bounds.minCol, bounds.maxCol + 1);
    const rowIndices: number[] = [];
    for (let rowIndex = bounds.minRow; rowIndex <= bounds.maxRow; rowIndex += 1) {
        rowIndices.push(rowIndex);
    }

    const firstRowValues = selectedColumns.map((column) => baseInput.rows[bounds.minRow]?.values[column.id]);
    const hasHeaderRow = headersMatchColumns(firstRowValues, selectedColumns);
    const dataStartRow = hasHeaderRow ? bounds.minRow + 1 : bounds.minRow;
    const dataRowIndices = rowIndices.filter((rowIndex) => rowIndex >= dataStartRow);

    const useSyntheticCategories = options.categoryColumnId === '';
    const categoryColumn = useSyntheticCategories
        ? undefined
        : options.categoryColumnId
            ? selectedColumns.find((column) => column.id === options.categoryColumnId)
            : selectedColumns.find((column) => column.id === dataset.categoryColumnId);

    const seriesColumnIds = options.seriesColumnIds && options.seriesColumnIds.length > 0
        ? options.seriesColumnIds
        : dataset.series.map((item) => item.columnId);

    const categories = dataRowIndices.map((rowIndex, index) => {
        if (!categoryColumn) {
            return `Row ${index + 1}`;
        }

        const value = baseInput.rows[rowIndex]?.values[categoryColumn.id];
        return formatCategoryLabel(value, index);
    });

    const series: RangeChartSeries[] = seriesColumnIds
        .map((columnId) => selectedColumns.find((column) => column.id === columnId))
        .filter((column): column is RangeChartColumnMeta => Boolean(column))
        .map((column) => ({
            name: String(column.header || column.id),
            columnId: column.id,
            values: dataRowIndices.map((rowIndex) => {
                const rawValue = baseInput.rows[rowIndex]?.values[column.id];
                return parseNumericValue(rawValue) ?? 0;
            })
        }));

    return {
        ...dataset,
        categories,
        series,
        categoryColumnId: categoryColumn?.id,
        categoryColumnName: categoryColumn ? String(categoryColumn.header || categoryColumn.id) : undefined
    };
}
