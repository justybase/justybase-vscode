import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/**
 * Generate temporary file path for an export, disambiguated by extension.
 * @param extension File extension (e.g. 'xlsx', 'xlsb', 'parquet', 'xpt').
 * @returns Absolute temporary file path under the OS temp directory.
 */
export function getTempFilePath(extension: string): string {
    return path.join(os.tmpdir(), `netezza_export_${Date.now()}.${extension.replace(/^\./, '')}`);
}

/**
 * Copy a file to the clipboard.
 * On Windows the actual file is copied (CF_HDROP file drop) via PowerShell
 * `Set-Clipboard -LiteralPath`, passed as an encoded UTF-16LE command so that
 * quotes and special characters in the path need no shell escaping.
 * On non-Windows platforms this falls back to copying the absolute file path
 * as plain text through the VS Code clipboard API.
 * @param filePath Absolute path to the file to copy
 * @returns True if the clipboard write succeeded, false otherwise
 */
export async function copyFileToClipboard(filePath: string): Promise<boolean> {
    const resolvedPath = path.normalize(path.resolve(filePath));

    if (os.platform() !== 'win32') {
        try {
            await vscode.env.clipboard.writeText(resolvedPath);
            return true;
        } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`Error copying file path to clipboard: ${errorMsg}`);
            return false;
        }
    }

    return new Promise<boolean>(resolve => {
        try {
            const literalPath = resolvedPath.replace(/'/g, "''");
            const command = `Set-Clipboard -LiteralPath '${literalPath}'`;
            const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');

            const ps = spawn('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-EncodedCommand',
                encodedCommand,
            ]);

            let errorOutput = '';

            ps.stderr.on('data', (data: Buffer) => {
                errorOutput += data.toString();
            });

            ps.on('close', (code: number) => {
                if (code !== 0) {
                    console.error(`PowerShell clipboard copy failed: ${errorOutput}`);
                    resolve(false);
                } else {
                    console.log(`File copied to clipboard: ${resolvedPath}`);
                    resolve(true);
                }
            });

            ps.on('error', (err: Error) => {
                console.error(`Error spawning PowerShell: ${err.message}`);
                resolve(false);
            });
        } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`Error copying file to clipboard: ${errorMsg}`);
            resolve(false);
        }
    });
}

/**
 * Validate export path before starting export.
 * Checks that the target directory exists and is writable.
 * @param outputPath Target file path for export
 * @throws Error if path is invalid or not writable
 */
export function validateExportPath(outputPath: string): void {
    const dir = path.dirname(outputPath);

    // Check if parent directory exists
    if (!fs.existsSync(dir)) {
        throw new Error(`Export directory does not exist: ${dir}`);
    }

    // Check write permission by attempting to create and remove a temp file
    const testFile = path.join(dir, `.export_write_test_${process.pid}_${randomBytes(8).toString('hex')}`);
    try {
        fs.writeFileSync(testFile, '', { flag: 'wx' });
        fs.unlinkSync(testFile);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Export directory is not writable: ${dir} (${msg})`, { cause: e });
    }
}
