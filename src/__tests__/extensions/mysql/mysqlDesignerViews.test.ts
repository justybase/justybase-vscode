import * as vscode from 'vscode';
import { MysqlIndexDesignerView } from '../../../../extensions/mysql/src/mysqlIndexDesignerView';
import { MysqlPartitionDesignerView } from '../../../../extensions/mysql/src/mysqlPartitionDesignerView';
import type { MysqlIndexDesign } from '../../../contracts/webviews/mysqlIndexDesignerContracts';
import type { MysqlPartitionOperationRequest } from '../../../contracts/webviews/mysqlPartitionDesignerContracts';

interface TestPanel {
    webview: {
        html: string;
        onDidReceiveMessage: jest.Mock;
        postMessage: jest.Mock;
    };
}

function createPanel(): TestPanel {
    const WebviewPanel = (vscode as unknown as {
        WebviewPanel: new () => TestPanel;
    }).WebviewPanel;
    const panel = new WebviewPanel();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    return panel;
}

function configureCoreExtension(): void {
    (vscode.extensions.getExtension as jest.Mock).mockReturnValue({
        extensionUri: vscode.Uri.file('/core-extension'),
    });
}

function getMessageHandler(panel: TestPanel): (message: unknown) => Promise<void> {
    const handler = (panel.webview.onDidReceiveMessage as jest.Mock).mock.calls[0]?.[0];
    if (typeof handler !== 'function') {
        throw new Error('The webview message handler was not registered.');
    }
    return handler as (message: unknown) => Promise<void>;
}

function createServices(partitions: Array<Record<string, unknown>> = []): {
    executeQuery: jest.Mock;
} {
    return {
        executeQuery: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('information_schema.tables')) {
                return Promise.resolve([{ ENGINE: 'InnoDB', SERVER_VERSION: '8.0.36' }]);
            }
            if (sql.includes('information_schema.columns')) {
                return Promise.resolve([
                    { ATTNAME: 'id', FORMAT_TYPE: 'bigint', IS_NOT_NULL: 1, IS_PK: 1, ATTNUM: 1 },
                    { ATTNAME: 'created_at', FORMAT_TYPE: 'datetime', IS_NOT_NULL: 1, IS_PK: 0, ATTNUM: 2 },
                ]);
            }
            if (sql.includes('information_schema.statistics')) {
                return Promise.resolve([{
                    INDEX_NAME: 'PRIMARY',
                    SEQ_IN_INDEX: 1,
                    COLUMN_NAME: 'id',
                    COLLATION: 'A',
                    NON_UNIQUE: 0,
                    INDEX_TYPE: 'BTREE',
                    IS_VISIBLE: 'YES',
                }]);
            }
            if (sql.includes('information_schema.partitions')) {
                return Promise.resolve(partitions);
            }
            return Promise.resolve([]);
        }),
    };
}

function createTarget(): {
    connectionName: string;
    databaseName: string;
    schemaName: string;
    tableName: string;
    qualifiedName: string;
} {
    return {
        connectionName: 'mysql-connection',
        databaseName: 'sales',
        schemaName: 'sales',
        tableName: 'orders',
        qualifiedName: 'sales.orders',
    };
}

describe('MySQL designer webview hosts', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        configureCoreExtension();
    });

    it('renders the MySQL index designer and host-validates index DDL', async () => {
        const panel = createPanel();
        const services = createServices();

        await MysqlIndexDesignerView.createOrShow({} as vscode.ExtensionContext, {
            target: createTarget(),
            services,
        } as never);

        expect(panel.webview.html).toContain('mysqlIndexDesigner.js');
        expect(panel.webview.html).toContain('Existing indexes');

        const design: MysqlIndexDesign = {
            indexName: 'orders_created_idx',
            keyColumns: [{ name: 'created_at', order: 'DESC' }],
            unique: false,
        };
        await getMessageHandler(panel)({ command: 'copyDDL', design });

        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
            'CREATE INDEX orders_created_idx ON sales.orders (created_at DESC);',
        );

        await getMessageHandler(panel)({ command: 'dropIndex', indexName: 'PRIMARY' });
        expect(panel.webview.postMessage).toHaveBeenCalledWith({
            command: 'setError',
            text: expect.stringContaining('PRIMARY index cannot be dropped'),
        });
    });

    it('renders the partition manager and previews RANGE/LIST operations', async () => {
        const panel = createPanel();
        const services = createServices([{
            PARTITION_NAME: 'p2026',
            PARTITION_ORDINAL_POSITION: 1,
            PARTITION_METHOD: 'RANGE',
            PARTITION_EXPRESSION: 'YEAR(created_at)',
            PARTITION_DESCRIPTION: '2026',
        }]);

        await MysqlPartitionDesignerView.createOrShow({} as vscode.ExtensionContext, {
            target: createTarget(),
            services,
        } as never);

        expect(panel.webview.html).toContain('mysqlPartitionDesigner.js');
        expect(panel.webview.html).toContain('rangeListForm');

        const request: MysqlPartitionOperationRequest = {
            operation: 'addRangeList',
            partitionName: 'p2027',
            valuesClause: "VALUES LESS THAN ('2027-01-01')",
        };
        await getMessageHandler(panel)({ command: 'copyDDL', request });

        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
            "ALTER TABLE sales.orders ADD PARTITION (PARTITION p2027 VALUES LESS THAN ('2027-01-01'));",
        );

        await getMessageHandler(panel)({ command: 'copyDDL', request: {
            ...request,
            partitionName: 'p2026',
        } });
        expect(panel.webview.postMessage).toHaveBeenCalledWith({
            command: 'setError',
            text: expect.stringContaining('already exists'),
        });
    });
});
