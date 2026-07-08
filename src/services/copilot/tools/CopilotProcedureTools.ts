import * as vscode from 'vscode';
import { ConnectionManager } from '../../../core/connectionManager';
import { runQueryRaw } from '../../../core/queryRunner';
import { CopilotToolRuntime } from './copilotToolRuntime';

interface CopilotProcedureToolsDeps {
    connectionManager: ConnectionManager;
    context: vscode.ExtensionContext;
    runtime: CopilotToolRuntime;
}

export class CopilotProcedureTools {
    constructor(private readonly deps: CopilotProcedureToolsDeps) { }

    async compileProcedure(sql: string, database?: string): Promise<string> {
        if (!sql.trim().toUpperCase().startsWith('CREATE') && !sql.trim().toUpperCase().startsWith('ALTER')) {
            throw new Error('Only CREATE OR REPLACE PROCEDURE (or ALTER) statements are valid for compilation.');
        }

        const description = 'compile procedure';
        const scopedDatabase = this.deps.runtime.normalizeScopeDatabase(database);

        try {
            if (scopedDatabase) {
                const result = await this.deps.runtime.runNonQueryInDatabaseScope(sql, scopedDatabase, description);
                return result;
            }

            const activeConn = this.deps.connectionManager.getActiveConnectionName();
            if (!activeConn) throw new Error('No active connection');

            const result = await runQueryRaw(this.deps.context, sql, true, this.deps.connectionManager, activeConn);
            if (result.isError) {
                return `Compilation FAILED: ${result.message || 'Unknown error'}`;
            }
            return `Compilation SUCCESS: ${result.message || 'Procedure compiled successfully.'}`;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return `Compilation FAILED: ${msg}`;
        }
    }

    async executeProcedure(procedureName: string, args?: string, database?: string): Promise<string> {
        if (!procedureName) {
            throw new Error('Procedure name is required.');
        }

        const argsStr = args ? `(${args})` : '()';
        const sql = `CALL ${procedureName}${argsStr}`;
        const description = 'execute procedure';
        const scopedDatabase = this.deps.runtime.normalizeScopeDatabase(database);

        try {
            if (scopedDatabase) {
                const result = await this.deps.runtime.runNonQueryInDatabaseScope(sql, scopedDatabase, description);
                return result;
            }

            const activeConn = this.deps.connectionManager.getActiveConnectionName();
            if (!activeConn) throw new Error('No active connection');

            const result = await runQueryRaw(this.deps.context, sql, true, this.deps.connectionManager, activeConn);
            if (result.isError) {
                return `Execution FAILED: ${result.message || 'Unknown error'}`;
            }
            return `Execution SUCCESS: ${result.message || 'Procedure executed successfully.'}`;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return `Execution FAILED: ${msg}`;
        }
    }

    async runDiagnosticQueries(queries: string[], database?: string): Promise<string> {
        if (!queries || queries.length === 0) {
            throw new Error('At least one diagnostic SQL query is required.');
        }

        const results: string[] = [];
        let passed = 0;
        let failed = 0;

        for (let i = 0; i < queries.length; i++) {
            const query = queries[i];
            const label = `Diagnostic #${i + 1}`;
            try {
                const result = await this.deps.runtime.runQuerySafe(query, label, database);
                results.push(`${label} PASS: ${result}`);
                passed++;
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`${label} FAIL: ${msg}`);
                failed++;
            }
        }

        const summary = `Diagnostics complete: ${passed} passed, ${failed} failed out of ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}.`;
        return [summary, '', ...results].join('\n');
    }

}
