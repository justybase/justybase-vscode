import * as path from 'path';
import * as vscode from 'vscode';

export interface CompatibilityStateKey {
    current: string;
    legacy: readonly string[];
}

export interface CompatibilitySecretKey {
    current: string;
    legacyRead: readonly string[];
    legacyWrite?: readonly string[];
}

export const compatibilityStateKeys = {
    activeConnection: {
        current: 'justybase.activeConnection',
        legacy: ['netezza-active-connection']
    },
    connectionsCache: {
        current: 'justybase.connectionsCache',
        legacy: ['netezza-connections-cache']
    },
    variableValues: {
        current: 'justybase.variableValues',
        legacy: ['netezza.variableValues']
    },
    sessionMonitorAlertSettings: {
        current: 'justybase.sessionMonitor.alertSettings',
        legacy: ['netezza.sessionMonitor.alertSettings']
    },
    tuningAdvisorFeedbackState: {
        current: 'justybase.tuningAdvisor.feedback.v1',
        legacy: ['netezza.tuningAdvisor.feedback.v1']
    },
    gettingStartedShown: {
        current: 'justybase.gettingStarted.shown',
        legacy: ['netezza.gettingStarted.shown']
    },
    copilotSensitiveToolsNoticeShown: {
        current: 'justybase.copilot.sensitiveToolsNoticeShown.v1',
        legacy: []
    },
    resultPanelFirstPaintTelemetry: {
        current: 'justybase.resultPanel.firstPaintTelemetry.v1',
        legacy: ['netezza.resultPanel.firstPaintTelemetry.v1']
    },
    favoritesIncludeOnce: {
        current: 'justybase.favorites.includeOnce',
        legacy: ['netezza.favorites.includeOnce']
    },
    compatibilityMigrationVersion: {
        current: 'justybase.compatibilityMigration.version',
        legacy: []
    }
} as const satisfies Record<string, CompatibilityStateKey>;

export const compatibilitySecretKeys = {
    connections: {
        current: 'justybase-vscode-connections',
        legacyRead: ['netezza-vscode-connections'],
        legacyWrite: ['netezza-vscode-connections']
    }
} as const satisfies Record<string, CompatibilitySecretKey>;

export const compatibilityFiles = {
    favoritesRepository: {
        current: path.join('.vscode', 'justybase-favorites.json'),
        legacy: path.join('.vscode', 'netezza-favorites.json')
    }
} as const;

function getDefinedMementoValue<T>(memento: vscode.Memento, key: string): T | undefined {
    return memento.get<T | undefined>(key);
}

export function getMementoValue<T>(
    memento: vscode.Memento,
    key: CompatibilityStateKey,
    defaultValue?: T
): T | undefined {
    const currentValue = getDefinedMementoValue<T>(memento, key.current);
    if (currentValue !== undefined) {
        return currentValue;
    }

    for (const legacyKey of key.legacy) {
        const legacyValue = getDefinedMementoValue<T>(memento, legacyKey);
        if (legacyValue !== undefined) {
            return legacyValue;
        }
    }

    return defaultValue;
}

export async function updateMementoValue<T>(
    memento: vscode.Memento,
    key: CompatibilityStateKey,
    value: T | undefined
): Promise<void> {
    const keys = [key.current, ...key.legacy];
    await Promise.all(keys.map(candidate => Promise.resolve(memento.update(candidate, value))));
}

export async function migrateMementoValue<T>(
    memento: vscode.Memento,
    key: CompatibilityStateKey
): Promise<boolean> {
    const currentValue = getDefinedMementoValue<T>(memento, key.current);
    if (currentValue !== undefined) {
        return false;
    }

    for (const legacyKey of key.legacy) {
        const legacyValue = getDefinedMementoValue<T>(memento, legacyKey);
        if (legacyValue !== undefined) {
            await Promise.resolve(memento.update(key.current, legacyValue));
            return true;
        }
    }

    return false;
}

export async function getSecretValue(
    secrets: vscode.SecretStorage,
    key: CompatibilitySecretKey
): Promise<string | undefined> {
    const currentValue = await secrets.get(key.current);
    if (currentValue !== undefined) {
        return currentValue;
    }

    for (const legacyKey of key.legacyRead) {
        const legacyValue = await secrets.get(legacyKey);
        if (legacyValue !== undefined) {
            return legacyValue;
        }
    }

    return undefined;
}

export async function storeSecretValue(
    secrets: vscode.SecretStorage,
    key: CompatibilitySecretKey,
    value: string
): Promise<void> {
    const writeKeys = [key.current, ...(key.legacyWrite ?? key.legacyRead)];
    const uniqueWriteKeys = Array.from(new Set(writeKeys));
    await Promise.all(uniqueWriteKeys.map(candidate => secrets.store(candidate, value)));
}

export async function deleteSecretValues(
    secrets: vscode.SecretStorage,
    key: CompatibilitySecretKey
): Promise<void> {
    const deleteKeys = [key.current, ...key.legacyRead, ...(key.legacyWrite ?? [])];
    const uniqueDeleteKeys = Array.from(new Set(deleteKeys));
    await Promise.all(uniqueDeleteKeys.map(candidate => secrets.delete(candidate)));
}

export async function migrateSecretValue(
    secrets: vscode.SecretStorage,
    key: CompatibilitySecretKey
): Promise<boolean> {
    const currentValue = await secrets.get(key.current);
    if (currentValue !== undefined) {
        return false;
    }

    for (const legacyKey of key.legacyRead) {
        const legacyValue = await secrets.get(legacyKey);
        if (legacyValue !== undefined) {
            await secrets.store(key.current, legacyValue);
            return true;
        }
    }

    return false;
}
