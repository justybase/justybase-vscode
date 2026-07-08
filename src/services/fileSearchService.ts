import * as vscode from 'vscode';
import { stripComments, stripCommentsAndLiterals, type SourceSearchMode } from '../sql/sqlTextUtils';
import type { FileSearchOptions, FileSearchResult, FileMatch } from '../contracts/webviews/fileSearchContracts';

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchRegex(term: string, caseSensitive: boolean, wholeWord: boolean, useRegex: boolean, global: boolean = false): RegExp {
    let pattern = useRegex ? term : escapeRegex(term);
    if (wholeWord) {
        pattern = `(?<=\\b|^)${pattern}(?=\\b|$)`;
    }
    const flags = caseSensitive ? (global ? 'g' : '') : (global ? 'gi' : 'i');
    try {
        return new RegExp(pattern, flags);
    } catch {
        return new RegExp(escapeRegex(term), flags);
    }
}

function stripLineBasedOnMode(line: string, mode: SourceSearchMode): string {
    switch (mode) {
        case 'noComments':
            return stripComments(line);
        case 'noCommentsNoLiterals':
            return stripCommentsAndLiterals(line);
        default:
            return line;
    }
}

async function collectFileUris(fileTypes: ('sql' | 'py')[]): Promise<vscode.Uri[]> {
    const patterns: string[] = [];
    if (fileTypes.includes('sql')) patterns.push('**/*.sql');
    if (fileTypes.includes('py')) patterns.push('**/*.py');
    if (patterns.length === 0) return [];

    const allFiles = new Map<string, vscode.Uri>();
    for (const pattern of patterns) {
        const uris = await vscode.workspace.findFiles(
            pattern,
            '{**/node_modules/**,**/dist/**,**/.git/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/.eggs/**}'
        );
        for (const uri of uris) {
            allFiles.set(uri.toString(), uri);
        }
    }
    return Array.from(allFiles.values());
}

const CONCURRENCY = 6;

export async function fileSearch(
    options: FileSearchOptions,
    token: vscode.CancellationToken
): Promise<{ results: FileSearchResult[]; fileMatches: FileSearchResult[] }> {
    const uris = await collectFileUris(options.fileTypes);
    if (uris.length === 0) return { results: [], fileMatches: [] };

    const searchRegex = buildSearchRegex(options.term, options.caseSensitive, options.wholeWord, options.useRegex);
    const results: FileSearchResult[] = [];
    const fileMatches: FileSearchResult[] = [];

    for (let i = 0; i < uris.length; i += CONCURRENCY) {
        if (token.isCancellationRequested) break;
        const batch = uris.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(uri => processFile(uri, options, searchRegex, token))
        );
        for (const r of batchResults) {
            if (!r) continue;
            if (r.isFileNameMatch && r.matches.length === 0) {
                fileMatches.push(r);
            } else {
                results.push(r);
            }
        }
    }

    results.sort((a, b) => b.mtime - a.mtime);
    fileMatches.sort((a, b) => b.mtime - a.mtime);
    return { results, fileMatches };
}

async function processFile(
    uri: vscode.Uri,
    options: FileSearchOptions,
    searchRegex: RegExp,
    token: vscode.CancellationToken
): Promise<FileSearchResult | null> {
    if (token.isCancellationRequested) return null;

    try {
        const content = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder().decode(content);
        const fileName = uri.fsPath.split('/').pop() || uri.fsPath;

        const hasFileNameMatch = searchRegex.test(fileName);

        const matches: FileMatch[] = [];
        let lineIdx = 0;
        let start = 0;

        while (start < text.length) {
            if ((lineIdx & 511) === 0 && token.isCancellationRequested) return null;
            const end = text.indexOf('\n', start);
            const lineText = text.substring(start, end === -1 ? text.length : end);
            const strippedLine = stripLineBasedOnMode(lineText, options.commentMode as SourceSearchMode);

            const m = searchRegex.exec(strippedLine);
            if (m) {
                const colInLine = lineText.indexOf(m[0]);
                matches.push({
                    line: lineIdx + 1,
                    lineContent: lineText.trim(),
                    column: Math.max(0, colInLine),
                });
            }

            start = end === -1 ? text.length : end + 1;
            lineIdx++;
        }

        if (matches.length > 0 || hasFileNameMatch) {
            const stat = await vscode.workspace.fs.stat(uri);
            const relativePath = vscode.workspace.asRelativePath(uri);

            return {
                fileUri: uri.toString(),
                fileName,
                relativePath,
                mtime: stat.mtime,
                matchCount: matches.length,
                matches,
                isFileNameMatch: hasFileNameMatch && matches.length === 0 ? true : undefined,
            };
        }
    } catch {
        // Skip files that can't be read
    }

    return null;
}

export async function replaceInFiles(
    options: FileSearchOptions,
    token: vscode.CancellationToken
): Promise<{ modifiedCount: number; matchCount: number; skippedDirtyCount: number }> {
    const uris = await collectFileUris(options.fileTypes);
    if (uris.length === 0) return { modifiedCount: 0, matchCount: 0, skippedDirtyCount: 0 };

    const replaceRegex = buildSearchRegex(options.term, options.caseSensitive, options.wholeWord, options.useRegex, true);
    let modifiedCount = 0;
    let matchCount = 0;
    let skippedDirtyCount = 0;

    const edit = new vscode.WorkspaceEdit();

    for (const uri of uris) {
        if (token.isCancellationRequested) break;

        try {
            const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
            if (openDoc && openDoc.isDirty) {
                skippedDirtyCount++;
                continue;
            }

            const content = await vscode.workspace.fs.readFile(uri);
            const text = new TextDecoder().decode(content);

            const newText = text.replace(replaceRegex, options.replaceText || '');

            if (newText !== text) {
                const lines = text.split('\n');
                const lastLine = lines.length - 1;
                edit.replace(uri, new vscode.Range(
                    new vscode.Position(0, 0),
                    new vscode.Position(lastLine, lines[lastLine].length)
                ), newText);

                const matchArr = text.match(replaceRegex);
                if (matchArr) matchCount += matchArr.length;
                modifiedCount++;
            }

            await new Promise(resolve => setTimeout(resolve, 0));
        } catch {
            // Skip files that can't be modified
        }
    }

    if (modifiedCount > 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
        await vscode.workspace.applyEdit(edit);
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    return { modifiedCount, matchCount, skippedDirtyCount };
}

export { buildSearchRegex };
