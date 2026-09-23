import * as vscode from 'vscode';

import { DeferredFeatureScheduler } from '../activation/DeferredFeatureScheduler';

const previewDisposable = { dispose: jest.fn() };

jest.mock('../providers/linterCodeActions', () => ({
    NetezzaLinterCodeActionProvider: class {
        static providedCodeActionKinds: unknown[] = [];
        constructor() { /* test double */ }
    },
}));

jest.mock('../providers/sqlRefactorCodeActions', () => ({
    SqlRefactorCodeActionProvider: class {
        static providedCodeActionKinds: unknown[] = [];
        constructor() { /* test double */ }
    },
}));

jest.mock('../providers/sqlRefactorPreview', () => ({
    registerSqlRefactorPreviewCommand: jest.fn(() => previewDisposable),
}));

describe('DeferredFeatureScheduler', () => {
    it('registers refactor preview and both code action providers', async () => {
        const scheduler = new DeferredFeatureScheduler();
        const subscriptions: Array<{ dispose: () => void }> = [];
        const context = { subscriptions } as unknown as vscode.ExtensionContext;
        const connectionManager = {
            getExecutionDatabaseKind: jest.fn(),
        };
        const logger = { info: jest.fn(), error: jest.fn() };
        const runCodeActionsJob = (scheduler as unknown as {
            runCodeActionsJob: (params: unknown) => Promise<void>;
        }).runCodeActionsJob.bind(scheduler);

        const languages = vscode.languages as unknown as {
            registerCodeActionsProvider: jest.Mock;
        };
        languages.registerCodeActionsProvider.mockClear();

        await runCodeActionsJob({
            context,
            logger,
            metadataCache: {},
            connectionManager,
            skipDeferredFeatureInit: false,
            isExtensionShuttingDown: () => false,
        });

        expect(languages.registerCodeActionsProvider).toHaveBeenCalledTimes(2);
        expect(subscriptions).toContain(previewDisposable);
        expect(logger.info).toHaveBeenCalledWith('[perf] SQL code actions registered (deferred)');
    });
});
