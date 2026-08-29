import * as vscode from 'vscode';
import { Db2IndexDesignerView } from '../../../../extensions/db2/src/db2IndexDesignerView';
import { Db2PartitionDesignerView } from '../../../../extensions/db2/src/db2PartitionDesignerView';
import type { Db2IndexDesign } from '../../../contracts/webviews/db2IndexDesignerContracts';
import type { Db2PartitionOperationRequest } from '../../../contracts/webviews/db2PartitionDesignerContracts';

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
        extensionUri: vscode.Uri.file('/core-extension')
    });
}

function getMessageHandler(panel: TestPanel): (message: unknown) => Promise<void> {
    const handler = (panel.webview.onDidReceiveMessage as jest.Mock).mock.calls[0]?.[0];
    if (typeof handler !== 'function') {
        throw new Error('The webview message handler was not registered.');
    }
    return handler as (message: unknown) => Promise<void>;
}

function createIndexServices(columnRows: Array<Record<string, unknown>> = [
    {
        ATTNAME: 'ID',
        FORMAT_TYPE: 'INTEGER',
        IS_NOT_NULL: 1,
        COLDEFAULT: '',
        DESCRIPTION: 'Identifier',
        IS_PK: 1,
        IS_FK: 0,
        ATTNUM: 1
    },
    {
        ATTNAME: 'STATUS',
        FORMAT_TYPE: 'VARCHAR(20)',
        IS_NOT_NULL: 0,
        COLDEFAULT: '',
        DESCRIPTION: 'Current status',
        IS_PK: 0,
        IS_FK: 0,
        ATTNUM: 2
    }
]): {
    services: Record<string, jest.Mock>;
    provider: { listIndexes: jest.Mock };
} {
    const services = {
        executeQuery: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('SYSCAT.COLUMNS')) {
                return Promise.resolve(columnRows);
            }
            if (sql.includes('SYSCAT.TABLESPACES')) {
                return Promise.resolve([{ TBSPACE: 'INDEX_TS' }]);
            }
            return Promise.resolve([]);
        }),
        executeWithProgress: jest.fn(),
        executeSql: jest.fn(),
        openSqlDocument: jest.fn()
    };
    return {
        services,
        provider: {
            listIndexes: jest.fn().mockResolvedValue([])
        }
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
        connectionName: 'db2-connection',
        databaseName: 'SAMPLE',
        schemaName: 'ADMIN',
        tableName: 'ORDERS',
        qualifiedName: 'ADMIN.ORDERS'
    };
}

describe('Db2 designer webview hosts', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        configureCoreExtension();
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Cancel');
    });

    it('renders a metadata-driven index picker and builds DDL from a typed design', async () => {
        const panel = createPanel();
        const { services, provider } = createIndexServices();

        await Db2IndexDesignerView.createOrShow({} as vscode.ExtensionContext, {
            provider,
            target: createTarget(),
            services
        } as never);

        expect(panel.webview.html).toContain('availableColumns');
        expect(panel.webview.html).toContain('Storage and Performance');
        expect(panel.webview.html).toContain('Expert Options');
        expect(panel.webview.html).not.toContain('Enter column names (comma-separated)');

        const design: Db2IndexDesign = {
            indexName: 'ORDERS_STATUS_IDX',
            keyColumns: [{ name: 'STATUS', order: 'DESC' }],
            includeColumns: ['ID'],
            unique: false,
            clustered: false
        };
        await getMessageHandler(panel)({ command: 'copyDDL', design });

        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
            'CREATE INDEX ADMIN.ORDERS_STATUS_IDX ON ADMIN.ORDERS (STATUS DESC) INCLUDE (ID);'
        );
    });

    it('rejects index columns that are not part of the loaded table metadata', async () => {
        const panel = createPanel();
        const { services, provider } = createIndexServices();

        await Db2IndexDesignerView.createOrShow({} as vscode.ExtensionContext, {
            provider,
            target: createTarget(),
            services
        } as never);

        await getMessageHandler(panel)({
            command: 'executeDesign',
            design: {
                indexName: 'ORDERS_BAD_IDX',
                keyColumns: [{ name: 'NOT_A_COLUMN', order: 'ASC' }],
                includeColumns: [],
                unique: false,
                clustered: false
            }
        });

        expect(panel.webview.postMessage).toHaveBeenCalledWith({
            command: 'setError',
            text: expect.stringContaining('does not belong')
        });
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(services.executeSql).not.toHaveBeenCalled();
    });

    it('keeps quoted Db2 column names distinct in host validation', async () => {
        const panel = createPanel();
        const { services, provider } = createIndexServices([
            { ATTNAME: 'foo', FORMAT_TYPE: 'INTEGER', ATTNUM: 1 },
            { ATTNAME: 'FOO', FORMAT_TYPE: 'INTEGER', ATTNUM: 2 }
        ]);

        await Db2IndexDesignerView.createOrShow({} as vscode.ExtensionContext, {
            provider,
            target: createTarget(),
            services
        } as never);

        await getMessageHandler(panel)({
            command: 'copyDDL',
            design: {
                indexName: 'ORDERS_FOO_IDX',
                keyColumns: [{ name: 'foo', order: 'ASC' }],
                includeColumns: ['FOO'],
                unique: false,
                clustered: false
            }
        });

        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
            'CREATE INDEX ADMIN.ORDERS_FOO_IDX ON ADMIN.ORDERS ("foo") INCLUDE (FOO);'
        );
    });

    it('lists existing indexes and executes a host-validated drop request', async () => {
        const panel = createPanel();
        const { services, provider } = createIndexServices();
        provider.listIndexes.mockResolvedValue([{
            schema: 'ADMIN',
            name: 'ORDERS_STATUS_IDX',
            tableName: 'ORDERS',
            tableSchema: 'ADMIN',
            indexType: 'btree',
            isUnique: false,
            isPrimary: false,
            columns: ['STATUS'],
            columnOrders: [{ name: 'STATUS', order: 'DESC' }],
            isSystemRequired: false,
            isValid: true
        }]);
        services.executeWithProgress.mockImplementation(async (_title: string, operation: () => Promise<unknown>) => operation());
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Execute DDL');

        await Db2IndexDesignerView.createOrShow({} as vscode.ExtensionContext, {
            provider,
            target: createTarget(),
            services
        } as never);

        expect(panel.webview.html).toContain('ORDERS_STATUS_IDX');
        await getMessageHandler(panel)({ command: 'dropIndex', indexName: 'ORDERS_STATUS_IDX' });

        expect(services.executeSql).toHaveBeenCalledWith(
            'DROP INDEX ADMIN.ORDERS_STATUS_IDX;',
            'db2-connection',
            'Dropping index ORDERS_STATUS_IDX...'
        );
    });

    it('renders source table suggestions and builds partition DDL from a typed operation', async () => {
        const panel = createPanel();
        const services = {
            executeQuery: jest.fn().mockImplementation((sql: string) => {
                if (sql.includes('SYSCAT.COLUMNS')) {
                    return Promise.resolve([{
                        ATTNAME: 'ORDER_DATE',
                        FORMAT_TYPE: 'DATE',
                        IS_NOT_NULL: 1,
                        COLDEFAULT: '',
                        DESCRIPTION: '',
                        IS_PK: 0,
                        IS_FK: 0,
                        ATTNUM: 1
                    }]);
                }
                if (sql.includes('SYSCAT.DATAPARTITIONS P')) {
                    return Promise.resolve([{
                        PARTITION_NAME: 'P_2025',
                        LOWVALUE: "('2025-01-01')",
                        HIGHVALUE: "('2026-01-01')",
                        LOWINCLUSIVE: 'Y',
                        HIGHINCLUSIVE: 'N',
                        TBSPACE: 'DATA_TS',
                        ROW_COUNT: 10
                    }]);
                }
                if (sql.includes('SYSCAT.DATAPARTITIONEXPRESSION')) {
                    return Promise.resolve([{ PARTITION_EXPRESSION: 'ORDER_DATE', NULLSFIRST: 'Y' }]);
                }
                if (sql.includes('SYSCAT.TABLESPACES')) {
                    return Promise.resolve([{ TBSPACE: 'DATA_TS' }]);
                }
                if (sql.includes('FROM SYSCAT.TABLES')) {
                    return Promise.resolve([{ OBJNAME: 'ORDERS_ARCHIVE', OBJTYPE: 'TABLE' }]);
                }
                return Promise.resolve([]);
            }),
            executeWithProgress: jest.fn(),
            executeSql: jest.fn(),
            openSqlDocument: jest.fn()
        };

        await Db2PartitionDesignerView.createOrShow({} as vscode.ExtensionContext, {
            target: createTarget(),
            services
        } as never);

        expect(panel.webview.html).toContain('sourceTables');
        expect(panel.webview.html).toContain('ORDERS_ARCHIVE');

        const request: Db2PartitionOperationRequest = {
            operation: 'add',
            range: {
                partitionName: 'P_2026',
                startingFrom: "('2026-01-01')",
                startingInclusive: true,
                endingAt: "('2027-01-01')",
                endingInclusive: false
            }
        };
        await getMessageHandler(panel)({ command: 'copyDDL', request });

        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
            "ALTER TABLE ADMIN.ORDERS ADD PARTITION P_2026 STARTING FROM ('2026-01-01') INCLUSIVE ENDING AT ('2027-01-01') EXCLUSIVE;"
        );
    });
});
