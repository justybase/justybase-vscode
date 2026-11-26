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

describe('disk-backed group band counts', () => {
    beforeEach(() => {
        posted.length = 0;
    });

    it('asks the host for exact group counts and exposes them to the grid', async () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage({
            command: 'diskBackedActivate',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            resultSetId: 'disk-groups',
            totalRows: 260_000,
            columns: [{ name: 'BALANCE', type: 'INTEGER' }],
            rows: [[875]],
            limitReached: false,
        });
        controller.updateView('disk-groups', { grouping: ['BALANCE'] });

        await waitFor(() => {
            expect(posted.some(message => message.command === 'diskQuery' && message.action === 'group')).toBe(true);
        });
        const request = posted.find(message => message.command === 'diskQuery' && message.action === 'group');
        expect(request).toMatchObject({
            action: 'group',
            grouping: [{ columnIndex: 0 }],
            groupPath: [],
            limit: 10_000,
        });

        controller.handleHostMessage({
            command: 'diskQueryResult',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            requestId: Number(request!.requestId),
            action: 'group',
            totalRows: 260_000,
            groupResult: {
                kind: 'groups',
                path: [],
                depth: 0,
                totalCount: 4,
                groups: [
                    {
                        kind: 'group',
                        columnIndex: 0,
                        depth: 0,
                        value: 875,
                        count: 197_274,
                        path: [{ columnIndex: 0, value: 875 }],
                        hasChildren: true,
                    },
                    {
                        kind: 'group',
                        columnIndex: 0,
                        depth: 0,
                        value: 900,
                        count: 26_401,
                        path: [{ columnIndex: 0, value: 900 }],
                        hasChildren: true,
                    },
                ],
            },
        });

        await waitFor(() => {
            expect(controller.getDiskGroupData(controller.activeResult())?.counts.get(JSON.stringify(['875']))).toBe(197_274);
        });
        const data = controller.getDiskGroupData(controller.activeResult());
        expect(data?.counts.get(JSON.stringify(['875']))).toBe(197_274);
        expect(data?.extraGroups).toEqual([
            { path: ['875'], count: 197_274 },
            { path: ['900'], count: 26_401 },
        ]);
        expect(data?.partial).toBe(true);
        controller.dispose();
    });
});
