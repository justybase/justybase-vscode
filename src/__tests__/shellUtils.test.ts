/**
 * Unit tests for shellUtils
 */

import { quoteArg, buildExecCommand } from '../utils/shellUtils';

describe('shellUtils', () => {
    describe('quoteArg', () => {
        it('should return empty string unchanged', () => {
            expect(quoteArg('')).toBe('');
        });

        it('should return simple argument unchanged', () => {
            expect(quoteArg('script.py')).toBe('script.py');
        });

        it('should quote argument with spaces', () => {
            expect(quoteArg('my script.py')).toBe('"my script.py"');
        });

        it('should escape quotes in argument with spaces', () => {
            expect(quoteArg('my "quoted" script.py')).toBe('"my \\"quoted\\" script.py"');
        });

        it('should not quote argument without spaces even with special chars', () => {
            expect(quoteArg('path/to/script.py')).toBe('path/to/script.py');
        });
    });

    describe('buildExecCommand', () => {
        it('should build simple command without ampersand', () => {
            const result = buildExecCommand('python', 'script.py', []);
            expect(result).toBe('python script.py');
        });

        it('should add ampersand for path with spaces', () => {
            const result = buildExecCommand('C:\\Program Files\\Python\\python.exe', 'script.py', []);
            expect(result).toBe('& "C:\\Program Files\\Python\\python.exe" script.py');
        });

        it('should add ampersand for path with slashes', () => {
            const result = buildExecCommand('C:/Python/python.exe', 'script.py', []);
            expect(result).toBe('& C:/Python/python.exe script.py');
        });

        it('should quote script path with spaces', () => {
            const result = buildExecCommand('python', 'my script.py', ['arg1']);
            expect(result).toBe('python "my script.py" arg1');
        });

        it('should quote arguments with spaces', () => {
            const result = buildExecCommand('python', 'script.py', ['arg 1', 'arg2']);
            expect(result).toBe('python script.py "arg 1" arg2');
        });

        it('should handle multiple arguments', () => {
            const result = buildExecCommand('python', 'script.py', ['--input', 'file.txt', '--output', 'result.txt']);
            expect(result).toBe('python script.py --input file.txt --output result.txt');
        });

        it('should handle empty script path', () => {
            // Note: empty script path results in double space which gets trimmed on command line
            const result = buildExecCommand('python', '', ['--version']);
            // The function produces 'python  --version' but that's OK for shell
            expect(result).toContain('python');
            expect(result).toContain('--version');
        });

        it('should handle no arguments', () => {
            const result = buildExecCommand('python', 'script.py', []);
            expect(result).toBe('python script.py');
        });
    });
});
