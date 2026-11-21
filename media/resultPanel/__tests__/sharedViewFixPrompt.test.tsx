import { encode } from '@msgpack/msgpack';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('../protocol.js', () => ({
    ...jest.requireActual('../protocol.js'),
    postHostMessage: jest.fn(),
}));

import { postHostMessage } from '../protocol.js';
import { SharedResultPanelApp, SharedResultPanelController } from '../sharedView.js';

function hydrateErrorResult(): unknown {
    return {
        command: 'hydrate',
        data: {
            activeSourceJson: JSON.stringify('file:///query.sql'),
            activeResultSetIndex: 0,
            executingSourcesJson: JSON.stringify([]),
            resultSetsMsgPack: encode([
                {
                    resultSetId: 'error-result',
                    executionTimestamp: 1,
                    columns: [],
                    data: [],
                    totalRowCount: 0,
                    isError: true,
                    message: 'column "idd" does not exist',
                    sql: 'SELECT *\nFROM items\nWHERE idd = 1',
                    errorDetails: {
                        code: '42703',
                        severity: 'ERROR',
                        position: 27,
                        detail: 'The column is missing.',
                        hint: 'Check the column name.',
                        context: 'PL/pgSQL function f() line 4 at RETURN',
                    },
                },
            ]),
            resultSyncVersion: 1,
        },
    };
}

describe('shared result panel Fix with Copilot prompt', () => {
    afterEach(() => {
        jest.clearAllMocks();
        document.body.innerHTML = '';
    });

    it('includes the PostgreSQL diagnostics and the resolved line excerpt', () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateErrorResult());
        render(<SharedResultPanelApp controller={controller} />);

        expect(document.querySelector('.ui-result-error-excerpt')?.textContent).toContain('LINE 3: WHERE idd = 1');
        fireEvent.click(screen.getByRole('button', { name: 'Fix with Copilot' }));

        expect(postHostMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'fixSqlError',
            sql: 'SELECT *\nFROM items\nWHERE idd = 1',
            errorMessage: expect.stringContaining('SQLSTATE: 42703'),
        }));
        const fixCall = (postHostMessage as jest.Mock).mock.calls
            .map(call => call[0] as { command?: string; errorMessage?: string })
            .find(call => call.command === 'fixSqlError');
        expect(fixCall?.errorMessage).toBeDefined();
        const message = fixCall?.errorMessage ?? '';
        expect(message).toContain('POSITION: 27');
        expect(message).toContain('DETAIL: The column is missing.');
        expect(message).toContain('HINT: Check the column name.');
        expect(message).toContain('CONTEXT: PL/pgSQL function f() line 4 at RETURN');
        controller.dispose();
    });
});
