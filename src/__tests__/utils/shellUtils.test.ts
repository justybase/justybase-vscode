import { quoteArg, buildExecCommand } from '../../utils/shellUtils';

describe('shellUtils', () => {

    describe('quoteArg', () => {
        it('should return falsy values unchanged', () => {
            expect(quoteArg('')).toBe('');
            expect(quoteArg(null as unknown as string)).toBe(null);
            expect(quoteArg(undefined as unknown as string)).toBe(undefined);
        });

        it('should return argument unchanged if it does not contain spaces', () => {
            expect(quoteArg('simpleArg')).toBe('simpleArg');
            expect(quoteArg('arg-with-dashes')).toBe('arg-with-dashes');
        });

        it('should quote argument if it contains spaces', () => {
            expect(quoteArg('arg with spaces')).toBe('"arg with spaces"');
            expect(quoteArg('  leading/trailing  ')).toBe('"  leading/trailing  "');
        });

        it('should escape existing quotes when quoting an argument with spaces', () => {
            expect(quoteArg('arg with "quotes" and spaces')).toBe('"arg with \\"quotes\\" and spaces"');
        });

        it('should not wrap in quotes if there are internal quotes but no spaces', () => {
            expect(quoteArg('arg"with"quotes')).toBe('arg"with"quotes');
        });
    });

    describe('buildExecCommand', () => {
        it('should build command without amp if execPath does not contain spaces or slashes', () => {
            const cmd = buildExecCommand('python', 'script.py', ['arg1', 'arg2']);
            expect(cmd).toBe('python script.py arg1 arg2');
        });

        it('should prefix with & and quote execPath if it contains spaces', () => {
            const cmd = buildExecCommand('C:\\Program Files\\python', 'script.py', []);
            expect(cmd).toBe('& "C:\\Program Files\\python" script.py');
        });

        it('should prefix with & if execPath contains slashes', () => {
            const cmd = buildExecCommand('/usr/bin/python', 'script.py', []);
            expect(cmd).toBe('& /usr/bin/python script.py');

            const cmd2 = buildExecCommand('C:\\path\\to\\python.exe', 'script.py', []);
            expect(cmd2).toBe('& C:\\path\\to\\python.exe script.py');
        });

        it('should correctly quote scriptPath and args if they contain spaces', () => {
            const cmd = buildExecCommand('python', 'my script.py', ['arg 1', 'arg2']);
            expect(cmd).toBe('python "my script.py" "arg 1" arg2');
        });

        it('should handle empty args array correctly', () => {
            const cmd = buildExecCommand('python', 'script.py', []);
            expect(cmd).toBe('python script.py');
        });
    });

});
