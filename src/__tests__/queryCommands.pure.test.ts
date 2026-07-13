/**
 * Unit tests for pure functions extracted from queryCommands
 * These tests verify the testable functions without VS Code dependencies
 */

import {
    stripLeadingComments,
    detectRiskyStatements,
    formatRiskyStatementMessage,
    confirmSafeExecuteWithDeps,
    createExpandedQuerySafetyChecker
} from '../commands/queryCommands';

describe('queryCommands pure functions', () => {
    describe('createExpandedQuerySafetyChecker', () => {
        it('detects an introduced risk even when another source query has the same risk type', async () => {
            const confirm = jest.fn().mockResolvedValue(true);
            const check = createExpandedQuerySafetyChecker(
                ['DELETE FROM explicit_table', '%INCLUDE unsafe.sql'],
                confirm,
            );

            await expect(check('DELETE FROM included_table', 1)).resolves.toBe(true);
            expect(confirm).toHaveBeenCalledWith(['DELETE FROM included_table']);
        });

        it('does not reconfirm a risk already present in the corresponding source query', async () => {
            const confirm = jest.fn().mockResolvedValue(true);
            const check = createExpandedQuerySafetyChecker(['DELETE FROM explicit_table'], confirm);

            await expect(check('DELETE FROM explicit_table', 0)).resolves.toBe(true);
            expect(confirm).not.toHaveBeenCalled();
        });
    });

    describe('stripLeadingComments', () => {
        it('should remove single-line comments at the beginning', () => {
            const sql = '-- This is a comment\nSELECT * FROM users';
            expect(stripLeadingComments(sql)).toBe('SELECT * FROM users');
        });

        it('should remove multiple single-line comments', () => {
            const sql = '-- Comment 1\n-- Comment 2\nSELECT 1';
            expect(stripLeadingComments(sql)).toBe('SELECT 1');
        });

        it('should remove block comments at the beginning', () => {
            const sql = '/* This is a block comment */\nSELECT * FROM table';
            expect(stripLeadingComments(sql)).toBe('SELECT * FROM table');
        });

        it('should handle comments with leading whitespace', () => {
            const sql = '   -- Indented comment\n   SELECT 1';
            expect(stripLeadingComments(sql)).toBe('SELECT 1');
        });

        it('should not remove comments in the middle of SQL', () => {
            const sql = 'SELECT * -- This stays\nFROM users';
            expect(stripLeadingComments(sql)).toBe('SELECT * -- This stays\nFROM users');
        });

        it('should handle empty string', () => {
            expect(stripLeadingComments('')).toBe('');
        });

        it('should handle SQL without comments', () => {
            const sql = 'SELECT * FROM users';
            expect(stripLeadingComments(sql)).toBe('SELECT * FROM users');
        });
    });

    describe('detectRiskyStatements', () => {
        it('should detect DELETE without WHERE', () => {
            const queries = ['DELETE FROM users'];
            const result = detectRiskyStatements(queries);

            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('DELETE');
        });

        it('should not flag DELETE with WHERE', () => {
            const queries = ['DELETE FROM users WHERE id = 1'];
            const result = detectRiskyStatements(queries);

            expect(result).toHaveLength(0);
        });

        it('should detect UPDATE without WHERE', () => {
            const queries = ['UPDATE users SET name = "test"'];
            const result = detectRiskyStatements(queries);

            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('UPDATE');
        });

        it('should not flag UPDATE with WHERE', () => {
            const queries = ['UPDATE users SET name = "test" WHERE id = 1'];
            const result = detectRiskyStatements(queries);

            expect(result).toHaveLength(0);
        });

        it('should detect TRUNCATE', () => {
            const queries = ['TRUNCATE TABLE users'];
            const result = detectRiskyStatements(queries);

            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('TRUNCATE');
        });

        it('should detect multiple risky statements', () => {
            const queries = [
                'DELETE FROM users',
                'UPDATE products SET price = 0',
                'TRUNCATE TABLE logs'
            ];
            const result = detectRiskyStatements(queries);

            expect(result).toHaveLength(3);
        });

        it('should handle comments before risky statements', () => {
            const queries = ['-- Be careful!\nDELETE FROM users'];
            const result = detectRiskyStatements(queries);

            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('DELETE');
        });

        it('should return empty array for safe statements', () => {
            const queries = [
                'SELECT * FROM users',
                'INSERT INTO users (name) VALUES ("test")',
                'UPDATE users SET name = "test" WHERE id = 1'
            ];
            const result = detectRiskyStatements(queries);

            expect(result).toHaveLength(0);
        });

        it('should handle case-insensitive detection', () => {
            const queries = ['delete from users', 'Update users set x = 1', 'truncate table t'];
            const result = detectRiskyStatements(queries);

            expect(result).toHaveLength(3);
        });
    });

    describe('formatRiskyStatementMessage', () => {
        it('should format single risky type', () => {
            const message = formatRiskyStatementMessage(['DELETE']);

            expect(message).toBe('Safe Execute: detected risky statement(s): DELETE without additional guard. Continue?');
        });

        it('should format multiple risky types', () => {
            const message = formatRiskyStatementMessage(['DELETE', 'UPDATE']);

            expect(message).toBe('Safe Execute: detected risky statement(s): DELETE, UPDATE without additional guard. Continue?');
        });

        it('should handle all three types', () => {
            const message = formatRiskyStatementMessage(['DELETE', 'UPDATE', 'TRUNCATE']);

            expect(message).toContain('DELETE');
            expect(message).toContain('UPDATE');
            expect(message).toContain('TRUNCATE');
        });
    });

    describe('confirmSafeExecuteWithDeps', () => {
        const mockConfig = {
            get: jest.fn()
        };

        const mockUI = {
            showWarningMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            showInformationMessage: jest.fn(),
            showInputBox: jest.fn(),
            createTerminal: jest.fn(),
            withProgress: jest.fn()
        };

        beforeEach(() => {
            jest.clearAllMocks();
        });

        it('should return true when safe execute is disabled', async () => {
            mockConfig.get.mockReturnValue(false);

            const result = await confirmSafeExecuteWithDeps(
                ['DELETE FROM users'],
                mockConfig,
                mockUI
            );

            expect(result).toBe(true);
            expect(mockUI.showWarningMessage).not.toHaveBeenCalled();
        });

        it('should return true for safe statements', async () => {
            mockConfig.get.mockReturnValue(true);

            const result = await confirmSafeExecuteWithDeps(
                ['SELECT * FROM users'],
                mockConfig,
                mockUI
            );

            expect(result).toBe(true);
            expect(mockUI.showWarningMessage).not.toHaveBeenCalled();
        });

        it('should return false when user cancels', async () => {
            mockConfig.get.mockReturnValue(true);
            mockUI.showWarningMessage.mockResolvedValue(undefined);

            const result = await confirmSafeExecuteWithDeps(
                ['DELETE FROM users'],
                mockConfig,
                mockUI
            );

            expect(result).toBe(false);
            expect(mockUI.showWarningMessage).toHaveBeenCalled();
        });

        it('should return true when user confirms "Run Anyway"', async () => {
            mockConfig.get.mockReturnValue(true);
            mockUI.showWarningMessage.mockResolvedValue('Run Anyway');

            const result = await confirmSafeExecuteWithDeps(
                ['DELETE FROM users'],
                mockConfig,
                mockUI
            );

            expect(result).toBe(true);
        });
    });
});
