import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    CURRENT_EXTENSION_NAMESPACE
} from './configuration';
import {
    compatibilityFiles,
    compatibilitySecretKeys,
    compatibilityStateKeys,
    migrateMementoValue,
    migrateSecretValue,
    updateMementoValue
} from './state';
import { Logger } from '../utils/logger';

const COMPATIBILITY_MIGRATION_VERSION = 1;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getLegacyConfigurationKeys(): string[] {
    // Hardcoded list of deprecated netezza.* configuration keys that were previously supported.
    // These are preserved here to support migration of existing user settings.
    const legacyNamespace = 'netezza';
    return [
        `${legacyNamespace}.cacheTTL`,
        `${legacyNamespace}.codeLens.enabled`,
        `${legacyNamespace}.copilot.enabled`,
        `${legacyNamespace}.copilot.maxWorkspaceProfilesInContext`,
        `${legacyNamespace}.copilot.prompts.explain`,
        `${legacyNamespace}.copilot.prompts.fix`,
        `${legacyNamespace}.copilot.prompts.optimize`,
        `${legacyNamespace}.copilot.requestTimeout`,
        `${legacyNamespace}.copilot.skipPrivacyConfirmation`,
        `${legacyNamespace}.ddl.cacheTTL`,
        `${legacyNamespace}.ddl.maxTablesForContext`,
        `${legacyNamespace}.enableStreaming`,
        `${legacyNamespace}.formatSQL.keywordCase`,
        `${legacyNamespace}.formatSQL.tabWidth`,
        `${legacyNamespace}.highlightActiveStatement`,
        `${legacyNamespace}.importWizard.backgroundValidationEnabled`,
        `${legacyNamespace}.importWizard.backgroundValidationSampleSize`,
        `${legacyNamespace}.importWizard.defaultMode`,
        `${legacyNamespace}.importWizard.previewRowCount`,
        `${legacyNamespace}.importWizard.validationSampleSize`,
        `${legacyNamespace}.linter.enabled`,
        `${legacyNamespace}.linter.mode`,
        `${legacyNamespace}.logging.level`,
        `${legacyNamespace}.longQueryAlertThreshold`,
        `${legacyNamespace}.pythonPath`,
        `${legacyNamespace}.query.executionTimeout`,
        `${legacyNamespace}.query.rowLimit`,
        `${legacyNamespace}.results.maxDataResults`,
        `${legacyNamespace}.results.maxPinnedResults`,
        `${legacyNamespace}.safeExecute.enabled`,
        `${legacyNamespace}.showConflictWarnings`,
        `${legacyNamespace}.sql.showHoverTooltips`,
        `${legacyNamespace}.sql.showInlineTypeHints`,
        `${legacyNamespace}.streamingChunkSize`
    ];
}

async function copyConfigurationScopeIfMissing(
    configuration: vscode.WorkspaceConfiguration,
    currentKey: string,
    currentValue: unknown,
    legacyValue: unknown,
    target: vscode.ConfigurationTarget,
    overrideInLanguage?: boolean
): Promise<boolean> {
    if (currentValue !== undefined || legacyValue === undefined || typeof configuration.update !== 'function') {
        return false;
    }

    await configuration.update(currentKey, legacyValue, target, overrideInLanguage);
    return true;
}

function isMissingConfigurationRegistrationError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    return /is not a registered configuration/i.test(error.message);
}

async function migrateConfigurationAliases(
    logger?: Logger
): Promise<number> {
    const configuration = vscode.workspace.getConfiguration();
    if (typeof configuration.inspect !== 'function' || typeof configuration.update !== 'function') {
        return 0;
    }

    let migratedCount = 0;
    for (const legacyKey of getLegacyConfigurationKeys()) {
        const legacyNamespace = 'netezza';
        const suffix = legacyKey.slice(legacyNamespace.length + 1);
        const currentKey = `${CURRENT_EXTENSION_NAMESPACE}.${suffix}`;
        const currentInspection = configuration.inspect<unknown>(currentKey);
        const legacyInspection = configuration.inspect<unknown>(legacyKey);

        if (!legacyInspection || !currentInspection) {
            continue;
        }

        try {
            migratedCount += Number(await copyConfigurationScopeIfMissing(
                configuration,
                currentKey,
                currentInspection.globalValue,
                legacyInspection.globalValue,
                vscode.ConfigurationTarget.Global
            ));
            migratedCount += Number(await copyConfigurationScopeIfMissing(
                configuration,
                currentKey,
                currentInspection.workspaceValue,
                legacyInspection.workspaceValue,
                vscode.ConfigurationTarget.Workspace
            ));
            migratedCount += Number(await copyConfigurationScopeIfMissing(
                configuration,
                currentKey,
                currentInspection.workspaceFolderValue,
                legacyInspection.workspaceFolderValue,
                vscode.ConfigurationTarget.WorkspaceFolder
            ));
            migratedCount += Number(await copyConfigurationScopeIfMissing(
                configuration,
                currentKey,
                currentInspection.globalLanguageValue,
                legacyInspection.globalLanguageValue,
                vscode.ConfigurationTarget.Global,
                true
            ));
            migratedCount += Number(await copyConfigurationScopeIfMissing(
                configuration,
                currentKey,
                currentInspection.workspaceLanguageValue,
                legacyInspection.workspaceLanguageValue,
                vscode.ConfigurationTarget.Workspace,
                true
            ));
            migratedCount += Number(await copyConfigurationScopeIfMissing(
                configuration,
                currentKey,
                currentInspection.workspaceFolderLanguageValue,
                legacyInspection.workspaceFolderLanguageValue,
                vscode.ConfigurationTarget.WorkspaceFolder,
                true
            ));
        } catch (error) {
            const reason = isMissingConfigurationRegistrationError(error)
                ? `missing registration while migrating ${legacyKey} -> ${currentKey}`
                : `failed to migrate ${legacyKey} -> ${currentKey}: ${getErrorMessage(error)}`;
            logger?.warn(`Compatibility migration skipped setting alias: ${reason}`);
        }
    }

    return migratedCount;
}

async function migrateFavoritesRepositoryFile(): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return false;
    }

    const currentPath = path.join(workspaceFolder.uri.fsPath, compatibilityFiles.favoritesRepository.current);
    const legacyPath = path.join(workspaceFolder.uri.fsPath, compatibilityFiles.favoritesRepository.legacy);
    if (fs.existsSync(currentPath) || !fs.existsSync(legacyPath)) {
        return false;
    }

    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.copyFileSync(legacyPath, currentPath);
    return true;
}

export async function runCompatibilityMigrations(
    context: vscode.ExtensionContext,
    logger?: Logger
): Promise<void> {
    const migratedSecrets = await migrateSecretValue(context.secrets, compatibilitySecretKeys.connections);
    const migratedGlobalStateKeys = await Promise.all([
        migrateMementoValue(context.globalState, compatibilityStateKeys.activeConnection),
        migrateMementoValue(context.globalState, compatibilityStateKeys.connectionsCache),
        migrateMementoValue(context.globalState, compatibilityStateKeys.variableValues),
        migrateMementoValue(context.globalState, compatibilityStateKeys.sessionMonitorAlertSettings),
        migrateMementoValue(context.globalState, compatibilityStateKeys.tuningAdvisorFeedbackState),
        migrateMementoValue(context.globalState, compatibilityStateKeys.gettingStartedShown)
    ]);
    const migratedWorkspaceStateKeys = await Promise.all([
        migrateMementoValue(context.workspaceState, compatibilityStateKeys.favoritesIncludeOnce)
    ]);
    const migratedConfigurationEntries = await migrateConfigurationAliases(logger);
    const migratedFavoritesFile = await migrateFavoritesRepositoryFile();

    await updateMementoValue(
        context.globalState,
        compatibilityStateKeys.compatibilityMigrationVersion,
        COMPATIBILITY_MIGRATION_VERSION
    );

    const migratedGlobalCount = migratedGlobalStateKeys.filter(Boolean).length;
    const migratedWorkspaceCount = migratedWorkspaceStateKeys.filter(Boolean).length;
    const totalMigrations = migratedGlobalCount
        + migratedWorkspaceCount
        + migratedConfigurationEntries
        + Number(migratedSecrets)
        + Number(migratedFavoritesFile);

    if (totalMigrations > 0 && logger) {
        logger.info(
            `Compatibility migrations applied (version ${COMPATIBILITY_MIGRATION_VERSION}): `
            + `secrets=${Number(migratedSecrets)}, globalState=${migratedGlobalCount}, `
            + `workspaceState=${migratedWorkspaceCount}, settings=${migratedConfigurationEntries}, `
            + `workspaceFiles=${Number(migratedFavoritesFile)}`
        );
    }
}
