import { encode } from '@msgpack/msgpack';
import '@testing-library/jest-dom';
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

jest.mock('../protocol.js', () => ({
    ...jest.requireActual('../protocol.js'),
    postHostMessage: jest.fn(),
}));

import { postHostMessage } from '../protocol.js';
import { SharedResultPanelApp, SharedResultPanelController } from '../sharedView.js';

function hydrateMessage(): unknown {
    return {
        command: 'hydrate',
        data: {
            activeSourceJson: JSON.stringify('file:///query.sql'),
            activeResultSetIndex: 0,
            executingSourcesJson: JSON.stringify([]),
            resultSetsMsgPack: encode([
                {
                    resultSetId: 'header-insert-result',
                    columns: [{ name: 'CUSTOMER_ID', type: 'INTEGER' }, { name: 'Order Date', type: 'VARCHAR' }],
                    data: [[1, 'alpha']],
                    totalRowCount: 1,
                },
            ]),
            resultSyncVersion: 1,
        },
    };
}

afterEach(() => {
    cleanup();
    jest.useRealTimers();
    jest.clearAllMocks();
});

describe('shared result panel column headers', () => {
    it('sorts on a single click and inserts the column name on a double click', () => {
        jest.useFakeTimers();
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateMessage());
        render(<SharedResultPanelApp controller={controller} />);
        (postHostMessage as jest.Mock).mockClear();

        const idHeader = screen.getByTitle(/^Sort by CUSTOMER_ID\./);
        fireEvent.click(idHeader, { detail: 1 });
        expect(controller.activeResult()?.view.sorting).toEqual([]);
        act(() => { jest.advanceTimersByTime(250); });
        expect(controller.activeResult()?.view.sorting).toEqual([{ column: 'CUSTOMER_ID', descending: false }]);

        const quotedHeader = screen.getByTitle(/^Sort by Order Date\./);
        fireEvent.click(quotedHeader, { detail: 1 });
        fireEvent.click(quotedHeader, { detail: 2 });
        fireEvent.doubleClick(quotedHeader);
        act(() => { jest.advanceTimersByTime(250); });

        expect(controller.activeResult()?.view.sorting).toEqual([{ column: 'CUSTOMER_ID', descending: false }]);
        expect(postHostMessage).toHaveBeenCalledWith({
            command: 'insertCellContent',
            text: 'Order Date',
            sqlText: '"Order Date"',
        });

        controller.dispose();
    });
});
