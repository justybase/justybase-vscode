import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import type { MacroPythonExecutor, MacroPythonExecutionResult } from './macroPreprocessor';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;

export function getPythonPath(): string {
    return (
        vscode.workspace.getConfiguration('justybase').get<string>('pythonPath') ||
        vscode.workspace.getConfiguration().get<string>('python.pythonPath') ||
        'python'
    );
}

export function getPythonArgs(): string[] {
    const configured = vscode.workspace.getConfiguration('justybase').get<unknown>('pythonArgs');
    return Array.isArray(configured) && configured.every(value => typeof value === 'string')
        ? configured
        : [];
}

export async function executeMacroPython(
    script: string,
    args: string[],
): Promise<MacroPythonExecutionResult> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const command = getPythonPath();

    try {
        const { stdout, stderr } = await execFileAsync(command, [...getPythonArgs(), script, ...args], {
            cwd,
            maxBuffer: 10 * 1024 * 1024,
            timeout: DEFAULT_TIMEOUT_MS,
            env: { ...process.env, PYTHONUTF8: '1' },
        });

        return {
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: 0,
        };
    } catch (error) {
        const e = error as { stdout?: Buffer; stderr?: Buffer; code?: number; message?: string };
        return {
            stdout: e.stdout === undefined ? '' : String(e.stdout),
            stderr: e.stderr === undefined ? e.message ?? String(error) : String(e.stderr),
            exitCode: e.code ?? 1,
        };
    }
}

export function createMacroPythonExecutor(
    pythonPathOverride?: string,
    pythonArgsOverride?: string[],
): MacroPythonExecutor {
    return async (script: string, args: string[]): Promise<MacroPythonExecutionResult> => {
        if (pythonPathOverride) {
            try {
                const { stdout, stderr } = await execFileAsync(
                    pythonPathOverride,
                    [...(pythonArgsOverride ?? getPythonArgs()), script, ...args],
                    {
                        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                        maxBuffer: 10 * 1024 * 1024,
                        timeout: DEFAULT_TIMEOUT_MS,
                        env: { ...process.env, PYTHONUTF8: '1' },
                    },
                );

                return {
                    stdout: String(stdout),
                    stderr: String(stderr),
                    exitCode: 0,
                };
            } catch (error) {
                const e = error as { stdout?: Buffer; stderr?: Buffer; code?: number; message?: string };
                return {
                    stdout: e.stdout === undefined ? '' : String(e.stdout),
                    stderr: e.stderr === undefined ? e.message ?? String(error) : String(e.stderr),
                    exitCode: e.code ?? 1,
                };
            }
        }

        return executeMacroPython(script, args);
    };
}
