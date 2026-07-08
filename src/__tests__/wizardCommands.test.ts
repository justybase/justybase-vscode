/**
 * Unit tests for commands/wizardCommands.ts
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import { registerWizardCommands } from '../commands/wizardCommands';
import { getTemplatesByCategory, getTemplateById } from '../providers/procedureTemplates';
import { generateBasicExternalTableSQL, generateAdvancedExternalTableSQL } from '../providers/externalTableTemplates';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';

jest.mock('vscode', () => ({
    commands: {
        registerCommand: jest.fn(),
        executeCommand: jest.fn(),
    },
    window: {
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showQuickPick: jest.fn(),
        showInputBox: jest.fn(),
        showTextDocument: jest.fn(),
        withProgress: jest.fn(async (_options: unknown, task: () => Promise<unknown>) => task()),
    },
    ProgressLocation: {
        Notification: 15,
    },
    workspace: {
        openTextDocument: jest.fn(),
    },
}));

jest.mock('../providers/procedureTemplates', () => ({
    getTemplatesByCategory: jest.fn(),
    getTemplateById: jest.fn(),
}));

jest.mock('../providers/externalTableTemplates', () => ({
    generateBasicExternalTableSQL: jest.fn(),
    generateAdvancedExternalTableSQL: jest.fn(),
}));

jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn(),
}));

describe('commands/wizardCommands', () => {
    let registeredHandlers: Map<string, (...args: unknown[]) => Promise<void>>;
    let mockConnectionManager: {
        getConnectionForExecution: jest.Mock;
        getActiveConnectionName: jest.Mock;
        resolveConnectionName: jest.Mock;
        supportsCapability: jest.Mock;
        getConnectionDatabaseKind: jest.Mock;
    };

    const mockedRegisterCommand = vscode.commands.registerCommand as jest.Mock;
    const mockedExecuteCommand = vscode.commands.executeCommand as jest.Mock;
    const mockedShowErrorMessage = vscode.window.showErrorMessage as jest.Mock;
    const mockedShowInformationMessage = vscode.window.showInformationMessage as jest.Mock;
    const mockedShowQuickPick = vscode.window.showQuickPick as jest.Mock;
    const mockedShowInputBox = vscode.window.showInputBox as jest.Mock;
    const mockedShowTextDocument = vscode.window.showTextDocument as jest.Mock;
    const mockedWithProgress = vscode.window.withProgress as jest.Mock;
    const mockedOpenTextDocument = vscode.workspace.openTextDocument as jest.Mock;
    const mockedGetTemplatesByCategory = getTemplatesByCategory as jest.Mock;
    const mockedGetTemplateById = getTemplateById as jest.Mock;
    const mockedGenerateBasicExternalTableSQL = generateBasicExternalTableSQL as jest.Mock;
    const mockedGenerateAdvancedExternalTableSQL = generateAdvancedExternalTableSQL as jest.Mock;
    const mockedRunQueryRaw = runQueryRaw as jest.Mock;
    const mockedQueryResultToRows = queryResultToRows as jest.Mock;

    const getHandler = (commandName: string): ((...args: unknown[]) => Promise<void>) => {
        registerWizardCommands({
            context: {} as vscode.ExtensionContext,
            connectionManager: mockConnectionManager as unknown as ConnectionManager,
        });
        const handler = registeredHandlers.get(commandName);
        expect(handler).toBeDefined();
        return handler as (...args: unknown[]) => Promise<void>;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        registeredHandlers = new Map<string, (...args: unknown[]) => Promise<void>>();

        mockedRegisterCommand.mockImplementation((command: string, handler: (...args: unknown[]) => Promise<void>) => {
            registeredHandlers.set(command, handler);
            return { dispose: jest.fn() };
        });

        mockConnectionManager = {
            getConnectionForExecution: jest.fn().mockReturnValue(undefined),
            getActiveConnectionName: jest.fn().mockReturnValue('CONN_MAIN'),
            resolveConnectionName: jest.fn(
                (_documentUri?: string, connectionName?: string) => connectionName || 'CONN_MAIN',
            ),
            supportsCapability: jest.fn().mockReturnValue(true),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
        };

        mockedOpenTextDocument.mockResolvedValue({ uri: 'mock-doc' });
        mockedShowTextDocument.mockResolvedValue(undefined);
        mockedShowInformationMessage.mockResolvedValue(undefined);
        mockedExecuteCommand.mockResolvedValue(undefined);
        mockedWithProgress.mockImplementation(async (_options: unknown, task: () => Promise<unknown>) => task());
        mockedGetTemplatesByCategory.mockReturnValue({
            basic: [{ id: 'basic-1', name: 'Basic Tpl', description: 'Basic template' }],
            advanced: [{ id: 'adv-1', name: 'Advanced Tpl', description: 'Advanced template' }],
        });
        mockedGetTemplateById.mockReturnValue({
            template: jest.fn((name: string, db: string, schema: string) => `PROC ${db}.${schema}.${name}`),
        });
        mockedGenerateBasicExternalTableSQL.mockReturnValue('BASIC_SQL');
        mockedGenerateAdvancedExternalTableSQL.mockReturnValue('ADV_SQL');
        mockedRunQueryRaw.mockResolvedValue(undefined);
        mockedQueryResultToRows.mockReturnValue([]);
    });

    it('registers wizard commands', () => {
        const disposables = registerWizardCommands({
            context: {} as vscode.ExtensionContext,
            connectionManager: mockConnectionManager as unknown as ConnectionManager,
        });

        expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.createProcedure', expect.any(Function));
        expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.createSequence', expect.any(Function));
        expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.createSnowflakeStream', expect.any(Function));
        expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.createSnowflakeTask', expect.any(Function));
        expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.createSnowflakeDynamicTable', expect.any(Function));
        expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.manageSnowflakeDynamicTable', expect.any(Function));
        expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.createView', expect.any(Function));
        expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.createExternalTable', expect.any(Function));
        expect(disposables).toHaveLength(8);
    });

    describe('netezza.createProcedure', () => {
        it('blocks procedure wizard when the dialect does not support procedures', async () => {
            mockConnectionManager.supportsCapability.mockReturnValue(false);
            const handler = getHandler('netezza.createProcedure');

            await handler({ dbName: 'DB1', connectionName: 'CONN_MAIN' });

            expect(mockedShowErrorMessage).toHaveBeenCalledWith(
                'Procedures are not supported for the active database dialect.',
            );
            expect(mockedOpenTextDocument).not.toHaveBeenCalled();
        });

        it('shows error when folder selection is invalid', async () => {
            const handler = getHandler('netezza.createProcedure');
            await handler(undefined);
            expect(mockedShowErrorMessage).toHaveBeenCalledWith('Invalid selection. Select a Procedure folder.');
        });

        it('returns when category is cancelled', async () => {
            mockedShowQuickPick.mockResolvedValueOnce(undefined);
            const handler = getHandler('netezza.createProcedure');
            await handler({ dbName: 'DB1' });

            expect(mockedGetTemplatesByCategory).not.toHaveBeenCalled();
            expect(mockedOpenTextDocument).not.toHaveBeenCalled();
        });

        it('returns when template selection is cancelled', async () => {
            mockedShowQuickPick.mockResolvedValueOnce({ category: 'basic' }).mockResolvedValueOnce(undefined);

            const handler = getHandler('netezza.createProcedure');
            await handler({ dbName: 'DB1' });

            expect(mockedShowInputBox).not.toHaveBeenCalled();
            expect(mockedOpenTextDocument).not.toHaveBeenCalled();
        });

        it('returns when procedure name input is cancelled', async () => {
            mockedShowQuickPick
                .mockResolvedValueOnce({ category: 'basic' })
                .mockResolvedValueOnce({ templateId: 'basic-1' });
            mockedShowInputBox.mockResolvedValueOnce(undefined);

            const handler = getHandler('netezza.createProcedure');
            await handler({ dbName: 'DB1' });

            expect(mockedGetTemplateById).not.toHaveBeenCalled();
            expect(mockedOpenTextDocument).not.toHaveBeenCalled();
        });

        it('shows error when template cannot be resolved', async () => {
            mockedShowQuickPick
                .mockResolvedValueOnce({ category: 'basic' })
                .mockResolvedValueOnce({ templateId: 'missing-template' });
            mockedShowInputBox.mockResolvedValueOnce('MY_PROC');
            mockedGetTemplateById.mockReturnValue(undefined);

            const handler = getHandler('netezza.createProcedure');
            await handler({ dbName: 'DB1' });

            expect(mockedShowErrorMessage).toHaveBeenCalledWith('Template not found');
            expect(mockedOpenTextDocument).not.toHaveBeenCalled();
        });

        it('uses fallback name when procedure input is blank', async () => {
            const templateFn = jest.fn(() => 'PROC SQL');
            mockedGetTemplateById.mockReturnValue({ template: templateFn });
            mockedShowQuickPick
                .mockResolvedValueOnce({ category: 'basic' })
                .mockResolvedValueOnce({ templateId: 'basic-1' });
            mockedShowInputBox.mockResolvedValueOnce('   ');

            const handler = getHandler('netezza.createProcedure');
            await handler({ dbName: 'DB1' });

            expect(templateFn).toHaveBeenCalledWith('NEW_PROCEDURE', 'DB1', 'ADMIN');
            expect(mockedOpenTextDocument).toHaveBeenCalledWith({ content: 'PROC SQL', language: 'sql' });
            expect(mockedShowTextDocument).toHaveBeenCalled();
        });

        it('handles advanced category template flow', async () => {
            const templateFn = jest.fn(() => 'ADV PROC SQL');
            mockedGetTemplateById.mockReturnValue({ template: templateFn });
            mockConnectionManager.getConnectionForExecution.mockReturnValue('CONN_MAIN');
            mockedRunQueryRaw.mockResolvedValue({ columns: [{ name: 'DEFSCHEMA' }], data: [['PUBLIC']] });
            mockedQueryResultToRows.mockReturnValue([{ DEFSCHEMA: 'PUBLIC' }]);
            mockedShowQuickPick
                .mockResolvedValueOnce({ category: 'advanced' })
                .mockResolvedValueOnce({ templateId: 'adv-1' });
            mockedShowInputBox.mockResolvedValueOnce('PROC_ADV');

            const handler = getHandler('netezza.createProcedure');
            await handler({ dbName: 'DB_MAIN' });

            expect(mockedGetTemplatesByCategory).toHaveBeenCalled();
            expect(templateFn).toHaveBeenCalledWith('PROC_ADV', 'DB_MAIN', 'PUBLIC');
            expect(mockedOpenTextDocument).toHaveBeenCalledWith({ content: 'ADV PROC SQL', language: 'sql' });
        });

        it('uses schema from tree item and skips default schema query', async () => {
            const templateFn = jest.fn(() => 'PROC SQL');
            mockedGetTemplateById.mockReturnValue({ template: templateFn });
            mockedShowQuickPick
                .mockResolvedValueOnce({ category: 'basic' })
                .mockResolvedValueOnce({ templateId: 'basic-1' });
            mockedShowInputBox.mockResolvedValueOnce('PROC_FROM_ITEM');

            const handler = getHandler('netezza.createProcedure');
            await handler({ dbName: 'DB1', schema: 'analytics' });

            expect(templateFn).toHaveBeenCalledWith('PROC_FROM_ITEM', 'DB1', 'ANALYTICS');
            expect(mockedRunQueryRaw).not.toHaveBeenCalled();
        });
    });

    describe('netezza.createView', () => {
        it('shows error when folder selection is invalid', async () => {
            const handler = getHandler('netezza.createView');
            await handler(undefined);
            expect(mockedShowErrorMessage).toHaveBeenCalledWith('Invalid selection. Select a View folder.');
        });

        it('creates CREATE OR REPLACE VIEW draft with optional aliases', async () => {
            mockedShowInputBox
                .mockResolvedValueOnce('active_customers')
                .mockResolvedValueOnce('cust_id, cust_name')
                .mockResolvedValueOnce('select customer_id, customer_name from sales.admin.customers');

            const handler = getHandler('netezza.createView');
            await handler({ dbName: 'sales', schema: 'reporting' });

            expect(mockedOpenTextDocument).toHaveBeenCalledWith({
                content:
                    'CREATE OR REPLACE VIEW SALES.REPORTING.ACTIVE_CUSTOMERS (CUST_ID, CUST_NAME) AS\n' +
                    'select customer_id, customer_name from sales.admin.customers;',
                language: 'sql',
            });
            expect(mockedShowTextDocument).toHaveBeenCalled();
        });
    });

    describe('Snowflake-specific wizards', () => {
        beforeEach(() => {
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('snowflake');
        });

        it('creates a Snowflake stream draft', async () => {
            mockedShowInputBox.mockResolvedValueOnce('orders_stream').mockResolvedValueOnce('orders');
            mockedShowQuickPick
                .mockResolvedValueOnce({ sourceType: 'TABLE' })
                .mockResolvedValueOnce({ appendOnly: true });

            const handler = getHandler('netezza.createSnowflakeStream');
            await handler({ dbName: 'ANALYTICS', schema: 'PUBLIC', connectionName: 'CONN_MAIN' });

            expect(mockedOpenTextDocument).toHaveBeenCalledWith({
                content:
                    'CREATE OR REPLACE STREAM ANALYTICS.PUBLIC.ORDERS_STREAM\n' +
                    '    ON TABLE ANALYTICS.PUBLIC.ORDERS\n' +
                    '    APPEND_ONLY = TRUE;',
                language: 'sql',
            });
        });

        it('creates a Snowflake task draft', async () => {
            mockedShowInputBox
                .mockResolvedValueOnce('hourly_task')
                .mockResolvedValueOnce('TRANSFORMING_WH')
                .mockResolvedValueOnce('USING CRON 0 * * * * UTC')
                .mockResolvedValueOnce('CALL PROCESS_ORDERS()');

            const handler = getHandler('netezza.createSnowflakeTask');
            await handler({ dbName: 'ANALYTICS', schema: 'PUBLIC', connectionName: 'CONN_MAIN' });

            expect(mockedOpenTextDocument).toHaveBeenCalledWith({
                content:
                    'CREATE OR REPLACE TASK ANALYTICS.PUBLIC.HOURLY_TASK\n' +
                    '    WAREHOUSE = TRANSFORMING_WH\n' +
                    "    SCHEDULE = 'USING CRON 0 * * * * UTC'\n" +
                    'AS\n' +
                    'CALL PROCESS_ORDERS();',
                language: 'sql',
            });
        });

        it('creates a Snowflake dynamic table draft', async () => {
            mockedShowInputBox
                .mockResolvedValueOnce('orders_dynamic')
                .mockResolvedValueOnce('5 MINUTES')
                .mockResolvedValueOnce('TRANSFORMING_WH')
                .mockResolvedValueOnce('SELECT * FROM ANALYTICS.PUBLIC.ORDERS');
            mockedShowQuickPick
                .mockResolvedValueOnce({ refreshMode: 'AUTO' })
                .mockResolvedValueOnce({ initializeMode: 'ON_CREATE' });

            const handler = getHandler('netezza.createSnowflakeDynamicTable');
            await handler({ dbName: 'ANALYTICS', schema: 'PUBLIC', connectionName: 'CONN_MAIN' });

            expect(mockedOpenTextDocument).toHaveBeenCalledWith({
                content:
                    'CREATE OR REPLACE DYNAMIC TABLE ANALYTICS.PUBLIC.ORDERS_DYNAMIC\n' +
                    "    TARGET_LAG = '5 MINUTES'\n" +
                    '    WAREHOUSE = TRANSFORMING_WH\n' +
                    '    REFRESH_MODE = AUTO\n' +
                    '    INITIALIZE = ON_CREATE\n' +
                    'AS\n' +
                    'SELECT * FROM ANALYTICS.PUBLIC.ORDERS;',
                language: 'sql',
            });
        });

        it('opens a refresh status query for a Snowflake dynamic table', async () => {
            mockedShowQuickPick.mockResolvedValueOnce({ action: 'status' });

            const handler = getHandler('netezza.manageSnowflakeDynamicTable');
            await handler({
                dbName: 'ANALYTICS',
                schema: 'PUBLIC',
                connectionName: 'CONN_MAIN',
                label: 'ORDERS_DYNAMIC',
            });

            expect(mockedOpenTextDocument).toHaveBeenCalledWith({
                content:
                    "SHOW DYNAMIC TABLES LIKE 'ORDERS_DYNAMIC' IN SCHEMA ANALYTICS.PUBLIC\n" +
                    '->> SELECT\n' +
                    '        "name" AS "NAME",\n' +
                    '        "database_name" AS "DATABASE",\n' +
                    '        "schema_name" AS "SCHEMA",\n' +
                    '        "owner" AS "OWNER",\n' +
                    '        "scheduling_state" AS "STATE",\n' +
                    '        "scheduler" AS "SCHEDULER",\n' +
                    '        "target_lag" AS "TARGET_LAG",\n' +
                    '        "warehouse" AS "WAREHOUSE",\n' +
                    '        "refresh_mode" AS "REFRESH_MODE",\n' +
                    '        "refresh_mode_reason" AS "REFRESH_MODE_REASON",\n' +
                    '        "last_suspended_on" AS "LAST_SUSPENDED_ON",\n' +
                    '        "data_timestamp" AS "DATA_TIMESTAMP",\n' +
                    '        COALESCE("comment", \'\') AS "COMMENT"\n' +
                    '    FROM $1;\n' +
                    '\n' +
                    'DESCRIBE DYNAMIC TABLE ANALYTICS.PUBLIC.ORDERS_DYNAMIC;',
                language: 'sql',
            });
        });

        it('executes an ALTER DYNAMIC TABLE property update', async () => {
            mockedShowQuickPick.mockResolvedValueOnce({ action: 'update' });
            mockedShowInputBox
                .mockResolvedValueOnce('10 MINUTES')
                .mockResolvedValueOnce('TRANSFORMING_WH');

            const handler = getHandler('netezza.manageSnowflakeDynamicTable');
            await handler({
                dbName: 'ANALYTICS',
                schema: 'PUBLIC',
                connectionName: 'CONN_MAIN',
                label: 'ORDERS_DYNAMIC',
            });

            expect(mockedWithProgress).toHaveBeenCalledTimes(1);
            expect(mockedRunQueryRaw).toHaveBeenCalledWith(
                {},
                'ALTER DYNAMIC TABLE ANALYTICS.PUBLIC.ORDERS_DYNAMIC SET\n    TARGET_LAG = \'10 MINUTES\',\n    WAREHOUSE = TRANSFORMING_WH;',
                true,
                mockConnectionManager,
                'CONN_MAIN',
                undefined,
                undefined,
                undefined,
                undefined,
                false,
            );
            expect(mockedShowInformationMessage).toHaveBeenCalledWith(
                'Dynamic table updated: ANALYTICS.PUBLIC.ORDERS_DYNAMIC',
            );
            expect(mockedExecuteCommand).toHaveBeenCalledWith('netezza.refreshSchema');
            expect(mockedOpenTextDocument).not.toHaveBeenCalled();
        });

        it.each([
            ['refresh', 'ALTER DYNAMIC TABLE ANALYTICS.PUBLIC.ORDERS_DYNAMIC REFRESH;', 'Dynamic table refreshed: ANALYTICS.PUBLIC.ORDERS_DYNAMIC'],
            ['suspend', 'ALTER DYNAMIC TABLE ANALYTICS.PUBLIC.ORDERS_DYNAMIC SUSPEND;', 'Dynamic table suspended: ANALYTICS.PUBLIC.ORDERS_DYNAMIC'],
            ['resume', 'ALTER DYNAMIC TABLE ANALYTICS.PUBLIC.ORDERS_DYNAMIC RESUME;', 'Dynamic table resumed: ANALYTICS.PUBLIC.ORDERS_DYNAMIC'],
        ])('executes %s for a Snowflake dynamic table', async (action, expectedSql, successMessage) => {
            mockedShowQuickPick.mockResolvedValueOnce({ action });

            const handler = getHandler('netezza.manageSnowflakeDynamicTable');
            await handler({
                dbName: 'ANALYTICS',
                schema: 'PUBLIC',
                connectionName: 'CONN_MAIN',
                label: 'ORDERS_DYNAMIC',
            });

            expect(mockedRunQueryRaw).toHaveBeenCalledWith(
                {},
                expectedSql,
                true,
                mockConnectionManager,
                'CONN_MAIN',
                undefined,
                undefined,
                undefined,
                undefined,
                false,
            );
            expect(mockedShowInformationMessage).toHaveBeenCalledWith(successMessage);
            expect(mockedOpenTextDocument).not.toHaveBeenCalled();
        });

        it('uses unquoted DOWNSTREAM target lag in the Snowflake dynamic table draft', async () => {
            mockedShowInputBox
                .mockResolvedValueOnce('orders_dynamic')
                .mockResolvedValueOnce('DOWNSTREAM')
                .mockResolvedValueOnce('TRANSFORMING_WH')
                .mockResolvedValueOnce('SELECT * FROM ANALYTICS.PUBLIC.ORDERS');
            mockedShowQuickPick
                .mockResolvedValueOnce({ refreshMode: 'AUTO' })
                .mockResolvedValueOnce({ initializeMode: 'ON_CREATE' });

            const handler = getHandler('netezza.createSnowflakeDynamicTable');
            await handler({ dbName: 'ANALYTICS', schema: 'PUBLIC', connectionName: 'CONN_MAIN' });

            expect(mockedOpenTextDocument).toHaveBeenCalledWith({
                content:
                    'CREATE OR REPLACE DYNAMIC TABLE ANALYTICS.PUBLIC.ORDERS_DYNAMIC\n' +
                    '    TARGET_LAG = DOWNSTREAM\n' +
                    '    WAREHOUSE = TRANSFORMING_WH\n' +
                    '    REFRESH_MODE = AUTO\n' +
                    '    INITIALIZE = ON_CREATE\n' +
                    'AS\n' +
                    'SELECT * FROM ANALYTICS.PUBLIC.ORDERS;',
                language: 'sql',
            });
        });
    });

    describe('netezza.createExternalTable', () => {
        it('shows error when folder selection is invalid', async () => {
            const handler = getHandler('netezza.createExternalTable');
            await handler(undefined);
            expect(mockedShowErrorMessage).toHaveBeenCalledWith('Invalid selection. Select an External Table folder.');
        });

        it('blocks external table wizard when the dialect does not support it', async () => {
            mockConnectionManager.supportsCapability.mockReturnValue(false);
            const handler = getHandler('netezza.createExternalTable');

            await handler({ dbName: 'DB1', connectionName: 'CONN_MAIN' });

            expect(mockedShowErrorMessage).toHaveBeenCalledWith(
                'External tables are not supported for the active database dialect.',
            );
            expect(mockedShowQuickPick).not.toHaveBeenCalled();
        });

        it('returns when mode selection is cancelled', async () => {
            mockedShowQuickPick.mockResolvedValueOnce(undefined);
            const handler = getHandler('netezza.createExternalTable');
            await handler({ dbName: 'DB1' });
            expect(mockedShowInputBox).not.toHaveBeenCalled();
        });

        it('returns when table name input is cancelled', async () => {
            mockedShowQuickPick.mockResolvedValueOnce({ mode: 'basic' });
            mockedShowInputBox.mockResolvedValueOnce(undefined);
            const handler = getHandler('netezza.createExternalTable');
            await handler({ dbName: 'DB1' });
            expect(mockedGenerateBasicExternalTableSQL).not.toHaveBeenCalled();
        });

        it('returns when file path input is cancelled', async () => {
            mockedShowQuickPick.mockResolvedValueOnce({ mode: 'basic' });
            mockedShowInputBox.mockResolvedValueOnce('TABLE_1').mockResolvedValueOnce(undefined);

            const handler = getHandler('netezza.createExternalTable');
            await handler({ dbName: 'DB1' });

            expect(mockedGenerateBasicExternalTableSQL).not.toHaveBeenCalled();
        });

        it('returns when columns input is cancelled', async () => {
            mockedShowQuickPick.mockResolvedValueOnce({ mode: 'basic' });
            mockedShowInputBox
                .mockResolvedValueOnce('TABLE_1')
                .mockResolvedValueOnce('/tmp/file.csv')
                .mockResolvedValueOnce(undefined);

            const handler = getHandler('netezza.createExternalTable');
            await handler({ dbName: 'DB1' });

            expect(mockedGenerateBasicExternalTableSQL).not.toHaveBeenCalled();
        });

        it('validates table/file/columns input fields', async () => {
            mockedShowQuickPick.mockResolvedValueOnce({ mode: 'basic' });
            mockedShowInputBox.mockResolvedValueOnce(undefined);

            const handler = getHandler('netezza.createExternalTable');
            await handler({ dbName: 'DB1' });

            const tableValidation = mockedShowInputBox.mock.calls[0][0].validateInput as (
                value: string,
            ) => string | null;
            expect(tableValidation('')).toBe('Table name cannot be empty');
            expect(tableValidation('123abc')).toBe('Invalid table name. Use only letters, numbers, and underscores.');
            expect(tableValidation('valid_table_1')).toBeNull();

            mockedShowQuickPick.mockResolvedValueOnce({ mode: 'basic' });
            mockedShowInputBox.mockResolvedValueOnce('VALID_TABLE').mockResolvedValueOnce(undefined);
            await handler({ dbName: 'DB1' });
            const fileValidation = mockedShowInputBox.mock.calls[2][0].validateInput as (
                value: string,
            ) => string | null;
            expect(fileValidation('')).toBe('File path cannot be empty');
            expect(fileValidation('/tmp/file.csv')).toBeNull();

            mockedShowQuickPick.mockResolvedValueOnce({ mode: 'basic' });
            mockedShowInputBox
                .mockResolvedValueOnce('VALID_TABLE')
                .mockResolvedValueOnce('/tmp/file.csv')
                .mockResolvedValueOnce(undefined);
            await handler({ dbName: 'DB1' });
            const columnsValidation = mockedShowInputBox.mock.calls[5][0].validateInput as (
                value: string,
            ) => string | null;
            expect(columnsValidation('')).toBe('Column definitions cannot be empty');
            expect(columnsValidation('C1 INTEGER')).toBeNull();
        });

        it('builds basic SQL using default schema and fallback options', async () => {
            mockedShowQuickPick.mockResolvedValueOnce({ mode: 'basic' }).mockResolvedValueOnce(undefined);
            mockedShowInputBox
                .mockResolvedValueOnce('my_table')
                .mockResolvedValueOnce('/tmp/input.csv')
                .mockResolvedValueOnce('C1 INTEGER')
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined);

            const handler = getHandler('netezza.createExternalTable');
            await handler({ dbName: 'DB1' });

            expect(mockedGenerateBasicExternalTableSQL).toHaveBeenCalledWith({
                database: 'DB1',
                schema: 'ADMIN',
                tableName: 'MY_TABLE',
                filePath: '/tmp/input.csv',
                columns: 'C1 INTEGER',
                delimiter: ',',
                skipRows: '0',
                withHeader: false,
            });
            expect(mockedOpenTextDocument).toHaveBeenCalledWith({ content: 'BASIC_SQL', language: 'sql' });
        });

        it('builds basic SQL with explicit schema and header enabled', async () => {
            mockedShowQuickPick.mockResolvedValueOnce({ mode: 'basic' }).mockResolvedValueOnce({ value: 'true' });
            mockedShowInputBox
                .mockResolvedValueOnce('sales_ext')
                .mockResolvedValueOnce('s3://bucket/sales.csv')
                .mockResolvedValueOnce('ID INTEGER')
                .mockResolvedValueOnce('|')
                .mockResolvedValueOnce('2');

            const handler = getHandler('netezza.createExternalTable');
            await handler({ dbName: 'DB2', schema: 'PUBLIC' });

            expect(mockedGenerateBasicExternalTableSQL).toHaveBeenCalledWith({
                database: 'DB2',
                schema: 'PUBLIC',
                tableName: 'SALES_EXT',
                filePath: 's3://bucket/sales.csv',
                columns: 'ID INTEGER',
                delimiter: '|',
                skipRows: '2',
                withHeader: true,
            });
        });

        it('builds advanced SQL when advanced options are skipped', async () => {
            mockedShowQuickPick
                .mockResolvedValueOnce({ mode: 'advanced' })
                .mockResolvedValueOnce({ label: 'Skip advanced options' });
            mockedShowInputBox
                .mockResolvedValueOnce('ext_adv')
                .mockResolvedValueOnce('/tmp/adv.csv')
                .mockResolvedValueOnce('C1 INTEGER');

            const handler = getHandler('netezza.createExternalTable');
            await handler({ dbName: 'DB3', schema: 'FIN' });

            expect(mockedGenerateAdvancedExternalTableSQL).toHaveBeenCalledWith({
                database: 'DB3',
                schema: 'FIN',
                tableName: 'EXT_ADV',
                filePath: '/tmp/adv.csv',
                columns: 'C1 INTEGER',
            });
        });

        it('collects and applies all advanced options', async () => {
            mockedShowQuickPick
                .mockResolvedValueOnce({ mode: 'advanced' })
                .mockResolvedValueOnce({ label: 'Continue with all options' })
                .mockResolvedValueOnce({ label: 'YMD' })
                .mockResolvedValueOnce({ label: '24HR' })
                .mockResolvedValueOnce({ value: 'true' })
                .mockResolvedValueOnce({ label: 'YES' })
                .mockResolvedValueOnce({ label: 'GZIP' })
                .mockResolvedValueOnce({ label: 'TEXT' })
                .mockResolvedValueOnce({ label: 'ALL' })
                .mockResolvedValueOnce({ label: 'Yes' });

            mockedShowInputBox
                .mockResolvedValueOnce('ext_full')
                .mockResolvedValueOnce('/tmp/full.csv')
                .mockResolvedValueOnce('C1 INTEGER, C2 VARCHAR(10)')
                .mockResolvedValueOnce('\\n')
                .mockResolvedValueOnce(';')
                .mockResolvedValueOnce('NULLX')
                .mockResolvedValueOnce('5')
                .mockResolvedValueOnce('1000')
                .mockResolvedValueOnce('7')
                .mockResolvedValueOnce('/tmp/load.log')
                .mockResolvedValueOnce('256')
                .mockResolvedValueOnce('\\');

            const handler = getHandler('netezza.createExternalTable');
            await handler({ dbName: 'DB4', schema: 'ADMIN' });

            expect(mockedGenerateAdvancedExternalTableSQL).toHaveBeenCalledWith({
                database: 'DB4',
                schema: 'ADMIN',
                tableName: 'EXT_FULL',
                filePath: '/tmp/full.csv',
                columns: 'C1 INTEGER, C2 VARCHAR(10)',
                recordDelimiter: '\\n',
                delimiter: ';',
                nullValueAs: 'NULLX',
                dateStyle: 'YMD',
                timeStyle: '24HR',
                skipRows: '5',
                withHeader: true,
                quotedValue: 'YES',
                batchSize: '1000',
                compression: 'GZIP',
                format: 'TEXT',
                maxErrors: '7',
                logFile: '/tmp/load.log',
                recordSize: '256',
                escapeChar: '\\',
                quoting: 'ALL',
                noTruncate: true,
            });
        });

        it('ignores undefined advanced options values', async () => {
            mockedShowQuickPick
                .mockResolvedValueOnce({ mode: 'advanced' })
                .mockResolvedValueOnce({ label: 'Continue with all options' })
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce({ label: 'No' });

            mockedShowInputBox
                .mockResolvedValueOnce('ext_sparse')
                .mockResolvedValueOnce('/tmp/sparse.csv')
                .mockResolvedValueOnce('C1 INTEGER')
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined);

            const handler = getHandler('netezza.createExternalTable');
            await handler({ dbName: 'DB5', schema: 'PUBLIC' });

            expect(mockedGenerateAdvancedExternalTableSQL).toHaveBeenCalledWith({
                database: 'DB5',
                schema: 'PUBLIC',
                tableName: 'EXT_SPARSE',
                filePath: '/tmp/sparse.csv',
                columns: 'C1 INTEGER',
            });
        });
    });
});
