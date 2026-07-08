/**
 * Wizard Commands - Create Procedure, View, and External Table
 * Extracted from extension.ts to reduce activate() size.
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import { getTemplatesByCategory, getTemplateById } from '../providers/procedureTemplates';
import { formatIdentifierForSql } from '../utils/identifierUtils';
import {
    generateBasicExternalTableSQL,
    generateAdvancedExternalTableSQL,
    ExternalTableParams,
} from '../providers/externalTableTemplates';

export interface WizardCommandsContext {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
}

interface ProcedureFolderItem {
    dbName?: string;
    schema?: string;
    connectionName?: string;
}

interface SnowflakeObjectItem {
    dbName?: string;
    schema?: string;
    connectionName?: string;
    objName?: string;
    label?: string;
}

function normalizeIdentifier(value: string | undefined, fallback: string): string {
    const normalized = (value || '').replace(/"/g, '').trim().toUpperCase();
    return normalized.length > 0 ? normalized : fallback;
}

function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

function isSnowflakeConnection(deps: WizardCommandsContext, connectionName?: string): boolean {
    return deps.connectionManager.getConnectionDatabaseKind(connectionName) === 'snowflake';
}

function buildSnowflakeQualifiedName(item: SnowflakeObjectItem, objectName: string): string {
    return [
        formatIdentifierForSql(normalizeIdentifier(item.dbName, 'DATABASE'), 'snowflake'),
        formatIdentifierForSql(normalizeIdentifier(item.schema || 'PUBLIC', 'PUBLIC'), 'snowflake'),
        formatIdentifierForSql(normalizeIdentifier(objectName, 'OBJECT_NAME'), 'snowflake'),
    ].join('.');
}

function formatSnowflakeTargetLag(value: string): string {
    const trimmed = value.trim();
    return trimmed.toUpperCase() === 'DOWNSTREAM' ? 'DOWNSTREAM' : `'${escapeSqlLiteral(trimmed)}'`;
}

function buildSnowflakeDynamicTableStatusSql(item: SnowflakeObjectItem, objectName: string): string {
    const likeName = escapeSqlLiteral(normalizeIdentifier(objectName, 'DYNAMIC_TABLE'));
    const schemaName = [
        formatIdentifierForSql(normalizeIdentifier(item.dbName, 'DATABASE'), 'snowflake'),
        formatIdentifierForSql(normalizeIdentifier(item.schema || 'PUBLIC', 'PUBLIC'), 'snowflake'),
    ].join('.');
    const qualifiedName = buildSnowflakeQualifiedName(item, objectName);

    return [
        `SHOW DYNAMIC TABLES LIKE '${likeName}' IN SCHEMA ${schemaName}`,
        '->> SELECT',
        '        "name" AS "NAME",',
        '        "database_name" AS "DATABASE",',
        '        "schema_name" AS "SCHEMA",',
        '        "owner" AS "OWNER",',
        '        "scheduling_state" AS "STATE",',
        '        "scheduler" AS "SCHEDULER",',
        '        "target_lag" AS "TARGET_LAG",',
        '        "warehouse" AS "WAREHOUSE",',
        '        "refresh_mode" AS "REFRESH_MODE",',
        '        "refresh_mode_reason" AS "REFRESH_MODE_REASON",',
        '        "last_suspended_on" AS "LAST_SUSPENDED_ON",',
        '        "data_timestamp" AS "DATA_TIMESTAMP",',
        '        COALESCE("comment", \'\') AS "COMMENT"',
        '    FROM $1;',
        '',
        `DESCRIBE DYNAMIC TABLE ${qualifiedName};`,
    ].join('\n');
}

async function executeSnowflakeDynamicTableStatement(
    deps: WizardCommandsContext,
    connectionName: string,
    sql: string,
    progressTitle: string,
    successMessage: string,
): Promise<void> {
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: progressTitle,
            },
            async () => {
                await runQueryRaw(
                    deps.context,
                    sql,
                    true,
                    deps.connectionManager,
                    connectionName,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    false,
                );
            },
        );
        vscode.window.showInformationMessage(successMessage);
        void vscode.commands.executeCommand('netezza.refreshSchema');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`${progressTitle} failed: ${message}`);
    }
}

async function openSqlDocument(content: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({
        content,
        language: 'sql',
    });
    await vscode.window.showTextDocument(doc);
}

function ensureExternalTableCapability(deps: WizardCommandsContext, connectionName?: string): boolean {
    const resolvedConnectionName = deps.connectionManager.resolveConnectionName(undefined, connectionName);
    if (!resolvedConnectionName) {
        vscode.window.showErrorMessage('No database connection. Please connect first.');
        return false;
    }

    if (!deps.connectionManager.supportsCapability('supportsExternalTables', undefined, resolvedConnectionName)) {
        vscode.window.showErrorMessage('External tables are not supported for the active database dialect.');
        return false;
    }

    return true;
}

function ensureProcedureCapability(deps: WizardCommandsContext, connectionName?: string): boolean {
    const resolvedConnectionName = deps.connectionManager.resolveConnectionName(undefined, connectionName);
    if (!resolvedConnectionName) {
        vscode.window.showErrorMessage('No database connection. Please connect first.');
        return false;
    }

    if (!deps.connectionManager.supportsCapability('supportsProcedures', undefined, resolvedConnectionName)) {
        vscode.window.showErrorMessage('Procedures are not supported for the active database dialect.');
        return false;
    }

    return true;
}

async function resolveProcedureSchema(
    item: ProcedureFolderItem,
    database: string,
    deps: WizardCommandsContext,
): Promise<string> {
    if (item.schema && item.schema.trim().length > 0) {
        return normalizeIdentifier(item.schema, 'ADMIN');
    }

    const activeUri = vscode.window.activeTextEditor?.document?.uri?.toString();
    const connectionName =
        item.connectionName ||
        deps.connectionManager.getConnectionForExecution(activeUri) ||
        deps.connectionManager.getActiveConnectionName() ||
        undefined;

    if (!connectionName) {
        return 'ADMIN';
    }

    const safeDatabase = normalizeIdentifier(database, 'SYSTEM');
    const escapedDatabaseLiteral = escapeSqlLiteral(safeDatabase);
    const sql = `SELECT DEFSCHEMA FROM ${safeDatabase}.._V_DATABASE ` + `WHERE DATABASE = '${escapedDatabaseLiteral}'`;

    try {
        const result = await runQueryRaw(
            deps.context,
            sql,
            true,
            deps.connectionManager,
            connectionName,
            undefined,
            undefined,
            undefined,
            1,
            false,
        );
        if (!result) {
            return 'ADMIN';
        }
        const rows = queryResultToRows<{ DEFSCHEMA?: string }>(result);
        if (!rows || rows.length === 0) {
            return 'ADMIN';
        }
        return normalizeIdentifier(rows[0].DEFSCHEMA, 'ADMIN');
    } catch (error: unknown) {
        console.warn('[WizardCommands] Failed to resolve default schema for procedure draft:', error);
        return 'ADMIN';
    }
}

export function registerWizardCommands(_ctx: WizardCommandsContext): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('netezza.createProcedure', async (item: ProcedureFolderItem) => {
            const itemObj = item;
            if (!itemObj || !itemObj.dbName) {
                vscode.window.showErrorMessage('Invalid selection. Select a Procedure folder.');
                return;
            }

            if (!ensureProcedureCapability(_ctx, itemObj.connectionName)) {
                return;
            }

            const database = itemObj.dbName;

            // Step 1: Show category selection
            const categorySelection = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(gift) Basic',
                        description: 'Simple procedures with basic error handling',
                        category: 'basic',
                    },
                    {
                        label: '$(tools) Advanced',
                        description: 'Complex procedures with advanced error handling patterns',
                        category: 'advanced',
                    },
                ],
                {
                    placeHolder: 'Select procedure category',
                    title: 'Create Netezza Procedure',
                },
            );

            if (!categorySelection) return;

            // Step 2: Show template selection for the category
            const templatesByCategory = getTemplatesByCategory();
            const templates =
                categorySelection.category === 'basic' ? templatesByCategory.basic : templatesByCategory.advanced;

            const templateSelection = await vscode.window.showQuickPick(
                templates.map((t) => ({
                    label: t.name,
                    description: t.description,
                    templateId: t.id,
                    detail: `$(file-code) ${t.name}`,
                })),
                {
                    placeHolder: 'Select a procedure template',
                    title: `Choose ${categorySelection.category} template`,
                },
            );

            if (!templateSelection) return;

            // Step 3: Ask for procedure name
            const procName = await vscode.window.showInputBox({
                prompt: 'Enter new procedure name',
                placeHolder: 'NEW_PROCEDURE',
                value: 'NEW_PROCEDURE',
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return null;
                    }
                    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value.trim())) {
                        return 'Invalid procedure name. Use only letters, numbers, and underscores.';
                    }
                    return null;
                },
            });

            if (procName === undefined) return;

            const finalName = normalizeIdentifier(procName.trim(), 'NEW_PROCEDURE');
            const schema = await resolveProcedureSchema(itemObj, database, _ctx);

            // Get the template and generate code
            const template = getTemplateById(templateSelection.templateId);
            if (!template) {
                vscode.window.showErrorMessage('Template not found');
                return;
            }

            const codetemplate = template.template(finalName, database, schema);

            const doc = await vscode.workspace.openTextDocument({
                content: codetemplate,
                language: 'sql',
            });
            await vscode.window.showTextDocument(doc);
        }),

        vscode.commands.registerCommand(
            'netezza.createSequence',
            async (item: { dbName?: string; schema?: string; connectionName?: string }) => {
                const itemObj = item;
                if (!itemObj || !itemObj.dbName) {
                    vscode.window.showErrorMessage('Invalid selection. Select a Sequence folder.');
                    return;
                }

                const connectionName = itemObj.connectionName;
                const databaseKind = _ctx.connectionManager.getConnectionDatabaseKind(connectionName);
                if (databaseKind !== 'postgresql') {
                    vscode.window.showErrorMessage(
                        'Sequence wizard is currently implemented for PostgreSQL connections.',
                    );
                    return;
                }

                const sequenceName = await vscode.window.showInputBox({
                    prompt: 'Enter new sequence name',
                    placeHolder: 'order_id_seq',
                    value: 'new_sequence',
                    validateInput: (value) => {
                        if (!value || value.trim().length === 0) {
                            return 'Sequence name cannot be empty';
                        }
                        return null;
                    },
                });

                if (!sequenceName) {
                    return;
                }

                const schemaName = (itemObj.schema || 'public').trim();
                const startWith = await vscode.window.showInputBox({
                    prompt: 'START WITH value',
                    value: '1',
                    validateInput: (value) => (/^\d+$/.test(value.trim()) ? null : 'Provide a positive integer.'),
                });
                if (!startWith) {
                    return;
                }

                const incrementBy = await vscode.window.showInputBox({
                    prompt: 'INCREMENT BY value',
                    value: '1',
                    validateInput: (value) => (/^-?\d+$/.test(value.trim()) ? null : 'Provide an integer.'),
                });
                if (!incrementBy) {
                    return;
                }

                const cycle = await vscode.window.showQuickPick(
                    [
                        { label: 'NO CYCLE', cycle: false },
                        { label: 'CYCLE', cycle: true },
                    ],
                    {
                        placeHolder: 'Select whether the sequence should cycle',
                    },
                );
                if (!cycle) {
                    return;
                }

                const sql = [
                    `CREATE SEQUENCE ${formatIdentifierForSql(schemaName, 'postgresql')}.${formatIdentifierForSql(sequenceName.trim(), 'postgresql')}`,
                    `    START WITH ${startWith.trim()}`,
                    `    INCREMENT BY ${incrementBy.trim()}`,
                    '    NO MINVALUE',
                    '    NO MAXVALUE',
                    '    CACHE 1',
                    `    ${cycle.cycle ? 'CYCLE' : 'NO CYCLE'};`,
                ].join('\n');

                const doc = await vscode.workspace.openTextDocument({
                    content: sql,
                    language: 'sql',
                });
                await vscode.window.showTextDocument(doc);
            },
        ),

        vscode.commands.registerCommand(
            'netezza.createSnowflakeStream',
            async (item: { dbName?: string; schema?: string; connectionName?: string }) => {
                const itemObj = item;
                if (!itemObj || !itemObj.dbName) {
                    vscode.window.showErrorMessage('Invalid selection. Select a Stream folder.');
                    return;
                }

                if (!isSnowflakeConnection(_ctx, itemObj.connectionName)) {
                    vscode.window.showErrorMessage('Stream wizard is currently implemented for Snowflake connections.');
                    return;
                }

                const streamName = await vscode.window.showInputBox({
                    prompt: 'Enter new stream name',
                    placeHolder: 'orders_stream',
                    value: 'new_stream',
                    validateInput: (value) => (!value || !value.trim() ? 'Stream name cannot be empty' : null),
                });
                if (!streamName) {
                    return;
                }

                const sourceType = await vscode.window.showQuickPick(
                    [
                        { label: 'TABLE', sourceType: 'TABLE' as const },
                        { label: 'VIEW', sourceType: 'VIEW' as const },
                    ],
                    { placeHolder: 'Select Snowflake source object type' },
                );
                if (!sourceType) {
                    return;
                }

                const sourceObject = await vscode.window.showInputBox({
                    prompt: `Enter source ${sourceType.sourceType.toLowerCase()} name`,
                    placeHolder: 'orders',
                    validateInput: (value) => (!value || !value.trim() ? 'Source object is required' : null),
                });
                if (!sourceObject) {
                    return;
                }

                const appendOnly = await vscode.window.showQuickPick(
                    [
                        { label: 'APPEND_ONLY = FALSE', appendOnly: false },
                        { label: 'APPEND_ONLY = TRUE', appendOnly: true },
                    ],
                    { placeHolder: 'Select stream mode' },
                );
                if (!appendOnly) {
                    return;
                }

                const normalizedStreamName = normalizeIdentifier(streamName.trim(), 'NEW_STREAM');
                const normalizedSourceObject = normalizeIdentifier(sourceObject.trim(), 'SOURCE_OBJECT');
                const schemaName = (itemObj.schema || 'PUBLIC').trim();
                const sql = [
                    `CREATE OR REPLACE STREAM ${formatIdentifierForSql(normalizeIdentifier(itemObj.dbName, itemObj.dbName), 'snowflake')}.${formatIdentifierForSql(normalizeIdentifier(schemaName, 'PUBLIC'), 'snowflake')}.${formatIdentifierForSql(normalizedStreamName, 'snowflake')}`,
                    `    ON ${sourceType.sourceType} ${formatIdentifierForSql(normalizeIdentifier(itemObj.dbName, itemObj.dbName), 'snowflake')}.${formatIdentifierForSql(normalizeIdentifier(schemaName, 'PUBLIC'), 'snowflake')}.${formatIdentifierForSql(normalizedSourceObject, 'snowflake')}`,
                    `    APPEND_ONLY = ${appendOnly.appendOnly ? 'TRUE' : 'FALSE'};`,
                ].join('\n');

                const doc = await vscode.workspace.openTextDocument({
                    content: sql,
                    language: 'sql',
                });
                await vscode.window.showTextDocument(doc);
            },
        ),

        vscode.commands.registerCommand(
            'netezza.createSnowflakeTask',
            async (item: { dbName?: string; schema?: string; connectionName?: string }) => {
                const itemObj = item;
                if (!itemObj || !itemObj.dbName) {
                    vscode.window.showErrorMessage('Invalid selection. Select a Task folder.');
                    return;
                }

                if (!isSnowflakeConnection(_ctx, itemObj.connectionName)) {
                    vscode.window.showErrorMessage('Task wizard is currently implemented for Snowflake connections.');
                    return;
                }

                const taskName = await vscode.window.showInputBox({
                    prompt: 'Enter new task name',
                    placeHolder: 'daily_orders_task',
                    value: 'new_task',
                    validateInput: (value) => (!value || !value.trim() ? 'Task name cannot be empty' : null),
                });
                if (!taskName) {
                    return;
                }

                const warehouse = await vscode.window.showInputBox({
                    prompt: 'Warehouse for the task',
                    placeHolder: 'TRANSFORMING_WH',
                    validateInput: (value) => (!value || !value.trim() ? 'Warehouse is required.' : null),
                });
                if (!warehouse) {
                    return;
                }

                const schedule = await vscode.window.showInputBox({
                    prompt: 'Task schedule expression',
                    placeHolder: 'USING CRON 0 * * * * UTC',
                    value: 'USING CRON 0 * * * * UTC',
                    validateInput: (value) => (!value || !value.trim() ? 'Schedule is required.' : null),
                });
                if (!schedule) {
                    return;
                }

                const body = await vscode.window.showInputBox({
                    prompt: 'Task SQL body',
                    placeHolder: 'CALL PROCESS_ORDERS();',
                    value: 'SELECT CURRENT_TIMESTAMP();',
                    validateInput: (value) => (!value || !value.trim() ? 'Task SQL body is required.' : null),
                });
                if (!body) {
                    return;
                }

                const normalizedTaskName = normalizeIdentifier(taskName.trim(), 'NEW_TASK');
                const normalizedWarehouse = normalizeIdentifier(warehouse.trim(), 'TRANSFORMING_WH');
                const schemaName = (itemObj.schema || 'PUBLIC').trim();
                const sql = [
                    `CREATE OR REPLACE TASK ${formatIdentifierForSql(normalizeIdentifier(itemObj.dbName, itemObj.dbName), 'snowflake')}.${formatIdentifierForSql(normalizeIdentifier(schemaName, 'PUBLIC'), 'snowflake')}.${formatIdentifierForSql(normalizedTaskName, 'snowflake')}`,
                    `    WAREHOUSE = ${formatIdentifierForSql(normalizedWarehouse, 'snowflake')}`,
                    `    SCHEDULE = '${schedule.trim().replace(/'/g, "''")}'`,
                    'AS',
                    `${body.trim().replace(/;?\s*$/, ';')}`,
                ].join('\n');

                const doc = await vscode.workspace.openTextDocument({
                    content: sql,
                    language: 'sql',
                });
                await vscode.window.showTextDocument(doc);
            },
        ),

        vscode.commands.registerCommand(
            'netezza.createSnowflakeDynamicTable',
            async (item: SnowflakeObjectItem) => {
                const itemObj = item;
                if (!itemObj || !itemObj.dbName) {
                    vscode.window.showErrorMessage('Invalid selection. Select a Dynamic Table folder.');
                    return;
                }

                if (!isSnowflakeConnection(_ctx, itemObj.connectionName)) {
                    vscode.window.showErrorMessage('Dynamic Table wizard is currently implemented for Snowflake connections.');
                    return;
                }

                const tableName = await vscode.window.showInputBox({
                    prompt: 'Enter new dynamic table name',
                    placeHolder: 'orders_dynamic',
                    value: 'new_dynamic_table',
                    validateInput: (value) => (!value || !value.trim() ? 'Dynamic table name cannot be empty' : null),
                });
                if (!tableName) {
                    return;
                }

                const targetLag = await vscode.window.showInputBox({
                    prompt: 'Target lag expression',
                    placeHolder: '5 MINUTES',
                    value: '5 MINUTES',
                    validateInput: (value) => (!value || !value.trim() ? 'Target lag is required.' : null),
                });
                if (!targetLag) {
                    return;
                }

                const warehouse = await vscode.window.showInputBox({
                    prompt: 'Warehouse for refresh execution',
                    placeHolder: 'TRANSFORMING_WH',
                    validateInput: (value) => (!value || !value.trim() ? 'Warehouse is required.' : null),
                });
                if (!warehouse) {
                    return;
                }

                const refreshMode = await vscode.window.showQuickPick(
                    [
                        { label: 'AUTO', refreshMode: 'AUTO' as const },
                        { label: 'INCREMENTAL', refreshMode: 'INCREMENTAL' as const },
                        { label: 'FULL', refreshMode: 'FULL' as const },
                    ],
                    { placeHolder: 'Select refresh mode' },
                );
                if (!refreshMode) {
                    return;
                }

                const initializeMode = await vscode.window.showQuickPick(
                    [
                        { label: 'ON_CREATE', initializeMode: 'ON_CREATE' as const },
                        { label: 'ON_SCHEDULE', initializeMode: 'ON_SCHEDULE' as const },
                    ],
                    { placeHolder: 'Select initialization mode' },
                );
                if (!initializeMode) {
                    return;
                }

                const queryBody = await vscode.window.showInputBox({
                    prompt: 'Dynamic table query',
                    placeHolder: 'SELECT * FROM ANALYTICS.PUBLIC.ORDERS;',
                    value: 'SELECT CURRENT_TIMESTAMP() AS REFRESHED_AT;',
                    validateInput: (value) => (!value || !value.trim() ? 'Dynamic table query is required.' : null),
                });
                if (!queryBody) {
                    return;
                }

                const qualifiedName = buildSnowflakeQualifiedName(itemObj, tableName.trim());
                const normalizedWarehouse = formatIdentifierForSql(
                    normalizeIdentifier(warehouse.trim(), 'TRANSFORMING_WH'),
                    'snowflake',
                );
                const sql = [
                    `CREATE OR REPLACE DYNAMIC TABLE ${qualifiedName}`,
                    `    TARGET_LAG = ${formatSnowflakeTargetLag(targetLag)}`,
                    `    WAREHOUSE = ${normalizedWarehouse}`,
                    `    REFRESH_MODE = ${refreshMode.refreshMode}`,
                    `    INITIALIZE = ${initializeMode.initializeMode}`,
                    'AS',
                    `${queryBody.trim().replace(/;+\s*$/, '')};`,
                ].join('\n');

                await openSqlDocument(sql);
            },
        ),

        vscode.commands.registerCommand(
            'netezza.manageSnowflakeDynamicTable',
            async (item: SnowflakeObjectItem) => {
                const itemObj = item;
                const selectedObjectName = itemObj?.objName || (typeof itemObj?.label === 'string' ? itemObj.label : '');
                if (!itemObj || !itemObj.dbName || !selectedObjectName.trim()) {
                    vscode.window.showErrorMessage('Invalid selection. Select a Dynamic Table.');
                    return;
                }

                if (!isSnowflakeConnection(_ctx, itemObj.connectionName)) {
                    vscode.window.showErrorMessage('Dynamic Table management is currently implemented for Snowflake connections.');
                    return;
                }

                const objectName = normalizeIdentifier(selectedObjectName, 'DYNAMIC_TABLE');
                const qualifiedName = buildSnowflakeQualifiedName(itemObj, objectName);
                const connectionName = _ctx.connectionManager.resolveConnectionName(undefined, itemObj.connectionName);
                if (!connectionName) {
                    vscode.window.showErrorMessage('No database connection. Please connect first.');
                    return;
                }
                const action = await vscode.window.showQuickPick(
                    [
                        { label: 'Update target lag / warehouse', action: 'update' as const },
                        { label: 'Suspend refreshes', action: 'suspend' as const },
                        { label: 'Resume refreshes', action: 'resume' as const },
                        { label: 'Refresh now', action: 'refresh' as const },
                        { label: 'Show refresh status query', action: 'status' as const },
                    ],
                    { placeHolder: 'Select a Dynamic Table action' },
                );
                if (!action) {
                    return;
                }

                if (action.action === 'update') {
                    const targetLag = await vscode.window.showInputBox({
                        prompt: 'Target lag expression',
                        placeHolder: '5 MINUTES',
                        value: '5 MINUTES',
                        validateInput: (value) => (!value || !value.trim() ? 'Target lag is required.' : null),
                    });
                    if (!targetLag) {
                        return;
                    }

                    const warehouse = await vscode.window.showInputBox({
                        prompt: 'Warehouse for refresh execution',
                        placeHolder: 'TRANSFORMING_WH',
                        validateInput: (value) => (!value || !value.trim() ? 'Warehouse is required.' : null),
                    });
                    if (!warehouse) {
                        return;
                    }

                    const normalizedWarehouse = formatIdentifierForSql(
                        normalizeIdentifier(warehouse.trim(), 'TRANSFORMING_WH'),
                        'snowflake',
                    );
                    const sql = [
                        `ALTER DYNAMIC TABLE ${qualifiedName} SET`,
                        `    TARGET_LAG = ${formatSnowflakeTargetLag(targetLag)},`,
                        `    WAREHOUSE = ${normalizedWarehouse};`,
                    ].join('\n');

                    await executeSnowflakeDynamicTableStatement(
                        _ctx,
                        connectionName,
                        sql,
                        `Updating ${qualifiedName}`,
                        `Dynamic table updated: ${qualifiedName}`,
                    );
                    return;
                }

                if (action.action === 'status') {
                    await openSqlDocument(buildSnowflakeDynamicTableStatusSql(itemObj, objectName));
                    return;
                }

                const statement =
                    action.action === 'suspend'
                        ? `ALTER DYNAMIC TABLE ${qualifiedName} SUSPEND;`
                        : action.action === 'resume'
                            ? `ALTER DYNAMIC TABLE ${qualifiedName} RESUME;`
                            : `ALTER DYNAMIC TABLE ${qualifiedName} REFRESH;`;

                const actionLabel =
                    action.action === 'suspend'
                        ? 'Suspending'
                        : action.action === 'resume'
                            ? 'Resuming'
                            : 'Refreshing';
                const successMessage =
                    action.action === 'suspend'
                        ? `Dynamic table suspended: ${qualifiedName}`
                        : action.action === 'resume'
                            ? `Dynamic table resumed: ${qualifiedName}`
                            : `Dynamic table refreshed: ${qualifiedName}`;

                await executeSnowflakeDynamicTableStatement(
                    _ctx,
                    connectionName,
                    statement,
                    `${actionLabel} ${qualifiedName}`,
                    successMessage,
                );
            },
        ),

        vscode.commands.registerCommand('netezza.createView', async (item: { dbName?: string; schema?: string }) => {
            const itemObj = item;
            if (!itemObj || !itemObj.dbName) {
                vscode.window.showErrorMessage('Invalid selection. Select a View folder.');
                return;
            }

            const database = normalizeIdentifier(itemObj.dbName, 'SYSTEM');
            const schema = normalizeIdentifier(itemObj.schema, 'ADMIN');

            const viewName = await vscode.window.showInputBox({
                prompt: 'Enter new view name',
                placeHolder: 'NEW_VIEW',
                value: 'NEW_VIEW',
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'View name cannot be empty';
                    }
                    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value.trim())) {
                        return 'Invalid view name. Use only letters, numbers, and underscores.';
                    }
                    return null;
                },
            });

            if (viewName === undefined) return;
            const finalViewName = normalizeIdentifier(viewName, 'NEW_VIEW');

            const columnAliases = await vscode.window.showInputBox({
                prompt: 'Optional column aliases (comma separated)',
                placeHolder: 'e.g. CUSTOMER_ID, CUSTOMER_NAME',
                value: '',
            });

            if (columnAliases === undefined) return;

            let aliasClause = '';
            if (columnAliases.trim().length > 0) {
                const aliases = columnAliases
                    .split(',')
                    .map((alias) => normalizeIdentifier(alias, ''))
                    .filter((alias) => alias.length > 0);

                if (aliases.length === 0) {
                    vscode.window.showErrorMessage('Column alias list cannot be empty when provided.');
                    return;
                }

                aliasClause = ` (${aliases.join(', ')})`;
            }

            const selectStatement = await vscode.window.showInputBox({
                prompt: 'Enter SELECT statement for view definition',
                placeHolder: 'SELECT * FROM MY_TABLE',
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'SELECT statement cannot be empty';
                    }
                    if (!/^(SELECT|WITH)\b/i.test(value.trim())) {
                        return 'View definition must start with SELECT or WITH';
                    }
                    return null;
                },
            });

            if (selectStatement === undefined) return;

            const normalizedSelect = selectStatement.trim().replace(/;+\s*$/, '');
            const sql =
                `CREATE OR REPLACE VIEW ${database}.${schema}.${finalViewName}${aliasClause} AS\n` +
                `${normalizedSelect};`;

            const doc = await vscode.workspace.openTextDocument({
                content: sql,
                language: 'sql',
            });
            await vscode.window.showTextDocument(doc);
        }),

        vscode.commands.registerCommand(
            'netezza.createExternalTable',
            async (item: { dbName?: string; schema?: string; connectionName?: string }) => {
                const itemObj = item;
                if (!itemObj || !itemObj.dbName) {
                    vscode.window.showErrorMessage('Invalid selection. Select an External Table folder.');
                    return;
                }

                if (!ensureExternalTableCapability(_ctx, itemObj.connectionName)) {
                    return;
                }

                const database = itemObj.dbName;
                const schema = itemObj.schema || 'ADMIN';

                // Step 1: Show mode selection (Basic vs Advanced)
                const modeSelection = await vscode.window.showQuickPick(
                    [
                        {
                            label: '$(gift) Basic',
                            description: 'Simple external table with minimal options',
                            mode: 'basic',
                        },
                        {
                            label: '$(tools) Advanced',
                            description: 'Full control over all external table options',
                            mode: 'advanced',
                        },
                    ],
                    {
                        placeHolder: 'Select wizard mode',
                        title: 'Create External Table - Select Mode',
                    },
                );

                if (!modeSelection) return;

                // Step 2: Ask for table name
                const tableName = await vscode.window.showInputBox({
                    prompt: 'Enter new external table name',
                    placeHolder: 'NEW_EXTERNAL_TABLE',
                    value: 'NEW_EXTERNAL_TABLE',
                    validateInput: (value) => {
                        if (!value || value.trim().length === 0) {
                            return 'Table name cannot be empty';
                        }
                        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value.trim())) {
                            return 'Invalid table name. Use only letters, numbers, and underscores.';
                        }
                        return null;
                    },
                });

                if (tableName === undefined) return;
                const finalTableName = tableName.trim().toUpperCase();

                // Step 3: Ask for file path
                const filePath = await vscode.window.showInputBox({
                    prompt: 'Enter source file path or S3 location',
                    placeHolder: '/path/to/file.csv or s3://bucket/path/file.csv',
                    validateInput: (value) => {
                        if (!value || value.trim().length === 0) {
                            return 'File path cannot be empty';
                        }
                        return null;
                    },
                });

                if (filePath === undefined) return;
                const finalFilePath = filePath.trim();

                // Step 4: Ask for columns
                const columns = await vscode.window.showInputBox({
                    prompt: 'Enter column definitions',
                    placeHolder: 'COL1 VARCHAR(100), COL2 INTEGER, COL3 DATE',
                    validateInput: (value) => {
                        if (!value || value.trim().length === 0) {
                            return 'Column definitions cannot be empty';
                        }
                        return null;
                    },
                });

                if (columns === undefined) return;
                const finalColumns = columns.trim();

                if (modeSelection.mode === 'basic') {
                    await handleBasicExternalTable(database, schema, finalTableName, finalFilePath, finalColumns);
                } else {
                    await handleAdvancedExternalTable(database, schema, finalTableName, finalFilePath, finalColumns);
                }
            },
        ),
    ];
}

async function handleBasicExternalTable(
    database: string,
    schema: string,
    tableName: string,
    filePath: string,
    columns: string,
): Promise<void> {
    const delimiter = await vscode.window.showInputBox({
        prompt: 'Enter field delimiter',
        placeHolder: ', (comma)',
        value: ',',
    });

    const skipRows = await vscode.window.showInputBox({
        prompt: 'Number of rows to skip',
        placeHolder: '0',
        value: '0',
    });

    const hasHeader = await vscode.window.showQuickPick(
        [
            {
                label: 'Yes',
                description: 'First row contains column names',
                value: 'true',
            },
            { label: 'No', description: 'No header row', value: 'false' },
        ],
        { placeHolder: 'Does the file have a header row?' },
    );

    const params: ExternalTableParams = {
        database,
        schema,
        tableName,
        filePath,
        columns,
        delimiter: delimiter || ',',
        skipRows: skipRows || '0',
        withHeader: hasHeader?.value === 'true',
    };

    try {
        const sql = generateBasicExternalTableSQL(params);
        const doc = await vscode.workspace.openTextDocument({
            content: sql,
            language: 'sql',
        });
        await vscode.window.showTextDocument(doc);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Invalid external table options: ${message}`);
    }
}

async function handleAdvancedExternalTable(
    database: string,
    schema: string,
    tableName: string,
    filePath: string,
    columns: string,
): Promise<void> {
    const advancedOptions = await vscode.window.showQuickPick(
        [
            {
                label: 'Continue with all options',
                description: 'Configure all advanced settings',
            },
            {
                label: 'Skip advanced options',
                description: 'Use default values for remaining options',
            },
        ],
        { placeHolder: 'Configure advanced options?' },
    );

    const params: ExternalTableParams = {
        database,
        schema,
        tableName,
        filePath,
        columns,
    };

    if (advancedOptions?.label === 'Continue with all options') {
        await collectAdvancedOptions(params);
    }

    try {
        const sql = generateAdvancedExternalTableSQL(params);
        const doc = await vscode.workspace.openTextDocument({
            content: sql,
            language: 'sql',
        });
        await vscode.window.showTextDocument(doc);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Invalid external table options: ${message}`);
    }
}

async function collectAdvancedOptions(params: ExternalTableParams): Promise<void> {
    const recordDelimiter = await vscode.window.showInputBox({
        prompt: 'Record (line) delimiter',
        placeHolder: '\\n (newline)',
        value: '\\n',
    });
    if (recordDelimiter !== undefined) params.recordDelimiter = recordDelimiter;

    const delimiter = await vscode.window.showInputBox({
        prompt: 'Field delimiter',
        placeHolder: ', (comma)',
        value: ',',
    });
    if (delimiter !== undefined) params.delimiter = delimiter;

    const nullValueAs = await vscode.window.showInputBox({
        prompt: 'Null value representation',
        placeHolder: 'NULL or empty string',
        value: 'NULL',
    });
    if (nullValueAs !== undefined) params.nullValueAs = nullValueAs;

    const dateStyle = await vscode.window.showQuickPick(
        [
            { label: 'MDY', description: 'Month-Day-Year' },
            { label: 'DMY', description: 'Day-Month-Year' },
            { label: 'YMD', description: 'Year-Month-Day' },
        ],
        { placeHolder: 'Date format style' },
    );
    if (dateStyle) params.dateStyle = dateStyle.label;

    const timeStyle = await vscode.window.showQuickPick(
        [
            { label: '24HR', description: '24-hour format (HH:MM:SS)' },
            { label: '12HR', description: '12-hour format (HH:MM:SS AM/PM)' },
        ],
        { placeHolder: 'Time format style' },
    );
    if (timeStyle) params.timeStyle = timeStyle.label;

    const skipRows = await vscode.window.showInputBox({
        prompt: 'Number of rows to skip',
        placeHolder: '0',
        value: '0',
    });
    if (skipRows !== undefined) params.skipRows = skipRows;

    const hasHeader = await vscode.window.showQuickPick(
        [
            {
                label: 'Yes',
                description: 'First row contains column names',
                value: 'true',
            },
            { label: 'No', description: 'No header row', value: 'false' },
        ],
        { placeHolder: 'Does the file have a header row?' },
    );
    if (hasHeader) params.withHeader = hasHeader.value === 'true';

    const quotedValue = await vscode.window.showQuickPick(
        [
            { label: 'YES', description: 'Handle quoted strings' },
            { label: 'NO', description: 'No special quoted value handling' },
        ],
        { placeHolder: 'Handle quoted values?' },
    );
    if (quotedValue) params.quotedValue = quotedValue.label;

    const batchSize = await vscode.window.showInputBox({
        prompt: 'Batch size for loading',
        placeHolder: 'Number of rows per batch',
    });
    if (batchSize !== undefined) params.batchSize = batchSize;

    const compression = await vscode.window.showQuickPick(
        [
            { label: 'AUTO', description: 'Auto-detect compression' },
            { label: 'GZIP', description: 'Gzip compression' },
            { label: 'BZIP2', description: 'Bzip2 compression' },
            { label: 'NONE', description: 'No compression' },
        ],
        { placeHolder: 'File compression type' },
    );
    if (compression) params.compression = compression.label;

    const format = await vscode.window.showQuickPick(
        [
            { label: 'TEXT', description: 'Text format' },
            { label: 'BCP', description: 'SQL Server BCP format' },
        ],
        { placeHolder: 'File format' },
    );
    if (format) params.format = format.label;

    const maxErrors = await vscode.window.showInputBox({
        prompt: 'Maximum number of errors allowed',
        placeHolder: '10',
        value: '10',
    });
    if (maxErrors !== undefined) params.maxErrors = maxErrors;

    const logFile = await vscode.window.showInputBox({
        prompt: 'Log file path (optional)',
        placeHolder: '/path/to/load.log',
    });
    if (logFile !== undefined) params.logFile = logFile;

    const recordSize = await vscode.window.showInputBox({
        prompt: 'Record size in bytes (for fixed width files)',
        placeHolder: 'e.g., 256',
    });
    if (recordSize !== undefined) params.recordSize = recordSize;

    const escapeChar = await vscode.window.showInputBox({
        prompt: 'Escape character',
        placeHolder: '\\\\',
    });
    if (escapeChar !== undefined) params.escapeChar = escapeChar;

    const quoting = await vscode.window.showQuickPick(
        [
            { label: 'MINIMAL', description: 'Only quote when necessary' },
            { label: 'ALL', description: 'Quote all values' },
            { label: 'NONNUMERIC', description: 'Quote all non-numeric values' },
        ],
        { placeHolder: 'Quoting mode' },
    );
    if (quoting) params.quoting = quoting.label;

    const noTruncate = await vscode.window.showQuickPick(
        [
            { label: 'No', description: 'Truncate table before load (default)' },
            { label: 'Yes', description: 'Do not truncate table' },
        ],
        { placeHolder: 'Truncate table before loading?' },
    );
    if (noTruncate && noTruncate.label === 'Yes') params.noTruncate = true;
}
