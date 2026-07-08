/**
 * Shell utilities for building command line strings
 */

/**
 * Quote an argument for PowerShell shell
 */
export function quoteArg(a: string): string {
    if (!a) return a;
    if (a.includes(' ')) {
        return `"${a.replace(/"/g, '\\"')}"`;
    }
    return a;
}

/**
 * Build a PowerShell-friendly exec command.
 * If executable path contains spaces or a path separator, prefix with & and quote it.
 * Otherwise leave unquoted so 'python' resolves normally.
 */
export function buildExecCommand(execPath: string, scriptPath: string, args: string[]): string {
    const needsAmp = /[ \\/]/.test(execPath);
    const execPart = needsAmp ? `& ${quoteArg(execPath)}` : execPath;
    const scriptPart = quoteArg(scriptPath);
    const argsPart = args.map(a => quoteArg(a)).join(' ');
    return `${execPart} ${scriptPart}${argsPart ? ' ' + argsPart : ''}`.trim();
}
