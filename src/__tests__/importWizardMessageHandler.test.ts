/**
 * Focused tests for ImportWizardMessageHandler trust/state boundaries.
 *
 * The full wizard flow needs a live service; these tests cover the host
 * boundary contract: malformed or out-of-order messages must surface as an
 * executionFailed outbound message instead of rejecting as an unhandled
 * promise.
 */

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
});
