/* eslint-disable @typescript-eslint/no-explicit-any */

const mockCreateNotebookController = jest.fn();

jest.mock('vscode', () => {
    class MockEventEmitter<T> {
        public event = jest.fn(() => ({ dispose: jest.fn() }));
        public fire = jest.fn((_value?: T) => undefined);
        public dispose = jest.fn();
    }

    return {
        EventEmitter: MockEventEmitter,
        NotebookCellKind: { Markup: 1, Code: 2 },
        notebooks: {
            createNotebookController: mockCreateNotebookController,
        },
        NotebookCellOutput: jest.fn().mockImplementation((items: unknown[]) => ({ items })),
        NotebookCellOutputItem: {
            text: jest.fn((value: string, mime?: string) => ({ value, mime })),
            stderr: jest.fn((value: string) => ({ value, mime: 'text/stderr' })),
        },
    };
});

jest.mock('../core/queryBatchExecutor', () => ({
    getQueryConfig: jest.fn(() => ({ queryTimeout: 30, rowLimit: 100 })),
}));

jest.mock('../notebook/fullGridPanel', () => ({
    stashResult: jest.fn(),
    mapCellResult: jest.fn(),
}));

import { NetezzaSqlNotebookController } from '../notebook/controller';
import type { NotebookController } from 'vscode';

describe('NetezzaSqlNotebookController', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('executes an assigned cell connection even when the global connection differs', async () => {
        const execution = {
            token: { isCancellationRequested: false },
            start: jest.fn(),
            replaceOutput: jest.fn(),
            end: jest.fn(),
        };
        const notebookController = {
            supportedLanguages: [],
            supportsExecutionOrder: false,
            createNotebookCellExecution: jest.fn(() => execution),
            dispose: jest.fn(),
        } as unknown as NotebookController;
        mockCreateNotebookController.mockReturnValue(notebookController);

        let readCount = 0;
        const reader = {
            fieldCount: 1,
            getName: jest.fn(() => 'VALUE'),
            getValue: jest.fn(() => 1),
            read: jest.fn(async () => {
                readCount++;
                return readCount === 1;
            }),
            nextResult: jest.fn().mockResolvedValue(false),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const command = {
            commandTimeout: 0,
            _recordsAffected: -1,
            executeReader: jest.fn().mockResolvedValue(reader),
        };
        const connection = {
            createCommand: jest.fn(() => command),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const cellUri = 'vscode-notebook-cell:/workspace/report.sqlnb#cell-1';
        const connectionManager = {
            getConnectionForExecution: jest.fn().mockReturnValue('NetezzaProfile'),
            getConnection: jest.fn().mockResolvedValue({ name: 'NetezzaProfile' }),
            createTransientConnectionForDocument: jest.fn().mockResolvedValue(connection),
        } as any;

        const controller = new NetezzaSqlNotebookController({} as any, connectionManager);
        const cell = {
            kind: 2,
            document: {
                uri: { toString: () => cellUri },
                getText: () => 'SELECT 1',
            },
        } as any;

        await notebookController.executeHandler([cell], {} as any, notebookController as any);

        expect(connectionManager.getConnectionForExecution).toHaveBeenCalledWith(cellUri);
        expect(connectionManager.getConnection).toHaveBeenCalledWith('NetezzaProfile');
        expect(connectionManager.createTransientConnectionForDocument).toHaveBeenCalledWith(
            cellUri,
            'NetezzaProfile',
        );
        expect(connection.createCommand).toHaveBeenCalledWith('SELECT 1');
        expect(connection.close).toHaveBeenCalledTimes(1);
        expect(execution.end).toHaveBeenCalledWith(true);
        controller.dispose();
    });
});
