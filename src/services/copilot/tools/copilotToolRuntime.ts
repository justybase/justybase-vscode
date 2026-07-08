import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager } from '../../../core/connectionManager';
import {
    createConnectedDatabaseConnectionFromDetails,
    executeDatabaseQuery
} from '../../../core/connectionFactory';
import { runQuery } from '../../../core/queryRunner';
import { ConnectionDetails, ResultSet } from '../../../types';
import { ResultPanelView } from '../../../views/resultPanelView';

export interface CopilotToolRuntimeDeps {
    connectionManager: ConnectionManager;
    context: vscode.ExtensionContext;
    resultPanelProvider?: ResultPanelView;
}

export class CopilotToolRuntime {
    constructor(private readonly deps: CopilotToolRuntimeDeps) { }

    normalizeScopeDatabase(database?: string): string | undefined {
        if (!database) {
            return undefined;
        }

        const trimmed = database.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }

    serializeRows(rows: Record<string, unknown>[]): string {
        return JSON.stringify(
            rows,
            (_key, value) => {
                if (typeof value === 'bigint') {
                    if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
                        return Number(value);
                    }
                    return value.toString();
                }
                return value;
            },
            2
        );
    }

    async runQueryInDatabaseScope(sql: string, database: string, description: string): Promise<string> {
        const { connectionDetails } = await this.getActiveConnectionDetails();
        const connection = await createConnectedDatabaseConnectionFromDetails(connectionDetails, database);

        try {
            const rows = await executeDatabaseQuery<Record<string, unknown>>(connection, sql);
            return rows.length > 0 ? this.serializeRows(rows) : `No ${description} found`;
        } finally {
            await connection.close();
        }
    }

    async runExplainInDatabaseScope(explainSql: string, database: string): Promise<string> {
        const { connectionDetails } = await this.getActiveConnectionDetails();
        const connection = await createConnectedDatabaseConnectionFromDetails(connectionDetails, database);
        const notices: string[] = [];

        const noticeHandler = (msg: unknown): void => {
            const notification = msg as { message?: unknown };
            if (typeof notification.message === 'string') {
                notices.push(notification.message);
            }
        };

        connection.on('notice', noticeHandler);

        try {
            const command = connection.createCommand(explainSql);
            const reader = await command.executeReader();
            try {
                while (await reader.read()) {
                    // Drain reader; EXPLAIN text is captured from NOTICE events.
                }
            } finally {
                await reader.close();
            }
        } finally {
            connection.removeListener('notice', noticeHandler);
            await connection.close();
        }

        return notices.join('\n');
    }

    async runQuerySafe(sql: string, description: string, database?: string): Promise<string> {
        const activeConn = this.deps.connectionManager.getActiveConnectionName();
        if (!activeConn) throw new Error('No active connection');

        const scopedDatabase = this.normalizeScopeDatabase(database);
        try {
            if (scopedDatabase) {
                return await this.runQueryInDatabaseScope(sql, scopedDatabase, description);
            }

            const result = await runQuery(this.deps.context, sql, true, activeConn);
            return result || `No ${description} found`;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (scopedDatabase) {
                throw new Error(`Failed to ${description} in database "${scopedDatabase}": ${msg}`, { cause: e });
            }
            throw new Error(`Failed to ${description}: ${msg}`, { cause: e });
        }
    }

    async runNonQueryInDatabaseScope(sql: string, database: string, description: string): Promise<string> {
        const { connectionDetails } = await this.getActiveConnectionDetails();
        const connection = await createConnectedDatabaseConnectionFromDetails(connectionDetails, database);

        try {
            const command = connection.createCommand(sql);
            const reader = await command.executeReader();
            try {
                while (await reader.read()) {
                    // Drain reader
                }
            } finally {
                await reader.close();
            }
            return `${description.charAt(0).toUpperCase() + description.slice(1)} executed successfully in database "${database}".`;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return `${description.charAt(0).toUpperCase() + description.slice(1)} FAILED in database "${database}": ${msg}`;
        } finally {
            await connection.close();
        }
    }

    extractSingleColumnValue(result: string): string | undefined {
        if (!result || result.trim().length === 0) {
            return undefined;
        }

        const trimmed = result.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
                const parsed = JSON.parse(trimmed);
                const rows = Array.isArray(parsed) ? parsed : [parsed];
                if (rows.length > 0) {
                    const firstRow = rows[0];
                    const values = Object.values(firstRow);
                    if (values.length > 0 && typeof values[0] === 'string') {
                        return values[0];
                    }
                }
                return undefined;
            } catch {
                // Fall through to pipe-delimited parsing
            }
        }

        const lines = result.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        if (lines.length === 0) {
            return undefined;
        }

        if (lines.length >= 2) {
            return lines[1];
        }

        const maybeHeader = lines[0].toUpperCase();
        if (maybeHeader === 'OWNER' || maybeHeader === 'SCHEMA') {
            return undefined;
        }

        return lines[0];
    }

    parseStructuredQueryResult(result: string): Array<Record<string, unknown>> {
        if (!result || result.trim().length === 0) {
            return [];
        }

        const trimmed = result.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return parsed.filter(row => typeof row === 'object' && row !== null) as Array<Record<string, unknown>>;
                }
                if (typeof parsed === 'object' && parsed !== null) {
                    return [parsed as Record<string, unknown>];
                }
                return [];
            } catch {
                // Fall through to pipe parsing.
            }
        }

        const lines = result
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        if (lines.length < 2 || !lines[0].includes('|')) {
            return [];
        }

        const headers = lines[0]
            .split('|')
            .map(header => header.trim())
            .filter(header => header.length > 0);
        if (headers.length === 0) {
            return [];
        }

        const rows: Array<Record<string, unknown>> = [];
        for (let index = 1; index < lines.length; index++) {
            const line = lines[index];
            if (/^[-| ]+$/.test(line)) {
                continue;
            }

            const values = line.split('|').map(value => value.trim());
            if (values.length === 0) {
                continue;
            }

            const row: Record<string, unknown> = {};
            headers.forEach((header, headerIndex) => {
                row[header] = values[headerIndex] ?? '';
            });

            rows.push(row);
        }

        return rows;
    }

    getRowValue(row: Record<string, unknown>, ...candidateKeys: string[]): string | undefined {
        for (const key of candidateKeys) {
            for (const [rowKey, value] of Object.entries(row)) {
                if (rowKey.toUpperCase() !== key.toUpperCase()) {
                    continue;
                }

                if (value === undefined || value === null) {
                    return undefined;
                }

                const normalized = String(value).trim();
                return normalized.length > 0 ? normalized : undefined;
            }
        }

        return undefined;
    }

    async getActiveConnectionDetails(): Promise<{ connectionName: string; connectionDetails: ConnectionDetails }> {
        const connectionName = this.deps.connectionManager.getActiveConnectionName();
        if (!connectionName) {
            throw new Error('No active database connection.');
        }

        const connectionDetails = await this.deps.connectionManager.getConnection(connectionName);
        if (!connectionDetails) {
            throw new Error(`Connection "${connectionName}" not found.`);
        }

        return { connectionName, connectionDetails };
    }

    formatStructuredToolResponse(payload: {
        summary: string;
        data?: unknown;
        errors?: string[];
        nextActions?: string[];
    }): string {
        const errors = payload.errors && payload.errors.length > 0 ? payload.errors : ['none'];
        const nextActions = payload.nextActions && payload.nextActions.length > 0 ? payload.nextActions : ['none'];
        const data = payload.data ?? {};

        return [
            'summary:',
            payload.summary,
            '',
            'data:',
            '```json',
            JSON.stringify(data, null, 2),
            '```',
            '',
            'errors:',
            ...errors.map(error => `- ${error}`),
            '',
            'next-actions:',
            ...nextActions.map(action => `- ${action}`)
        ].join('\n');
    }

    getEditorSqlCandidate(): string | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return undefined;
        }

        const selected = editor.selection && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
        if (selected.trim().length > 0) {
            return selected;
        }

        const fullSql = editor.document.getText();
        return fullSql.trim().length > 0 ? fullSql : undefined;
    }

    resolveSqlInput(sql?: string, sqlFilePath?: string): { sql?: string; source: 'inline' | 'file' | 'activeEditor' | 'missing'; hint?: string } {
        if (sql && sql.trim().length > 0) {
            return { sql: sql.trim(), source: 'inline' };
        }

        if (sqlFilePath && sqlFilePath.trim().length > 0) {
            const candidatePath = sqlFilePath.trim();
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const fileCandidates = [candidatePath];
            if (!path.isAbsolute(candidatePath) && workspaceRoot) {
                fileCandidates.push(path.join(workspaceRoot, candidatePath));
            }

            for (const candidate of fileCandidates) {
                if (fs.existsSync(candidate)) {
                    const fromFile = fs.readFileSync(candidate, 'utf8');
                    if (fromFile.trim().length > 0) {
                        return { sql: fromFile, source: 'file', hint: candidate };
                    }
                }
            }
        }

        const editorSql = this.getEditorSqlCandidate();
        if (editorSql && editorSql.trim().length > 0) {
            return { sql: editorSql, source: 'activeEditor' };
        }

        return { source: 'missing' };
    }

    getActiveResultSetForExport(): { sourceUri: string; resultSet: ResultSet; resultSetIndex: number } {
        if (!this.deps.resultPanelProvider) {
            throw new Error('Results panel provider is not available.');
        }

        const activeSource = this.deps.resultPanelProvider.getActiveSource();
        if (!activeSource) {
            throw new Error('No active source in Netezza Results.');
        }

        const resultSets = this.deps.resultPanelProvider.getResultsForSource(activeSource) || [];
        const candidateIndex = (() => {
            for (let index = resultSets.length - 1; index >= 0; index--) {
                const set = resultSets[index];
                if (!set?.isLog && Array.isArray(set.data) && Array.isArray(set.columns)) {
                    return index;
                }
            }
            return -1;
        })();

        if (candidateIndex < 0) {
            throw new Error('No data result set available in active Netezza Results source.');
        }

        return {
            sourceUri: activeSource,
            resultSet: resultSets[candidateIndex],
            resultSetIndex: candidateIndex
        };
    }

    getDiagnosticSeverityLabel(severity: vscode.DiagnosticSeverity): string {
        switch (severity) {
            case vscode.DiagnosticSeverity.Error:
                return 'error';
            case vscode.DiagnosticSeverity.Warning:
                return 'warning';
            case vscode.DiagnosticSeverity.Information:
                return 'information';
            case vscode.DiagnosticSeverity.Hint:
                return 'hint';
            default:
                return 'unknown';
        }
    }

    getLineColumnFromOffset(text: string, offset: number): { line: number; column: number } {
        const boundedOffset = Math.max(0, Math.min(offset, text.length));
        let line = 1;
        let column = 1;

        for (let index = 0; index < boundedOffset; index++) {
            if (text[index] === '\n') {
                line += 1;
                column = 1;
            } else {
                column += 1;
            }
        }

        return { line, column };
    }
}
