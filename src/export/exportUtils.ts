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
 * Readable temp path for "Export & Open" / "Export & Copy file", e.g.
 * `<tmp>/justybase-exports/Result_1_20261020_143205.xlsx`. The name is what
 * the user sees after pasting the file into a mail or chat.
 */
export function exportTempFilePath(extension: string, baseName?: string): string {
    const directory = path.join(os.tmpdir(), 'justybase-exports');
    fs.mkdirSync(directory, { recursive: true });
    const safeBase = (baseName ?? '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'export';
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return path.join(directory, `${safeBase}_${stamp}.${extension.replace(/^\./, '')}`);
}

/** 'file' = the file itself is on the clipboard; 'path' = only its path could be copied. */
export type FileClipboardMode = 'file' | 'path';

/** True when the extension host runs inside WSL (local Remote-WSL window or a WSL terminal). */
export function isWslHost(): boolean {
    if (os.platform() !== 'linux') return false;
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
    try {
        return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
    } catch {
        return false;
    }
}

function runProcess(command: string, args: string[], input?: string, timeoutMs = 10000): Promise<{ code: number | null; stdout: string }> {
    return new Promise(resolve => {
        let stdout = '';
        let settled = false;
        const finish = (code: number | null) => {
            if (!settled) {
                settled = true;
                resolve({ code, stdout });
            }
        };
        try {
            const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
            const timer = setTimeout(() => {
                child.kill();
                finish(null);
            }, timeoutMs);
            child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
            child.on('error', () => { clearTimeout(timer); finish(null); });
            child.on('close', (code: number | null) => { clearTimeout(timer); finish(code); });
            if (input !== undefined) {
                // A tool that exits before reading stdin (missing display, wrong args) must not raise EPIPE.
                child.stdin?.on('error', () => undefined);
                child.stdin?.end(input);
            }
        } catch {
            finish(null);
        }
    });
}

async function toWindowsPath(linuxPath: string): Promise<string | undefined> {
    const result = await runProcess('wslpath', ['-w', linuxPath]);
    const windowsPath = result.stdout.trim();
    return result.code === 0 && windowsPath ? windowsPath : undefined;
}

async function copyFileViaPowerShell(windowsPath: string, executable: string): Promise<boolean> {
    const literalPath = windowsPath.replace(/'/g, "''");
    const encodedCommand = Buffer.from(`Set-Clipboard -LiteralPath '${literalPath}'`, 'utf16le').toString('base64');
    const result = await runProcess(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand]);
    return result.code === 0;
}

async function copyFileNatively(resolvedPath: string): Promise<boolean> {
    const remoteName = vscode.env.remoteName;
    // On SSH/containers/tunnels the file lives on the remote machine: there is no local file to put on the clipboard.
    if (remoteName && remoteName !== 'wsl') return false;

    if (os.platform() === 'darwin') {
        const result = await runProcess('osascript', [
            '-e', 'on run argv',
            '-e', 'set the clipboard to (POSIX file (item 1 of argv))',
            '-e', 'end run',
            resolvedPath,
        ]);
        return result.code === 0;
    }
    if (os.platform() !== 'linux') return false;

    if (isWslHost()) {
        const windowsPath = await toWindowsPath(resolvedPath);
        return windowsPath ? copyFileViaPowerShell(windowsPath, 'powershell.exe') : false;
    }

    // File managers (Nautilus, Dolphin, Thunar) and most chat/mail clients paste a text/uri-list entry as the file.
    const uriList = `${vscode.Uri.file(resolvedPath).toString()}\r\n`;
    if (process.env.WAYLAND_DISPLAY && (await runProcess('wl-copy', ['--type', 'text/uri-list'], uriList)).code === 0) {
        return true;
    }
    if (process.env.DISPLAY) {
        return (await runProcess('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-i'], uriList)).code === 0;
    }
    return false;
}

/**
 * Put the file itself on the clipboard when the platform allows it, otherwise
 * its absolute path. Windows and WSL use PowerShell `Set-Clipboard -LiteralPath`
 * (CF_HDROP), macOS uses AppleScript, Linux desktops use wl-copy/xclip with a
 * text/uri-list entry.
 * @returns How the clipboard was filled, or undefined when nothing was copied
 */
export async function copyFileToClipboardWithMode(filePath: string): Promise<FileClipboardMode | undefined> {
    const resolvedPath = path.normalize(path.resolve(filePath));

    if (os.platform() !== 'win32') {
        if (await copyFileNatively(resolvedPath)) {
            return 'file';
        }
        try {
            await vscode.env.clipboard.writeText(resolvedPath);
            return 'path';
        } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`Error copying file path to clipboard: ${errorMsg}`);
            return undefined;
        }
    }

    return (await copyFileToClipboardOnWindows(resolvedPath)) ? 'file' : undefined;
}

/**
 * Copy a file to the clipboard (see {@link copyFileToClipboardWithMode}).
 * @param filePath Absolute path to the file to copy
 * @returns True if the clipboard write succeeded, false otherwise
 */
export async function copyFileToClipboard(filePath: string): Promise<boolean> {
    return (await copyFileToClipboardWithMode(filePath)) !== undefined;
}

/**
 * Open an exported file in its default application. Inside WSL the file is
 * handed to Windows Explorer, since the VS Code client cannot resolve a Linux path.
 */
export async function openFileExternally(filePath: string): Promise<void> {
    if (isWslHost()) {
        const windowsPath = await toWindowsPath(filePath);
        if (windowsPath) {
            // explorer.exe exits with 1 even when it opened the file, so the exit code is not checked.
            await runProcess('explorer.exe', [windowsPath]);
            return;
        }
    }
    await vscode.env.openExternal(vscode.Uri.file(filePath));
}

/**
 * Windows: copy the actual file (CF_HDROP file drop) via PowerShell
 * `Set-Clipboard -LiteralPath`, passed as an encoded UTF-16LE command so that
 * quotes and special characters in the path need no shell escaping.
 */
function copyFileToClipboardOnWindows(resolvedPath: string): Promise<boolean> {
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
