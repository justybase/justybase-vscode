import { CopilotResponseHandler } from '../services/copilot/CopilotResponseHandler';

describe('CopilotResponseHandler', () => {
    let handler: CopilotResponseHandler;

    beforeEach(() => {
        handler = new CopilotResponseHandler();
    });

    describe('isProcedureCode', () => {
        it('detects CREATE PROCEDURE', () => {
            expect(handler.isProcedureCode('CREATE PROCEDURE p() AS ...')).toBe(true);
        });

        it('detects CREATE OR REPLACE PROCEDURE', () => {
            expect(handler.isProcedureCode('CREATE OR REPLACE PROCEDURE p() AS ...')).toBe(true);
        });

        it('detects lowercase create', () => {
            expect(handler.isProcedureCode('create procedure p() as ...')).toBe(true);
        });

        it('returns false for a regular SELECT', () => {
            expect(handler.isProcedureCode('SELECT * FROM users')).toBe(false);
        });

        it('returns false for CREATE TABLE', () => {
            expect(handler.isProcedureCode('CREATE TABLE t (id INT)')).toBe(false);
        });

        it('returns false for an empty string', () => {
            expect(handler.isProcedureCode('')).toBe(false);
        });
    });

    describe('convertDataToMarkdown', () => {
        it('converts data to a markdown table', () => {
            const result = handler.convertDataToMarkdown([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' }
            ]);

            expect(result).toContain('| id | name |');
            expect(result).toContain('| 1 | Alice |');
            expect(result).toContain('| 2 | Bob |');
        });

        it('handles null and undefined values', () => {
            const result = handler.convertDataToMarkdown([{ a: null, b: undefined }]);
            expect(result).toContain('| NULL | NULL |');
        });

        it('limits output to 50 rows and reports the remainder', () => {
            const rows = Array.from({ length: 55 }, (_, index) => ({ id: index }));
            const result = handler.convertDataToMarkdown(rows);
            expect(result).toContain('and 5 more rows');
            expect(result).toContain('total: 55 rows');
        });

        it('returns a message for empty data', () => {
            expect(handler.convertDataToMarkdown([])).toBe('*No data*');
        });

        it('escapes pipe characters and truncates long values', () => {
            const result = handler.convertDataToMarkdown([
                { value: 'a|b' },
                { value: 'x'.repeat(150) }
            ]);

            expect(result).toContain('a\\|b');
            expect(result).toContain('...');
        });
    });
});
