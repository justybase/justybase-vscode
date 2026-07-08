import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadataCache';
import { Logger } from '../utils/logger';
import { registerCompatibilityCommandAliases } from '../compatibility/commandAliases';
import { SQL_AUTHORING_LANGUAGE_IDS } from '../utils/sqlLanguage';

export interface DeferredFeatureSchedulerParams {
    context: vscode.ExtensionContext;
    logger: Logger;
    metadataCache: MetadataCache;
    connectionManager: ConnectionManager;
    skipDeferredFeatureInit: boolean;
    isExtensionShuttingDown: () => boolean;
}

/**
 * Schedules heavyweight SQL validation features after activation.
 * Jobs run in explicit dependency order: validator → linter → code actions.
 */
export class DeferredFeatureScheduler {
    private initialDelayTimer: ReturnType<typeof setTimeout> | undefined;

    schedule(params: DeferredFeatureSchedulerParams): void {
        const { skipDeferredFeatureInit, isExtensionShuttingDown } = params;
        if (skipDeferredFeatureInit) {
            return;
        }

        this.initialDelayTimer = setTimeout(() => {
            this.initialDelayTimer = undefined;
            if (isExtensionShuttingDown()) {
                return;
            }
            void this.runValidatorJob(params)
                .then(() => this.runLinterJob(params))
                .then(() => this.runCodeActionsJob(params))
                .catch((error: unknown) => {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    params.logger.error(
                        `Netezza extension: Deferred feature chain failed: ${errorMessage}`,
                    );
                });
        }, 500);
    }

    dispose(): void {
        if (this.initialDelayTimer) {
            clearTimeout(this.initialDelayTimer);
            this.initialDelayTimer = undefined;
        }
    }

    private async runValidatorJob(params: DeferredFeatureSchedulerParams): Promise<void> {
        if (params.isExtensionShuttingDown()) {
            return;
        }

        const { registerValidationCommands, initializeSqlValidator } = await import(
            '../commands/validationCommands'
        );
        initializeSqlValidator(params.metadataCache, params.connectionManager);
        const validationDisposables = registerValidationCommands();
        params.context.subscriptions.push(...validationDisposables);
        const aliasDisposables = await registerCompatibilityCommandAliases();
        params.context.subscriptions.push(...aliasDisposables);
        params.logger.info('[perf] Chevrotain validation commands loaded (deferred)');
    }

    private async runLinterJob(params: DeferredFeatureSchedulerParams): Promise<void> {
        if (params.isExtensionShuttingDown()) {
            return;
        }

        const { activateSqlLinter } = await import('../providers/sqlLinterProvider');
        activateSqlLinter(params.context);
        params.logger.info('[perf] SQL linter activated (deferred)');
    }

    private async runCodeActionsJob(params: DeferredFeatureSchedulerParams): Promise<void> {
        if (params.isExtensionShuttingDown()) {
            return;
        }

        const [{ NetezzaLinterCodeActionProvider }, { SqlRefactorCodeActionProvider }] =
            await Promise.all([
                import('../providers/linterCodeActions'),
                import('../providers/sqlRefactorCodeActions'),
            ]);

        params.context.subscriptions.push(
            vscode.languages.registerCodeActionsProvider(
                [...SQL_AUTHORING_LANGUAGE_IDS],
                new NetezzaLinterCodeActionProvider(documentUri =>
                    params.connectionManager.getExecutionDatabaseKind(documentUri),
                    {
                        connectionManager: params.connectionManager,
                        metadataCache: params.metadataCache,
                    },
                ),
                { providedCodeActionKinds: NetezzaLinterCodeActionProvider.providedCodeActionKinds },
            ),
            vscode.languages.registerCodeActionsProvider(
                [...SQL_AUTHORING_LANGUAGE_IDS],
                new SqlRefactorCodeActionProvider(documentUri =>
                    params.connectionManager.getExecutionDatabaseKind(documentUri),
                ),
                { providedCodeActionKinds: SqlRefactorCodeActionProvider.providedCodeActionKinds },
            ),
        );
        params.logger.info('[perf] SQL code actions registered (deferred)');
    }
}
