import * as vscode from 'vscode';
import {
    CompatibilitySecretKey,
    CompatibilityStateKey,
    compatibilitySecretKeys,
    compatibilityStateKeys,
    deleteSecretValues,
    getMementoValue,
    getSecretValue,
    migrateMementoValue,
    migrateSecretValue,
    storeSecretValue,
    updateMementoValue
} from '../compatibility/state';

jest.mock('vscode');

interface MockMemento extends vscode.Memento {
    values: Record<string, unknown>;
}

interface MockSecretStorage extends vscode.SecretStorage {
    values: Record<string, string>;
}

function createMockMemento(initialValues: Record<string, unknown> = {}): MockMemento {
    const values = { ...initialValues };
    return {
        values,
        get: jest.fn((key: string) => values[key]),
        update: jest.fn((key: string, value: unknown) => {
            values[key] = value;
            return Promise.resolve();
        })
    } as unknown as MockMemento;
}

function createMockSecretStorage(initialValues: Record<string, string> = {}): MockSecretStorage {
    const values = { ...initialValues };
    return {
        values,
        get: jest.fn(async (key: string) => values[key]),
        store: jest.fn(async (key: string, value: string) => {
            values[key] = value;
        }),
        delete: jest.fn(async (key: string) => {
            delete values[key];
        })
    } as unknown as MockSecretStorage;
}

describe('compatibility state helpers', () => {
    it('prefers current memento values over legacy values', () => {
        const memento = createMockMemento({
            [compatibilityStateKeys.activeConnection.current]: 'current-connection',
            [compatibilityStateKeys.activeConnection.legacy[0]]: 'legacy-connection'
        });

        expect(getMementoValue(memento, compatibilityStateKeys.activeConnection)).toBe('current-connection');
    });

    it('falls back to legacy memento values and then the provided default', () => {
        const memento = createMockMemento({
            [compatibilityStateKeys.activeConnection.legacy[0]]: 'legacy-connection'
        });

        expect(getMementoValue(memento, compatibilityStateKeys.activeConnection)).toBe('legacy-connection');
        expect(getMementoValue(memento, compatibilityStateKeys.connectionsCache, 'fallback')).toBe('fallback');
    });

    it('mirrors memento updates to current and legacy keys', async () => {
        const stateKey: CompatibilityStateKey = compatibilityStateKeys.variableValues;
        const memento = createMockMemento();
        const value = { limit: 10 };

        await updateMementoValue(memento, stateKey, value);

        expect(memento.update).toHaveBeenCalledTimes(1 + stateKey.legacy.length);
        expect(memento.values[stateKey.current]).toEqual(value);
        for (const legacyKey of stateKey.legacy) {
            expect(memento.values[legacyKey]).toEqual(value);
        }
    });

    it('migrates legacy memento values into the current key only when current is missing', async () => {
        const memento = createMockMemento({
            [compatibilityStateKeys.sessionMonitorAlertSettings.legacy[0]]: { enabled: true }
        });

        await expect(migrateMementoValue(memento, compatibilityStateKeys.sessionMonitorAlertSettings)).resolves.toBe(true);
        expect(memento.values[compatibilityStateKeys.sessionMonitorAlertSettings.current]).toEqual({ enabled: true });

        const existingCurrent = createMockMemento({
            [compatibilityStateKeys.sessionMonitorAlertSettings.current]: { enabled: false },
            [compatibilityStateKeys.sessionMonitorAlertSettings.legacy[0]]: { enabled: true }
        });
        await expect(migrateMementoValue(existingCurrent, compatibilityStateKeys.sessionMonitorAlertSettings)).resolves.toBe(false);
        expect(existingCurrent.values[compatibilityStateKeys.sessionMonitorAlertSettings.current]).toEqual({ enabled: false });
    });

    it('reads secret values from the current key or falls back to legacy keys', async () => {
        const currentSecrets = createMockSecretStorage({
            [compatibilitySecretKeys.connections.current]: 'current-secret'
        });
        await expect(getSecretValue(currentSecrets, compatibilitySecretKeys.connections)).resolves.toBe('current-secret');

        const legacySecrets = createMockSecretStorage({
            [compatibilitySecretKeys.connections.legacyRead[0]]: 'legacy-secret'
        });
        await expect(getSecretValue(legacySecrets, compatibilitySecretKeys.connections)).resolves.toBe('legacy-secret');
    });

    it('stores and deletes secret values across current and legacy keys without duplicate writes', async () => {
        const secretKey: CompatibilitySecretKey = compatibilitySecretKeys.connections;
        const secrets = createMockSecretStorage();

        await storeSecretValue(secrets, secretKey, 'serialized-connections');

        expect(secrets.store).toHaveBeenCalledTimes(2);
        expect(secrets.values[secretKey.current]).toBe('serialized-connections');
        expect(secrets.values[secretKey.legacyRead[0]]).toBe('serialized-connections');

        await deleteSecretValues(secrets, secretKey);

        expect(secrets.delete).toHaveBeenCalledTimes(2);
        expect(secrets.values[secretKey.current]).toBeUndefined();
        expect(secrets.values[secretKey.legacyRead[0]]).toBeUndefined();
    });

    it('migrates legacy secret values into the current key when needed', async () => {
        const secrets = createMockSecretStorage({
            [compatibilitySecretKeys.connections.legacyRead[0]]: 'legacy-secret'
        });

        await expect(migrateSecretValue(secrets, compatibilitySecretKeys.connections)).resolves.toBe(true);
        expect(secrets.values[compatibilitySecretKeys.connections.current]).toBe('legacy-secret');

        const currentSecrets = createMockSecretStorage({
            [compatibilitySecretKeys.connections.current]: 'current-secret',
            [compatibilitySecretKeys.connections.legacyRead[0]]: 'legacy-secret'
        });
        await expect(migrateSecretValue(currentSecrets, compatibilitySecretKeys.connections)).resolves.toBe(false);
        expect(currentSecrets.values[compatibilitySecretKeys.connections.current]).toBe('current-secret');
    });
});
