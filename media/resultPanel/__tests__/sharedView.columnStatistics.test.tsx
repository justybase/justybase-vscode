const posted: Array<Record<string, unknown>> = [];

jest.mock('../protocol.js', () => {
    const actual = jest.requireActual('../protocol.js');
    return {
        ...actual,
        postHostMessage: jest.fn((message: Record<string, unknown>) => {
            posted.push(message);
        }),
    };
});

import { waitFor } from '@testing-library/react';
import { SharedResultPanelController } from '../sharedView.js';

describe('whole-column statistics', () => {
    beforeEach(() => {
        posted.length = 0;
    });

    it('asks SQLite for every spilled row and keeps the filtered/total scope', async () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage({
            command: 'diskBackedActivate',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            resultSetId: 'disk-column-stats',
            totalRows: 1_000,
            columns: [{ name: 'AMOUNT', type: 'INTEGER' }],
            rows: [[1]],
            limitReached: false,
        });
        const result = controller.activeResult();
        expect(result).toBeDefined();

        const pending = controller.requestColumnStatistics(result, 0);
        await waitFor(() => {
            expect(posted.some(message => message.command === 'diskQuery' && message.action === 'aggregate')).toBe(true);
        });
        const request = posted.find(message => message.command === 'diskQuery' && message.action === 'aggregate');
        expect(request).toMatchObject({
            action: 'aggregate',
            aggregations: [
                { columnIndex: 0, fn: 'count' },
                { columnIndex: 0, fn: 'countDistinct' },
                { columnIndex: 0, fn: 'sum' },
                { columnIndex: 0, fn: 'avg' },
                { columnIndex: 0, fn: 'min' },
                { columnIndex: 0, fn: 'max' },
                { columnIndex: 0, fn: 'stdev' },
            ],
        });

        controller.handleHostMessage({
            command: 'diskQueryResult',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            requestId: Number(request!.requestId),
            action: 'aggregate',
            totalRows: 1_000,
            filteredCount: 100,
            aggregations: [
                { columnIndex: 0, fn: 'count', value: 80 },
                { columnIndex: 0, fn: 'countDistinct', value: 12 },
                { columnIndex: 0, fn: 'sum', value: 400 },
                { columnIndex: 0, fn: 'avg', value: 5 },
                { columnIndex: 0, fn: 'min', value: 1 },
                { columnIndex: 0, fn: 'max', value: 9 },
                { columnIndex: 0, fn: 'stdev', value: 2 },
            ],
        });

        await expect(pending).resolves.toMatchObject({
            columnName: 'AMOUNT',
            scope: 'database',
            rowCount: 100,
            totalRowCount: 1_000,
            count: 80,
            nullCount: 20,
            distinctCount: 12,
            sum: 400,
            avg: 5,
            min: 1,
            max: 9,
            stdev: 2,
        });
        controller.dispose();
    });
});
