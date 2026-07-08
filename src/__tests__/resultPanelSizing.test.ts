jest.mock('../../media/resultPanel/utils.js', () => ({
    validateRequiredLibraries: jest.fn(),
    formatCellValue: jest.fn((value: unknown) => (value === null || value === undefined ? null : String(value))),
    debounce: jest.fn((fn: (...args: unknown[]) => unknown) => fn)
}));

jest.mock('../../media/resultPanel/messages.js', () => ({
    getSavedStateFor: jest.fn(),
    saveAllGridStates: jest.fn()
}));

jest.mock('../../media/resultPanel/filter.js', () => ({
    createHeaderCellWithFilter: jest.fn(),
    reorderColumnsForPinning: jest.fn()
}));

jest.mock('../../media/resultPanel/selection.js', () => ({
    setupCellSelectionEvents: jest.fn(() => ({}))
}));

describe('result panel sizing helpers', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('keeps the row-number column ready for at least 7 digits', () => {
        const gridModule: {
            calculateRowNumberColumnWidth: (rowCount: number, measureText: (text: string) => number) => number;
        } = require('../../media/resultPanel/grid.js');

        const measureText = (text: string) => text.length * 8;

        expect(gridModule.calculateRowNumberColumnWidth(123, measureText)).toBe(80);
        expect(gridModule.calculateRowNumberColumnWidth(12345678, measureText)).toBe(88);
    });

    it('scans at most the first 10000 rows when auto-sizing columns', () => {
        const gridModule: {
            calculateAutoColumnWidth: (
                column: { header: string; accessorFn: (row: string[]) => string; dataType?: string },
                rows: string[][],
                measureText: (text: string) => number
            ) => number;
        } = require('../../media/resultPanel/grid.js');

        const rows = Array.from({ length: 10001 }, (_, index) => {
            // Row 9990 is the last index sampled when maxRows=10000 and sampleStep=10.
            if (index === 9990) {
                return ['x'.repeat(30)];
            }

            if (index === 10000) {
                return ['x'.repeat(80)];
            }

            return ['x'];
        });

        const width = gridModule.calculateAutoColumnWidth(
            {
                header: 'value',
                accessorFn: row => row[0],
                dataType: 'varchar'
            },
            rows,
            text => String(text).length * 10
        );

        expect(width).toBe(318);
    });

    it('caps automatic column widths at 600px', () => {
        const gridModule: {
            calculateAutoColumnWidth: (
                column: { header: string; accessorFn: (row: string[]) => string; dataType?: string },
                rows: string[][],
                measureText: (text: string) => number
            ) => number;
        } = require('../../media/resultPanel/grid.js');

        const width = gridModule.calculateAutoColumnWidth(
            {
                header: 'value',
                accessorFn: row => row[0],
                dataType: 'varchar'
            },
            [['x'.repeat(120)]],
            text => String(text).length * 10
        );

        expect(width).toBe(600);
    });

    it('reserves header icon space only for header width, not cell content width', () => {
        const gridModule: {
            calculateAutoHeaderWidth: (
                column: { header: string },
                measureText: (text: string) => number
            ) => number;
            calculateAutoColumnWidth: (
                column: { header: string; accessorFn: (row: string[]) => string; dataType?: string },
                rows: string[][],
                measureText: (text: string) => number
            ) => number;
        } = require('../../media/resultPanel/grid.js');

        const measureText = (text: string) => String(text).length * 10;
        const column = {
            header: 'value',
            accessorFn: (row: string[]) => row[0],
            dataType: 'varchar'
        };

        // Header width = text measurement (50) + header extra width (210) = 260
        expect(gridModule.calculateAutoHeaderWidth(column, measureText)).toBe(260);
        // Cell width = content (200) + cell extra width (18) = 218, but min with header (260) = 260
        expect(gridModule.calculateAutoColumnWidth(column, [['x'.repeat(20)]], measureText)).toBe(260);
    });
});
