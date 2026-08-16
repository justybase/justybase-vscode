import * as vscode from 'vscode';
import {
    ACCESS_SORT_ORDER_INSTRUCTIONS,
    ACCESS_UNSUPPORTED_SORT_ORDER_MESSAGE,
    extractAccessTableName,
    formatAccessFailureMessage,
    isAccessObjectNotFoundError,
    isAccessUnsupportedSortOrderError,
    presentAccessError,
} from '../utils/accessErrorHandling';

jest.mock('vscode');

describe('Access error handling', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('recognizes native Access sort-order 1045 errors, including wrapped messages', () => {
        expect(isAccessUnsupportedSortOrderError(
            new Error('Access reader: SortOrder[1045] is not supported'),
        )).toBe(true);
        expect(isAccessUnsupportedSortOrderError('unsupported collating sort order')).toBe(true);
        expect(isAccessUnsupportedSortOrderError('unrelated syntax error')).toBe(false);
    });

    it('recognizes sort-order failures in an Error.cause chain', () => {
        const outer = new Error('Import failed');
        outer.cause = new Error('unsupported collating sort order SortOrder[1045,0]');

        expect(isAccessUnsupportedSortOrderError(outer)).toBe(true);
        expect(formatAccessFailureMessage(outer, { databaseKind: 'access' }))
            .toBe(ACCESS_UNSUPPORTED_SORT_ORDER_MESSAGE);
    });

    it('copies only the generic repair instructions from the modal action', async () => {
        (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Copy instructions');

        await expect(presentAccessError(new Error('SortOrder[1045]'))).resolves.toBe(true);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            ACCESS_UNSUPPORTED_SORT_ORDER_MESSAGE,
            { modal: true },
            'Copy instructions',
        );
        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(ACCESS_SORT_ORDER_INSTRUCTIONS);
        expect(ACCESS_SORT_ORDER_INSTRUCTIONS).toContain('General - Legacy');
        expect(ACCESS_SORT_ORDER_INSTRUCTIONS).toContain('Compact and Repair');
        expect(ACCESS_SORT_ORDER_INSTRUCTIONS).not.toMatch(/password|credential|user/i);
    });

    it('formats an Access missing-table error with the table from the old SQL', () => {
        const error = new Error('user lacks privilege or object not found');
        expect(isAccessObjectNotFoundError(error)).toBe(true);
        expect(extractAccessTableName('SELECT * FROM IMPORT_20260809_1234')).toBe('IMPORT_20260809_1234');
        expect(formatAccessFailureMessage(error, {
            databaseKind: 'access',
            sql: 'SELECT * FROM IMPORT_20260809_1234',
        })).toBe(
            'Table `IMPORT_20260809_1234` does not exist in the active database, or the user does not have access to it. ' +
            'Refresh metadata or choose an existing table.',
        );
    });

    it('keeps non-Access errors and other database kinds unchanged', () => {
        const error = new Error('user lacks privilege or object not found');

        expect(formatAccessFailureMessage(error, {
            databaseKind: 'netezza',
            sql: 'SELECT * FROM IMPORT_TABLE',
        })).toBeUndefined();
        expect(formatAccessFailureMessage(new Error('syntax error'), {
            databaseKind: 'access',
            sql: 'SELECT * FROM IMPORT_TABLE',
        })).toBeUndefined();
    });

    it('logs the raw error while showing the friendly modal', async () => {
        const outputChannel = { appendLine: jest.fn() } as unknown as vscode.OutputChannel;
        (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue(undefined);

        await expect(presentAccessError(
            new Error('Access reader: SortOrder[1045,0] is not supported'),
            { databaseKind: 'access', outputChannel, operation: 'Import' },
        )).resolves.toBe(true);

        expect(outputChannel.appendLine).toHaveBeenCalledWith(
            '[Import] Raw Access error: Access reader: SortOrder[1045,0] is not supported',
        );
    });

    it('extracts the last component from quoted qualified table names', () => {
        expect(extractAccessTableName('SELECT * FROM [default].[Import.Table]')).toBe('Import.Table');
        expect(extractAccessTableName('SELECT * FROM "Import Table"')).toBe('Import Table');
        expect(extractAccessTableName('SELECT 1')).toBe('specified table');
    });
});
