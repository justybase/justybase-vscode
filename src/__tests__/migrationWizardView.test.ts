/**
 * Host-boundary and state tests for MigrationWizardView.
 *
 * These cover the FQ02 contract: malformed messages must not reject as
 * unhandled promises, and an analysis run must expose and clear a distinct
 * `analyzing` state so concurrent work cannot race.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import { MigrationService } from '../migration/migrationService';
import { MigrationWizardView, type MigrationWizardSessionOptions } from '../views/migrationWizardView';

describe('MigrationWizardView', () => {
    let messageHandler: ((message: unknown) => Promise<void>) | undefined;
    let postMessage: jest.Mock;
    let analyzingSnapshots: boolean[];
    let view: MigrationWizardView | undefined;

    const context = { extensionUri: { fsPath: '/test', toString: () => 'file:///test' } } as unknown as vscode.ExtensionContext;
    const connectionManager = {
        getConnections: jest.fn().mockResolvedValue([]),
        getMetadataCache: jest.fn(() => undefined),
    } as unknown as ConnectionManager;

    const options: MigrationWizardSessionOptions = {
        source: { mode: 'table', connectionName: 'SRC', schema: 'ADMIN', table: 'ORDERS' },
        targetConnectionName: 'TGT',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        messageHandler = undefined;
        analyzingSnapshots = [];
        view = undefined;
        postMessage = jest.fn((message: { type?: string; state?: { analyzing?: boolean } }) => {
            if (message?.type === 'state') {
                analyzingSnapshots.push(Boolean(message.state?.analyzing));
            }
            return Promise.resolve(true);
        });

        const webview = {
            options: {},
            html: '',
            onDidReceiveMessage: jest.fn((handler: (message: unknown) => Promise<void>) => {
                messageHandler = handler;
                return { dispose: jest.fn() };
            }),
            postMessage,
            asWebviewUri: jest.fn((uri: vscode.Uri) => ({ toString: () => `mock://${uri.fsPath}` })),
            cspSource: 'mock-csp',
        };
        const panel = {
            webview,
            title: '',
            reveal: jest.fn(),
            onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
            dispose: jest.fn(),
        };
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    });

    afterEach(() => {
        view?.dispose();
        jest.restoreAllMocks();
    });

    it('surfaces a malformed analyze message as executionFailed instead of rejecting', async () => {
        view = await MigrationWizardView.createOrShow(context, connectionManager, options);
        postMessage.mockClear();

        await expect(messageHandler!({ type: 'analyze' })).resolves.toBeUndefined();

        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'executionFailed' }));
    });

    it('marks the state as analyzing during analysis and clears it afterwards', async () => {
        const analysis = {
            sourceContext: { kind: 'netezza', qualifiedTableName: 'ADMIN.ORDERS' },
            columns: [{
                sourceIndex: 0,
                sourceName: 'ID',
                sourceType: 'INTEGER',
                targetName: 'ID',
                targetType: 'INTEGER',
                notNull: false,
                isPk: false,
            }],
            pkColumns: [],
            warnings: [],
            sampleCells: [],
        } as unknown as Awaited<ReturnType<MigrationService['analyzeSource']>>;
        const plan = {
            sourceKind: 'netezza',
            targetKind: 'postgresql',
            targetQualifiedName: 'public.orders_migrated',
            totalRows: 0,
            columns: analysis.columns,
            createTableDdl: 'CREATE TABLE public.orders_migrated (id INTEGER)',
            warnings: [],
        } as unknown as ReturnType<MigrationService['buildPlan']>;

        jest.spyOn(MigrationService.prototype, 'analyzeSource').mockResolvedValue(analysis);
        jest.spyOn(MigrationService.prototype, 'buildPlan').mockReturnValue(plan);

        view = await MigrationWizardView.createOrShow(context, connectionManager, options);
        postMessage.mockClear();

        await messageHandler!({
            type: 'analyze',
            source: { mode: 'table', connectionName: 'SRC', schema: 'ADMIN', table: 'ORDERS' },
            target: { connectionName: 'TGT', database: 'WH', schema: 'PUBLIC', table: 'ORDERS_MIGRATED', appendToExistingTable: false },
        });

        expect(analyzingSnapshots).toContain(true);
        expect(analyzingSnapshots[analyzingSnapshots.length - 1]).toBe(false);
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'analysisUpdated' }));
    });

    it('does not reset an in-progress migration when the command is reopened', async () => {
        let resolveAnalysis!: (value: unknown) => void;
        jest.spyOn(MigrationService.prototype, 'analyzeSource')
            .mockReturnValue(new Promise(resolve => { resolveAnalysis = resolve as (value: unknown) => void; }));
        jest.spyOn(MigrationService.prototype, 'buildPlan').mockReturnValue({
            sourceKind: 'netezza',
            targetKind: 'postgresql',
            targetQualifiedName: 'public.orders_migrated',
            totalRows: 0,
            columns: [],
            createTableDdl: '',
            warnings: [],
        } as never);

        view = await MigrationWizardView.createOrShow(context, connectionManager, options);
        void messageHandler!({
            type: 'analyze',
            source: { mode: 'table', connectionName: 'SRC', schema: 'ADMIN', table: 'ORDERS' },
            target: { connectionName: 'TGT', database: 'WH', schema: 'PUBLIC', table: 'ORDERS_MIGRATED', appendToExistingTable: false },
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        postMessage.mockClear();
        await view.loadSession({
            source: { mode: 'table', connectionName: 'OTHER_SRC', table: 'OTHER_TABLE' },
            targetConnectionName: 'OTHER_TGT',
        });

        expect(postMessage).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('already in progress'));

        resolveAnalysis({
            sourceContext: { kind: 'netezza', qualifiedTableName: 'ADMIN.ORDERS' },
            columns: [],
            pkColumns: [],
            warnings: [],
            sampleCells: [],
        });
        await new Promise(resolve => setTimeout(resolve, 0));
    });

    it('stops posting to the webview after the panel is disposed', async () => {
        view = await MigrationWizardView.createOrShow(context, connectionManager, options);
        view.dispose();
        postMessage.mockClear();

        await expect(messageHandler!({ type: 'requestCatalog', connectionName: 'SRC' })).resolves.toBeUndefined();

        expect(postMessage).not.toHaveBeenCalled();
    });
});
