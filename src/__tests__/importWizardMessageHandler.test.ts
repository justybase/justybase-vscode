/**
 * Focused tests for ImportWizardMessageHandler trust/state boundaries.
 *
 * The full wizard flow needs a live service; these tests cover the host
 * boundary contract: malformed or out-of-order messages must surface as an
 * executionFailed outbound message instead of rejecting as an unhandled
 * promise.
 */

import * as vscode from 'vscode';
import { ImportWizardMessageHandler } from '../views/importWizardMessageHandler';

describe('ImportWizardMessageHandler', () => {
    function createHandler(): {
        handler: ImportWizardMessageHandler;
        postMessage: jest.Mock;
    } {
        const postMessage = jest.fn().mockResolvedValue(true);
        const handler = new ImportWizardMessageHandler({
            context: {} as never,
            service: {} as never,
            connectionManager: {} as never,
            catalogService: {} as never,
            postMessage,
        });
        return { handler, postMessage };
    }

    it('surfaces a session error as executionFailed instead of rejecting', async () => {
        const { handler, postMessage } = createHandler();

        await expect(
            handler.handleMessage({ type: 'setPreviewRowCount', previewRowCount: 5 }),
        ).resolves.toBeUndefined();

        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'executionFailed' }));
    });

    it('routes setSheet to the session service and reposts the updated state', async () => {
        const metadataCache = {
            onDidInvalidate: jest.fn(() => ({ dispose: jest.fn() })),
            onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() })),
        };
        const postMessage = jest.fn().mockResolvedValue(true);
        const state = {
            id: 'session-1',
            targetTable: 'public.orders',
            targetLocation: { database: 'DWH' },
            sheetName: 'Second',
            issues: [],
            warnings: [],
            hasValidationErrors: false,
            executionPlan: { mode: 'direct', createTableSql: '', warnings: [] },
        };
        const setSheet = jest.fn().mockResolvedValue(state);
        const startBackgroundValidation = jest.fn();
        const service = {
            createSession: jest.fn().mockResolvedValue(state),
            setTargetCatalog: jest.fn().mockResolvedValue(undefined),
            getSessionState: jest.fn().mockReturnValue(state),
            setSheet,
            startBackgroundValidation,
            disposeSession: jest.fn(),
        };
        const connectionManager = {
            getConnectionNames: jest.fn().mockReturnValue([]),
            getConnection: jest.fn().mockResolvedValue(undefined),
            getMetadataCache: jest.fn().mockReturnValue(metadataCache),
        };
        const catalogService = {
            loadCatalog: jest.fn().mockResolvedValue({ availableDatabases: [], availableSchemas: [] }),
        };
        const handler = new ImportWizardMessageHandler({
            context: {} as never,
            service: service as never,
            connectionManager: connectionManager as never,
            catalogService: catalogService as never,
            postMessage,
        });

        await handler.initialize({
            filePath: '/tmp/orders.xlsx',
            targetTable: 'public.orders',
            connectionDetails: { database: 'DWH' } as never,
            previewRowCount: 2,
            validationSampleSize: 10,
            connectionName: 'WAREHOUSE',
        });
        postMessage.mockClear();

        await handler.handleMessage({ type: 'setSheet', sheetName: 'Second' });

        expect(setSheet).toHaveBeenCalledWith('session-1', 'Second');
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'previewUpdated' }));
        expect(startBackgroundValidation).toHaveBeenCalledWith(
            'session-1',
            expect.any(Number),
            expect.any(Function),
        );

        handler.dispose();
    });

    it('refreshes the target catalog when metadata for the active connection changes', async () => {
        let invalidateListener: ((connectionName?: string) => void) | undefined;
        const metadataCache = {
            onDidInvalidate: jest.fn((listener: (connectionName?: string) => void) => {
                invalidateListener = listener;
                return { dispose: jest.fn() };
            }),
            onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() })),
        };
        const postMessage = jest.fn().mockResolvedValue(true);
        const updateAvailableSchemas = jest.fn().mockResolvedValue(undefined);
        const state = { id: 'session-1', targetTable: 'public.orders', targetLocation: { database: 'DWH' } };
        const service = {
            createSession: jest.fn().mockResolvedValue(state),
            setTargetCatalog: jest.fn().mockResolvedValue(undefined),
            getSessionState: jest.fn().mockReturnValue(state),
            updateAvailableSchemas,
            disposeSession: jest.fn(),
        };
        const connectionManager = {
            getConnectionNames: jest.fn().mockReturnValue([]),
            getConnection: jest.fn().mockResolvedValue(undefined),
            getMetadataCache: jest.fn().mockReturnValue(metadataCache),
        };
        const catalogService = {
            loadCatalog: jest.fn().mockResolvedValue({ availableDatabases: [], availableSchemas: [] }),
        };
        const handler = new ImportWizardMessageHandler({
            context: {} as never,
            service: service as never,
            connectionManager: connectionManager as never,
            catalogService: catalogService as never,
            postMessage,
        });

        await handler.initialize({
            filePath: '/tmp/orders.csv',
            targetTable: 'public.orders',
            connectionDetails: { database: 'DWH' } as never,
            previewRowCount: 2,
            validationSampleSize: 10,
            connectionName: 'WAREHOUSE',
        });

        postMessage.mockClear();
        updateAvailableSchemas.mockClear();
        expect(invalidateListener).toBeDefined();

        invalidateListener!('WAREHOUSE');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(updateAvailableSchemas).toHaveBeenCalled();
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'previewUpdated' }));

        updateAvailableSchemas.mockClear();
        invalidateListener!('OTHER_CONNECTION');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(updateAvailableSchemas).not.toHaveBeenCalled();

        handler.dispose();
    });

    function createWizardService(): {
        service: Record<string, jest.Mock>;
        startBackgroundValidation: jest.Mock;
        postMessage: jest.Mock;
    } {
        const state = {
            id: 'session-1',
            targetTable: 'public.orders',
            targetLocation: { database: 'DWH' },
            issues: [],
            warnings: [],
            hasValidationErrors: false,
            executionPlan: { mode: 'direct', createTableSql: '', warnings: [] },
        };
        const startBackgroundValidation = jest.fn();
        const postMessage = jest.fn().mockResolvedValue(true);
        const service = {
            createSession: jest.fn().mockResolvedValue(state),
            setTargetCatalog: jest.fn().mockResolvedValue(undefined),
            getSessionState: jest.fn().mockReturnValue(state),
            postMessage,
            startBackgroundValidation,
            setColumnType: jest.fn().mockResolvedValue(state),
            setHasHeaders: jest.fn().mockResolvedValue(state),
            executeImport: jest.fn().mockResolvedValue({ success: true, message: 'ok' }),
            disposeSession: jest.fn(),
        };
        return { service, startBackgroundValidation, postMessage };
    }

    it('skips background validation when the setting is disabled', async () => {
        const { service, startBackgroundValidation, postMessage } = createWizardService();
        const connectionManager = {
            getConnectionNames: jest.fn().mockReturnValue([]),
            getConnection: jest.fn().mockResolvedValue(undefined),
            getMetadataCache: jest.fn().mockReturnValue({ onDidInvalidate: jest.fn(() => ({ dispose: jest.fn() })), onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() })) }),
        };
        const catalogService = {
            loadCatalog: jest.fn().mockResolvedValue({ availableDatabases: [], availableSchemas: [] }),
        };
        const handler = new ImportWizardMessageHandler({
            context: {} as never,
            service: service as never,
            connectionManager: connectionManager as never,
            catalogService: catalogService as never,
            postMessage,
        });

        const getConfigurationMock = vscode.workspace.getConfiguration as jest.Mock;
        const original = getConfigurationMock.getMockImplementation();
        getConfigurationMock.mockReturnValue({
            get: jest.fn((key: string, defaultValue?: unknown) => (
                key === 'importWizard.backgroundValidationEnabled' ? false : defaultValue
            )),
        });

        try {
            await handler.initialize({
                filePath: '/tmp/orders.csv',
                targetTable: 'public.orders',
                connectionDetails: { database: 'DWH' } as never,
                previewRowCount: 2,
                validationSampleSize: 10,
                connectionName: 'WAREHOUSE',
            });
            await handler.handleMessage({ type: 'setSheet', sheetName: 'Second' });

            expect(startBackgroundValidation).not.toHaveBeenCalled();
        } finally {
            if (original) {
                getConfigurationMock.mockImplementation(original);
            } else {
                getConfigurationMock.mockReset();
            }
            handler.dispose();
        }
    });

    it('starts validation from the ready and column-type messages', async () => {
        const { service, startBackgroundValidation, postMessage } = createWizardService();
        const connectionManager = {
            getConnectionNames: jest.fn().mockReturnValue([]),
            getConnection: jest.fn().mockResolvedValue(undefined),
            getMetadataCache: jest.fn().mockReturnValue({ onDidInvalidate: jest.fn(() => ({ dispose: jest.fn() })), onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() })) }),
        };
        const catalogService = {
            loadCatalog: jest.fn().mockResolvedValue({ availableDatabases: [], availableSchemas: [] }),
        };
        const handler = new ImportWizardMessageHandler({
            context: {} as never,
            service: service as never,
            connectionManager: connectionManager as never,
            catalogService: catalogService as never,
            postMessage,
        });

        try {
            await handler.initialize({
                filePath: '/tmp/orders.csv',
                targetTable: 'public.orders',
                connectionDetails: { database: 'DWH' } as never,
                previewRowCount: 2,
                validationSampleSize: 10,
                connectionName: 'WAREHOUSE',
            });

            await handler.handleMessage({ type: 'ready' });
            expect(startBackgroundValidation).toHaveBeenCalledWith('session-1', expect.any(Number), expect.any(Function));

            startBackgroundValidation.mockClear();
            await handler.handleMessage({ type: 'setColumnType', sourceIndex: 0, selectedType: 'DATE' });
            expect(startBackgroundValidation).toHaveBeenCalledWith('session-1', expect.any(Number), expect.any(Function));

            startBackgroundValidation.mockClear();
            await handler.handleMessage({ type: 'startBackgroundValidation', backgroundValidationSampleSize: 250 });
            expect(startBackgroundValidation).toHaveBeenCalledWith('session-1', 250, expect.any(Function));
        } finally {
            handler.dispose();
        }
    });

    it('imports despite validation errors when the user confirms', async () => {
        const { service, postMessage } = createWizardService();
        const state = service.getSessionState();
        state.hasValidationErrors = true;
        state.issues = [{ rowIndex: 0, columnIndex: 0, sourceIndex: 0, severity: 'error', message: 'bad', value: 'x' }];
        const connectionManager = {
            getConnectionNames: jest.fn().mockReturnValue([]),
            getConnection: jest.fn().mockResolvedValue(undefined),
            getMetadataCache: jest.fn().mockReturnValue({ onDidInvalidate: jest.fn(() => ({ dispose: jest.fn() })), onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() })) }),
        };
        const catalogService = {
            loadCatalog: jest.fn().mockResolvedValue({ availableDatabases: [], availableSchemas: [] }),
        };
        const handler = new ImportWizardMessageHandler({
            context: {} as never,
            service: service as never,
            connectionManager: connectionManager as never,
            catalogService: catalogService as never,
            postMessage,
        });

        const withProgress = jest.fn(async (_options: unknown, callback: (progress: { report: jest.Mock }, token: { isCancellationRequested: boolean }) => Promise<unknown>) =>
            callback({ report: jest.fn() }, { isCancellationRequested: false }));
        (vscode.window as unknown as { withProgress: jest.Mock }).withProgress = withProgress;
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Import Anyway');

        try {
            await handler.initialize({
                filePath: '/tmp/orders.csv',
                targetTable: 'public.orders',
                connectionDetails: { database: 'DWH' } as never,
                previewRowCount: 2,
                validationSampleSize: 10,
                connectionName: 'WAREHOUSE',
            });

            await handler.handleMessage({ type: 'executeImport' });

            expect(service.executeImport).toHaveBeenCalledWith(
                'session-1',
                expect.any(Function),
                expect.any(Function),
                { ignoreValidationErrors: true },
            );
            expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'executionFinished' }));
        } finally {
            handler.dispose();
        }
    });

    it('cancels the import when validation errors are not confirmed', async () => {
        const { service, postMessage } = createWizardService();
        const state = service.getSessionState();
        state.hasValidationErrors = true;
        state.issues = [{ rowIndex: 0, columnIndex: 0, sourceIndex: 0, severity: 'error', message: 'bad', value: 'x' }];
        const connectionManager = {
            getConnectionNames: jest.fn().mockReturnValue([]),
            getConnection: jest.fn().mockResolvedValue(undefined),
            getMetadataCache: jest.fn().mockReturnValue({ onDidInvalidate: jest.fn(() => ({ dispose: jest.fn() })), onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() })) }),
        };
        const catalogService = {
            loadCatalog: jest.fn().mockResolvedValue({ availableDatabases: [], availableSchemas: [] }),
        };
        const handler = new ImportWizardMessageHandler({
            context: {} as never,
            service: service as never,
            connectionManager: connectionManager as never,
            catalogService: catalogService as never,
            postMessage,
        });

        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

        try {
            await handler.initialize({
                filePath: '/tmp/orders.csv',
                targetTable: 'public.orders',
                connectionDetails: { database: 'DWH' } as never,
                previewRowCount: 2,
                validationSampleSize: 10,
                connectionName: 'WAREHOUSE',
            });

            await handler.handleMessage({ type: 'executeImport' });

            expect(service.executeImport).not.toHaveBeenCalled();
            expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'executionFinished',
                result: expect.objectContaining({ success: false }),
            }));
        } finally {
            handler.dispose();
        }
    });

    function createHandlerWithService(service: Record<string, jest.Mock>, postMessage: jest.Mock): ImportWizardMessageHandler {
        const connectionManager = {
            getConnectionNames: jest.fn().mockReturnValue([]),
            getConnection: jest.fn().mockResolvedValue(undefined),
            getMetadataCache: jest.fn().mockReturnValue({ onDidInvalidate: jest.fn(() => ({ dispose: jest.fn() })), onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() })) }),
        };
        const catalogService = {
            loadCatalog: jest.fn().mockResolvedValue({ availableDatabases: [], availableSchemas: [] }),
        };
        return new ImportWizardMessageHandler({
            context: {} as never,
            service: service as never,
            connectionManager: connectionManager as never,
            catalogService: catalogService as never,
            postMessage,
        });
    }

    async function initializeWizard(handler: ImportWizardMessageHandler): Promise<void> {
        await handler.initialize({
            filePath: '/tmp/orders.csv',
            targetTable: 'public.orders',
            connectionDetails: { database: 'DWH' } as never,
            previewRowCount: 2,
            validationSampleSize: 10,
            connectionName: 'WAREHOUSE',
        });
    }

    it('skips validation silently when called before a session exists', async () => {
        const { service, startBackgroundValidation, postMessage } = createWizardService();
        const handler = createHandlerWithService(service, postMessage);

        await handler.handleMessage({ type: 'startBackgroundValidation' });
        expect(startBackgroundValidation).not.toHaveBeenCalled();

        handler.dispose();
    });

    it('restarts background validation on setHasHeaders and re-initialize', async () => {
        const { service, startBackgroundValidation, postMessage } = createWizardService();
        const handler = createHandlerWithService(service, postMessage);

        try {
            await initializeWizard(handler);
            await handler.handleMessage({ type: 'ready' });
            startBackgroundValidation.mockClear();

            await handler.handleMessage({ type: 'setHasHeaders', hasHeaders: false });
            expect(startBackgroundValidation).toHaveBeenCalledTimes(1);

            startBackgroundValidation.mockClear();
            await initializeWizard(handler);
            expect(startBackgroundValidation).toHaveBeenCalledTimes(1);
        } finally {
            handler.dispose();
        }
    });

    it('runs an import without validation errors and evaluates the cancellation predicate', async () => {
        const { service, postMessage } = createWizardService();
        const observedCancellation: boolean[] = [];
        service.executeImport.mockImplementation(async (_id: string, _progress: unknown, isCancelled: () => boolean) => {
            observedCancellation.push(isCancelled());
            return { success: true, message: 'ok' };
        });
        const handler = createHandlerWithService(service, postMessage);

        const withProgress = jest.fn(async (_options: unknown, callback: (progress: { report: jest.Mock }, token: { isCancellationRequested: boolean }) => Promise<unknown>) =>
            callback({ report: jest.fn() }, { isCancellationRequested: false }));
        (vscode.window as unknown as { withProgress: jest.Mock }).withProgress = withProgress;

        try {
            await initializeWizard(handler);
            await handler.handleMessage({ type: 'executeImport' });

            expect(service.executeImport).toHaveBeenCalledTimes(1);
            expect(observedCancellation).toEqual([false]);
            expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'executionFinished' }));
        } finally {
            handler.dispose();
        }
    });

    it('uses the configured background validation sample size', async () => {
        const { service, startBackgroundValidation, postMessage } = createWizardService();
        const connectionManager = {
            getConnectionNames: jest.fn().mockReturnValue([]),
            getConnection: jest.fn().mockResolvedValue(undefined),
            getMetadataCache: jest.fn().mockReturnValue({ onDidInvalidate: jest.fn(() => ({ dispose: jest.fn() })), onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() })) }),
        };
        const catalogService = {
            loadCatalog: jest.fn().mockResolvedValue({ availableDatabases: [], availableSchemas: [] }),
        };
        const handler = new ImportWizardMessageHandler({
            context: {} as never,
            service: service as never,
            connectionManager: connectionManager as never,
            catalogService: catalogService as never,
            postMessage,
        });

        const getConfigurationMock = vscode.workspace.getConfiguration as jest.Mock;
        const original = getConfigurationMock.getMockImplementation();
        getConfigurationMock.mockReturnValue({
            get: jest.fn((key: string, defaultValue?: unknown) => (
                key === 'importWizard.backgroundValidationSampleSize' ? 1234 : defaultValue
            )),
        });

        try {
            await handler.initialize({
                filePath: '/tmp/orders.csv',
                targetTable: 'public.orders',
                connectionDetails: { database: 'DWH' } as never,
                previewRowCount: 2,
                validationSampleSize: 10,
                connectionName: 'WAREHOUSE',
            });
            await handler.handleMessage({ type: 'ready' });

            expect(startBackgroundValidation).toHaveBeenCalledWith(
                'session-1',
                1234,
                expect.any(Function),
            );
        } finally {
            if (original) {
                getConfigurationMock.mockImplementation(original);
            } else {
                getConfigurationMock.mockReset();
            }
            handler.dispose();
        }
    });
});
