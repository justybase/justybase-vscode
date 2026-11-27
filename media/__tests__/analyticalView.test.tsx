/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SharedAnalyticalView } from '../resultPanel/sharedAnalytical.js';
import type { DiskGroupStatsResult } from '../resultPanel/types.js';

const diskBatch: DiskGroupStatsResult = {
    groupColumns: [0],
    totalRows: 20,
    totalGroups: 2,
    unlistedRows: 0,
    groups: [
        {
            values: ['A'],
            count: 10,
            columns: [{ columnIndex: 1, nonNullCount: 10, distinctCount: 1, min: 0, max: 0, numeric: { mean: 0, stddev: 0 }, topValues: [] }],
        },
        {
            values: ['B'],
            count: 10,
            columns: [{ columnIndex: 1, nonNullCount: 10, distinctCount: 1, min: 100, max: 100, numeric: { mean: 100, stddev: 0 }, topValues: [] }],
        },
    ],
    population: [{ columnIndex: 1, nonNullCount: 20, distinctCount: 2, min: 0, max: 100, numeric: { mean: 50, stddev: 50 }, topValues: [] }],
};

const columns = [
    { name: 'CATEGORY', type: 'VARCHAR' },
    { name: 'VALUE', type: 'INTEGER' },
];

const rows = [
    ...Array.from({ length: 10 }, () => ['A', 0]),
    ...Array.from({ length: 10 }, () => ['B', 100]),
];

describe('shared analytical view', () => {
    afterEach(cleanup);

    it('renders scored groups with explainable flags', () => {
        render(<SharedAnalyticalView columns={columns} rows={rows} onClose={jest.fn()} />);

        expect(screen.getByText('Analytical view')).toBeInTheDocument();
        expect(screen.getByText('Groups compared with Whole result')).toBeInTheDocument();
        expect(screen.getAllByText('A').length).toBeGreaterThan(0);
        expect(screen.getAllByText('B').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Mean shift').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Method').length).toBeGreaterThan(0);
    });

    it('re-scores with detection, sensitivity and rule options', () => {
        render(<SharedAnalyticalView columns={columns} rows={rows} onClose={jest.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Options' }));
        const detection = screen.getByLabelText('Detection');
        fireEvent.change(detection, { target: { value: 'peer' } });
        expect(screen.getByText(/Peer groups need at least 8 groups/)).toBeInTheDocument();

        const meanShift = screen.getByRole('checkbox', { name: 'Mean shift' });
        fireEvent.click(meanShift);
        expect(document.querySelectorAll('.ui-analytical-flag-rule')).toHaveLength(0);
    });

    it('analyzes every spilled row through the disk batch callback', async () => {
        const analyzeDisk = jest.fn().mockResolvedValue(diskBatch);
        render(<SharedAnalyticalView
            columns={columns}
            rows={[['A', 0], ['B', 100]]}
            diskBacked
            analyzeDisk={analyzeDisk}
            onClose={jest.fn()}
        />);

        await waitFor(() => expect(screen.getAllByText('A').length).toBeGreaterThan(0));
        expect(screen.getAllByText(/all spilled rows/).length).toBeGreaterThan(0);
        expect(screen.getByText(/grid filters are not applied/)).toBeInTheDocument();
        expect(analyzeDisk).toHaveBeenCalledWith(expect.objectContaining({
            groupColumns: [0],
            statColumns: [1],
            limit: 500,
            topLimit: 8,
        }));
    });

    it('reports a disk analysis failure without falling back to the loaded page', async () => {
        const analyzeDisk = jest.fn().mockRejectedValue(new Error('Host read failed'));
        render(<SharedAnalyticalView
            columns={columns}
            rows={[['A', 0], ['B', 100]]}
            diskBacked
            analyzeDisk={analyzeDisk}
            onClose={jest.fn()}
        />);

        expect(await screen.findByText('Host read failed')).toBeInTheDocument();
    });

    it('supports reference mode and anomalies-only filtering', () => {
        render(<SharedAnalyticalView columns={columns} rows={rows} onClose={jest.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Options' }));
        fireEvent.change(screen.getByLabelText('Detection'), { target: { value: 'reference' } });
        const reference = screen.getByLabelText('Reference group');
        const options = Array.from(reference.querySelectorAll('option')).map(option => option.value).filter(Boolean);
        expect(options.length).toBe(2);
        fireEvent.change(reference, { target: { value: options[1] } });
        const referenceRow = screen.getByText('B (reference)').closest('tr');
        expect(referenceRow).not.toBeNull();
        fireEvent.click(referenceRow!);
        expect(screen.getByText(/not scored/)).toBeInTheDocument();

        fireEvent.click(screen.getByLabelText('Anomalies only'));
        expect(screen.getByText(/of 2 groups/)).toBeInTheDocument();
    });
});
