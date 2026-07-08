import {
    extractRangeChartData,
    parseNumericValue,
    rebuildRangeChartData,
    selectionHasNumericData,
    type ExtractRangeChartInput,
    type RangeChartColumnMeta
} from '../../core/rangeChart/rangeChartData';

const columns: RangeChartColumnMeta[] = [
    { id: 'name', header: 'Name', dataType: 'varchar' },
    { id: 'jan', header: 'Jan', dataType: 'integer' },
    { id: 'feb', header: 'Feb', dataType: 'integer' },
    { id: 'mar', header: 'Mar', dataType: 'integer' }
];

const rows = [
    { values: { name: 'Ella Jacoby', jan: 99407, feb: 80305, mar: 97786 } },
    { values: { name: 'Sophia Hayden', jan: 98344, feb: 79271, mar: 96608 } },
    { values: { name: 'Ruby Thanh', jan: 96408, feb: 68281, mar: 79970 } }
];

function buildInput(selectedCells: Array<{ row: number; col: number }>): ExtractRangeChartInput {
    return { selectedCells, columns, rows };
}

describe('rangeChartData', () => {
    it('maps a name column and numeric month columns into chart series', () => {
        const dataset = extractRangeChartData(buildInput([
            { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 0, col: 3 },
            { row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 }, { row: 1, col: 3 },
            { row: 2, col: 0 }, { row: 2, col: 1 }, { row: 2, col: 2 }, { row: 2, col: 3 }
        ]));

        expect(dataset.error).toBeUndefined();
        expect(dataset.categories).toEqual(['Ella Jacoby', 'Sophia Hayden', 'Ruby Thanh']);
        expect(dataset.series.map((series) => series.name)).toEqual(['Jan', 'Feb', 'Mar']);
        expect(dataset.series[0].values).toEqual([99407, 98344, 96408]);
    });

    it('uses synthetic row labels when only numeric columns are selected', () => {
        const dataset = extractRangeChartData(buildInput([
            { row: 0, col: 1 }, { row: 0, col: 2 },
            { row: 1, col: 1 }, { row: 1, col: 2 }
        ]));

        expect(dataset.error).toBeUndefined();
        expect(dataset.categories).toEqual(['Row 1', 'Row 2']);
        expect(dataset.series).toHaveLength(2);
        expect(dataset.warnings.some((warning) => warning.includes('row labels'))).toBe(true);
    });

    it('treats a header row when values match column headers', () => {
        const dataset = extractRangeChartData(buildInput([
            { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 },
            { row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 },
            { row: 2, col: 0 }, { row: 2, col: 1 }, { row: 2, col: 2 }
        ]));

        const headerRowInput = buildInput([
            { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 0, col: 3 },
            { row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 }, { row: 1, col: 3 },
            { row: 2, col: 0 }, { row: 2, col: 1 }, { row: 2, col: 2 }, { row: 2, col: 3 },
            { row: 3, col: 0 }, { row: 3, col: 1 }, { row: 3, col: 2 }, { row: 3, col: 3 }
        ]);
        headerRowInput.rows = [
            { values: { name: 'Name', jan: 'Jan', feb: 'Feb', mar: 'Mar' } },
            ...rows
        ];

        const withHeader = extractRangeChartData(headerRowInput);
        expect(withHeader.error).toBeUndefined();
        expect(withHeader.categories).toEqual(['Ella Jacoby', 'Sophia Hayden', 'Ruby Thanh']);
        expect(withHeader.warnings.some((warning) => warning.includes('headers'))).toBe(true);
        expect(dataset.error).toBeUndefined();
    });

    it('parses formatted numeric strings and ignores null values', () => {
        expect(parseNumericValue('99,407')).toBe(99407);
        expect(parseNumericValue('NULL')).toBeNull();
        expect(parseNumericValue(null)).toBeNull();
    });

    it('rejects selections that are too small or non-numeric', () => {
        expect(extractRangeChartData(buildInput([{ row: 0, col: 0 }, { row: 0, col: 1 }])).error)
            .toContain('2x2');

        const textOnlyColumns: RangeChartColumnMeta[] = [
            { id: 'a', header: 'A', dataType: 'varchar' },
            { id: 'b', header: 'B', dataType: 'varchar' }
        ];
        const textOnly = extractRangeChartData({
            selectedCells: [
                { row: 0, col: 0 }, { row: 0, col: 1 },
                { row: 1, col: 0 }, { row: 1, col: 1 }
            ],
            columns: textOnlyColumns,
            rows: [
                { values: { a: 'foo', b: 'bar' } },
                { values: { a: 'baz', b: 'qux' } }
            ]
        });
        expect(textOnly.error).toContain('numeric');
    });

    it('rebuilds chart data with custom category and series columns', () => {
        const baseInput = buildInput([
            { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 0, col: 3 },
            { row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 }, { row: 1, col: 3 },
            { row: 2, col: 0 }, { row: 2, col: 1 }, { row: 2, col: 2 }, { row: 2, col: 3 }
        ]);

        const rebuilt = rebuildRangeChartData(baseInput, {
            categoryColumnId: 'name',
            seriesColumnIds: ['jan']
        });

        expect(rebuilt.series).toHaveLength(1);
        expect(rebuilt.series[0].name).toBe('Jan');
        expect(selectionHasNumericData(baseInput)).toBe(true);
    });
});
