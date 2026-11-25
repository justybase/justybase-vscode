import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { runExplainQuery } from '../queryRunner';
import type { ExplainRequest } from './explainRequest';

/**
 * Executes one dialect EXPLAIN. Dialects that persist the plan in catalog
 * tables (Db2 `EXPLAIN PLAN FOR`, Oracle `PLAN_TABLE`) also return a retrieval
 * statement; the runner executes it on the same connection and returns JSON.
 */
export async function runExplainRequest(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    documentUri: string | undefined,
    request: ExplainRequest,
): Promise<string> {
    if (request.retrieveQuery) {
        return await runExplainQuery(
            context,
            request.explainSql,
            connectionName,
            connectionManager,
            documentUri,
            undefined,
            { retrieveQuery: request.retrieveQuery },
        );
    }

    return await runExplainQuery(
        context,
        request.explainSql,
        connectionName,
        connectionManager,
        documentUri,
    );
}
