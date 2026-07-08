/**
 * Unit tests for commands/schema/helpers.ts
 */

import * as vscode from 'vscode';
import {
    getFullName,
    requireConnection,
    executeWithProgress,
    escapeSqlString,
    isValidIdentifier
} from '../commands/schema/helpers';
import { ConnectionManager } from '../core/connectionManager';
import { SchemaItemData } from '../commands/schema/types';

jest.mock('vscode', () => ({
    window: {
        showErrorMessage: jest.fn(),
        withProgress: jest.fn()
    },
    ProgressLocation: {
        Notification: 15
    }
}));

jest.mock('../core/connectionManager');

describe('commands/schema/helpers', () => {
    describe('getFullName', () => {
        it('should build fully qualified name from schema item', () => {
            const item: SchemaItemData = {
                dbName: 'MYDB',
                schema: 'ADMIN',
                label: 'MYTABLE',
                objType: 'TABLE'
            };
            expect(getFullName(item)).toBe('MYDB.ADMIN.MYTABLE');
        });

        it('should handle lowercase names', () => {
            const item: SchemaItemData = {
                dbName: 'mydb',
                schema: 'public',
                label: 'users',
                objType: 'TABLE'
            };
            expect(getFullName(item)).toBe('mydb.public."users"');
        });

        it('should handle names with underscores', () => {
            const item: SchemaItemData = {
                dbName: 'MY_DB',
                schema: 'MY_SCHEMA',
                label: 'MY_TABLE',
                objType: 'TABLE'
            };
            expect(getFullName(item)).toBe('MY_DB.MY_SCHEMA.MY_TABLE');
        });
    });

    describe('requireConnection', () => {
        let mockConnectionManager: jest.Mocked<ConnectionManager>;

        beforeEach(() => {
            mockConnectionManager = {
                getConnection: jest.fn(),
                getActiveConnectionName: jest.fn()
            } as unknown as jest.Mocked<ConnectionManager>;
            jest.clearAllMocks();
        });

        it('should return true when connection exists', async () => {
            mockConnectionManager.getConnection.mockResolvedValue({
                name: 'test-conn',
                host: 'localhost',
                port: 5480,
                database: 'testdb',
                user: 'admin'
            });
            mockConnectionManager.getActiveConnectionName.mockReturnValue('test-conn');

            const result = await requireConnection(mockConnectionManager);

            expect(result).toBe(true);
            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
        });

        it('should return false and show error when no connection', async () => {
            mockConnectionManager.getConnection.mockResolvedValue(undefined);
            mockConnectionManager.getActiveConnectionName.mockReturnValue(null);

            const result = await requireConnection(mockConnectionManager);

            expect(result).toBe(false);
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No database connection');
        });

        it('should use provided connection name', async () => {
            mockConnectionManager.getConnection.mockResolvedValue({
                name: 'custom-conn',
                host: 'localhost',
                port: 5480,
                database: 'testdb',
                user: 'admin'
            });

            const result = await requireConnection(mockConnectionManager, 'custom-conn');

            expect(mockConnectionManager.getConnection).toHaveBeenCalledWith('custom-conn');
            expect(result).toBe(true);
        });

        it('should use active connection name when not provided', async () => {
            mockConnectionManager.getActiveConnectionName.mockReturnValue('active-conn');
            mockConnectionManager.getConnection.mockResolvedValue({
                name: 'active-conn',
                host: 'localhost',
                port: 5480,
                database: 'testdb',
                user: 'admin'
            });

            await requireConnection(mockConnectionManager);

            expect(mockConnectionManager.getActiveConnectionName).toHaveBeenCalled();
            expect(mockConnectionManager.getConnection).toHaveBeenCalledWith('active-conn');
        });
    });

    describe('executeWithProgress', () => {
        it('should execute task with progress notification', async () => {
            const mockProgress = { report: jest.fn() };
            const taskResult = { data: 'test' };
            const mockTask = jest.fn().mockResolvedValue(taskResult);

            (vscode.window.withProgress as jest.Mock).mockImplementation(async (_options, task) => {
                return task(mockProgress);
            });

            const result = await executeWithProgress('Test Task', mockTask);

            expect(vscode.window.withProgress).toHaveBeenCalledWith(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Test Task',
                    cancellable: false
                },
                mockTask
            );
            expect(result).toBe(taskResult);
        });

        it('should pass progress object to task', async () => {
            const mockProgress = { report: jest.fn() };
            let receivedProgress: unknown;

            (vscode.window.withProgress as jest.Mock).mockImplementation(async (_options, task) => {
                return task(mockProgress);
            });

            await executeWithProgress('Test', (progress) => {
                receivedProgress = progress;
                return Promise.resolve('done');
            });

            expect(receivedProgress).toBe(mockProgress);
        });
    });

    describe('escapeSqlString', () => {
        it('should escape single quotes', () => {
            expect(escapeSqlString("it's")).toBe("it''s");
        });

        it('should escape multiple single quotes', () => {
            expect(escapeSqlString("it's a test's value")).toBe("it''s a test''s value");
        });

        it('should not modify string without quotes', () => {
            expect(escapeSqlString('hello world')).toBe('hello world');
        });

        it('should handle empty string', () => {
            expect(escapeSqlString('')).toBe('');
        });

        it('should handle string with only quotes', () => {
            expect(escapeSqlString("'")).toBe("''");
        });

        it('should handle consecutive quotes', () => {
            expect(escapeSqlString("''")).toBe("''''");
        });
    });

    describe('isValidIdentifier', () => {
        it('should return true for valid identifiers', () => {
            expect(isValidIdentifier('my_table')).toBe(true);
            expect(isValidIdentifier('MyTable')).toBe(true);
            expect(isValidIdentifier('_private')).toBe(true);
            expect(isValidIdentifier('table1')).toBe(true);
            expect(isValidIdentifier('A')).toBe(true);
        });

        it('should return false for identifiers starting with number', () => {
            expect(isValidIdentifier('1table')).toBe(false);
            expect(isValidIdentifier('123')).toBe(false);
        });

        it('should return false for identifiers with special characters', () => {
            expect(isValidIdentifier('my-table')).toBe(false);
            expect(isValidIdentifier('my.table')).toBe(false);
            expect(isValidIdentifier('my table')).toBe(false);
        });

        it('should return false for empty string', () => {
            expect(isValidIdentifier('')).toBe(false);
        });

        it('should handle whitespace by trimming', () => {
            expect(isValidIdentifier('  my_table  ')).toBe(true);
            expect(isValidIdentifier('   ')).toBe(false);
        });
    });
});
