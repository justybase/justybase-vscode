/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildDatabaseColumnStatistics, computeLoadedColumnStatistics } from '../resultPanel/columnStatistics.js';
import { ColumnStatisticsDialog } from '../resultPanel/columnStatisticsDialog.js';

describe('whole-column statistics', () => {
    afterEach(cleanup);

    it('aggregates loaded rows over non-null values', () => {
        const rows = [[1], [2], [null], [''], [3]];
        const stats = computeLoadedColumnStatistics(rows, 0, 'AMOUNT', 'INTEGER');

        expect(stats).toMatchObject({
            columnName: 'AMOUNT',
            columnType: 'INTEGER',
            scope: 'loaded',
            rowCount: 5,
            count: 3,
            nullCount: 2,
            distinctCount: 3,
            numericCount: 3,
            sum: 6,
            avg: 2,
            min: 1,
            max: 3,
        });
        expect(stats.stdev).toBeCloseTo(Math.sqrt(2 / 3), 6);
    });

    it('counts distinct text values and omits numeric aggregates', () => {
        const rows = [['A'], ['B'], ['A'], [null]];
        const stats = computeLoadedColumnStatistics(rows, 0, 'CATEGORY', 'VARCHAR');

        expect(stats).toMatchObject({
            rowCount: 4,
            count: 3,
            nullCount: 1,
            distinctCount: 2,
            numericCount: 0,
        });
        expect(stats.avg).toBeUndefined();
        expect(stats.sum).toBeUndefined();
    });

    it('maps SQLite aggregates and keeps the filtered/total scope', () => {
        const stats = buildDatabaseColumnStatistics({
            columnIndex: 1,
            columnName: 'AMOUNT',
            columnType: 'INTEGER',
            rowCount: 100,
            totalRowCount: 1_000,
            values: { count: 80, countDistinct: 12, sum: 400, avg: 5, min: 1, max: 9, stdev: 2 },
        });

        expect(stats).toMatchObject({
            scope: 'database',
            rowCount: 100,
            totalRowCount: 1_000,
            count: 80,
            nullCount: 20,
            distinctCount: 12,
            numericCount: 80,
            sum: 400,
            avg: 5,
            min: 1,
            max: 9,
            stdev: 2,
        });
    });

    it('renders the scope, counts and numeric aggregates', () => {
        const onCopy = jest.fn();
        render(<ColumnStatisticsDialog
            columnName="AMOUNT"
            columnType="INTEGER"
            loading={false}
            statistics={{
                columnIndex: 1,
                columnName: 'AMOUNT',
                columnType: 'INTEGER',
                scope: 'database',
                rowCount: 100,
                totalRowCount: 1_000,
                count: 80,
                nullCount: 20,
                distinctCount: 12,
                numericCount: 80,
                sum: 400,
                avg: 5,
                min: 1,
                max: 9,
                stdev: 2,
            }}
            onClose={jest.fn()}
            onCopy={onCopy}
        />);

        expect(screen.getByText('Column statistics')).toBeInTheDocument();
        expect(screen.getByText('SQLite · filtered rows 100 of 1,000')).toBeInTheDocument();
        expect(screen.getByText('Average')).toBeInTheDocument();
        expect(screen.getByText(/20\.0%/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
        expect(onCopy).toHaveBeenCalledWith(expect.objectContaining({ avg: 5 }));
    });

    it('shows loading and error states', () => {
        const { rerender } = render(<ColumnStatisticsDialog columnName="A" loading onClose={jest.fn()} onCopy={jest.fn()} />);
        expect(screen.getByRole('status')).toHaveTextContent('Computing column statistics');

        rerender(<ColumnStatisticsDialog columnName="A" loading={false} error="Read failed" onClose={jest.fn()} onCopy={jest.fn()} />);
        expect(screen.getByRole('alert')).toHaveTextContent('Read failed');
    });
});
