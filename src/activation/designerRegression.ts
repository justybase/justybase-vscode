import * as vscode from 'vscode';
import {
    buildTableDesignerCreateSql,
    getTableDesignerContainerDisplay,
    isTableDesignerSupported,
} from '@justybase/designer-core';
import type { ConnectionManager } from '../core/connectionManager';

interface TableDesignerRegressionOptions {
    connectionName?: string;
    dbName?: string;
    schemaName?: string;
}

interface TableDesignerRegressionReport {
    status: 'passed';
    scenarioId: 'extension-host-table-designer';
    commandRegistered: boolean;
    panelOpened: boolean;
    activeTabLabel: string;
    sqliteDdl: string;
    netezzaDdl: string;
    containerDisplay: string;
    clickhouseSupported: boolean;
    readOnlySupported: boolean;
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForTableDesignerTab(): Promise<vscode.Tab> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const tab = vscode.window.tabGroups.all
            .flatMap(group => group.tabs)
            .find(candidate => candidate.label.startsWith('Table Designer ('));
        if (tab) return tab;
        await sleep(50);
    }
    throw new Error('The Table Designer webview tab did not open in the Extension Host.');
}

function buildRegressionSql(): Pick<TableDesignerRegressionReport, 'sqliteDdl' | 'netezzaDdl'> {
    const sqliteDdl = buildTableDesignerCreateSql({
        databaseKind: 'sqlite',
        dbName: 'main',
        schemaName: 'main',
        tableName: 'extension_host_orders',
        tableType: 'PERMANENT',
        ifNotExists: true,
        columns: [
            { name: 'id', type: 'INTEGER', length: '', notNull: true, pk: true, defaultValue: '' },
            { name: 'status', type: 'TEXT', length: '', notNull: false, pk: false, defaultValue: 'ready' },
        ],
        distributeColumns: [],
        organizeNone: false,
        organizeColumns: [],
        tableConstraints: [],
    });
    const netezzaDdl = buildTableDesignerCreateSql({
        databaseKind: 'netezza',
        dbName: 'SYSTEM',
        schemaName: 'ADMIN',
        tableName: 'extension_host_orders',
        tableType: 'PERMANENT',
        ifNotExists: true,
        columns: [
            { name: 'id', type: 'INTEGER', length: '', notNull: true, pk: true, defaultValue: '' },
        ],
        distributeColumns: ['id'],
        organizeNone: false,
        organizeColumns: ['id'],
        tableConstraints: [],
    });
    return { sqliteDdl, netezzaDdl };
}

async function runTableDesignerRegression(
    connectionManager: ConnectionManager,
    options: TableDesignerRegressionOptions = {},
): Promise<TableDesignerRegressionReport> {
    if (process.env.NODE_ENV !== 'test') {
        throw new Error('The Table Designer Extension Host scenario is test-only.');
    }

    const connectionName = options.connectionName?.trim();
    if (!connectionName) throw new Error('The Table Designer Extension Host scenario needs a connection name.');
    const connection = await connectionManager.getConnection(connectionName);
    if (!connection) throw new Error(`The Extension Host fixture connection '${connectionName}' is missing.`);

    const dbName = options.dbName?.trim() || 'main';
    const schemaName = options.schemaName?.trim() || 'main';
    const commandRegistered = (await vscode.commands.getCommands(true)).includes('netezza.createTableDesigner');
    if (!commandRegistered) throw new Error('The production Table Designer command is not registered.');

    await vscode.commands.executeCommand('netezza.createTableDesigner', {
        dbName,
        schema: schemaName,
        connectionName,
        label: 'Tables',
    });
    const tab = await waitForTableDesignerTab();
    const { sqliteDdl, netezzaDdl } = buildRegressionSql();

    return {
        status: 'passed',
        scenarioId: 'extension-host-table-designer',
        commandRegistered,
        panelOpened: true,
        activeTabLabel: tab.label,
        sqliteDdl,
        netezzaDdl,
        containerDisplay: getTableDesignerContainerDisplay('sqlite', dbName, schemaName),
        clickhouseSupported: isTableDesignerSupported('clickhouse'),
        readOnlySupported: isTableDesignerSupported('sqlite', { readOnly: true, runtimeAvailable: true }),
    };
}

/**
 * Register the real desktop Table Designer regression command only for the
 * Extension Host gate. It exercises the production command and the bundled
 * platform-neutral DDL implementation without contributing a user command.
 */
export function registerDesignerRegressionCommand(
    connectionManager: ConnectionManager,
): vscode.Disposable | undefined {
    if (process.env.NODE_ENV !== 'test') return undefined;
    return vscode.commands.registerCommand(
        'justybase.test.tableDesignerScenario',
        (options?: TableDesignerRegressionOptions) => runTableDesignerRegression(connectionManager, options),
    );
}
