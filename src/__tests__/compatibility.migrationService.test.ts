import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Logger } from '../utils/logger';
import { runCompatibilityMigrations } from '../compatibility/migrationService';
import {
    compatibilityFiles,
    compatibilitySecretKeys,
    compatibilityStateKeys
} from '../compatibility/state';

jest.mock('vscode');
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        existsSync: jest.fn(),
        mkdirSync: jest.fn(),
        copyFileSync: jest.fn()
    };
});

interface MockMemento extends vscode.Memento {
    values: Record<string, unknown>;
}

interface MockSecretStorage extends vscode.SecretStorage {
    values: Record<string, string>;
}

interface MockConfigurationInspection {
    key: string;
    defaultValue?: unknown;
    globalValue?: unknown;
    workspaceValue?: unknown;
    workspaceFolderValue?: unknown;
    globalLanguageValue?: unknown;
    workspaceLanguageValue?: unknown;
    workspaceFolderLanguageValue?: unknown;
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

function createInspection(
    key: string,
    values: Partial<MockConfigurationInspection> = {}
): MockConfigurationInspection {
    return {
        key,
        defaultValue: undefined,
        globalValue: undefined,
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
        globalLanguageValue: undefined,
        workspaceLanguageValue: undefined,
        workspaceFolderLanguageValue: undefined,
        ...values
    };
}

describe('compatibility migration service', () => {
    const workspaceRoot = path.join('workspace-root');
    const currentFavoritesPath = path.join(workspaceRoot, compatibilityFiles.favoritesRepository.current);
    const legacyFavoritesPath = path.join(workspaceRoot, compatibilityFiles.favoritesRepository.legacy);

    let globalState: MockMemento;
    let workspaceState: MockMemento;
    let secrets: MockSecretStorage;
    let rootConfiguration: jest.Mocked<vscode.WorkspaceConfiguration>;
    let context: vscode.ExtensionContext;

    beforeEach(() => {
        jest.clearAllMocks();
        (vscode as unknown as {
            ConfigurationTarget: Record<string, number>;
        }).ConfigurationTarget = {
            Global: 1,
            Workspace: 2,
            WorkspaceFolder: 3
        };

        globalState = createMockMemento({
            [compatibilityStateKeys.activeConnection.legacy[0]]: 'LegacyConnection',
            [compatibilityStateKeys.variableValues.legacy[0]]: { sample: 'value' }
        });
        workspaceState = createMockMemento({
            [compatibilityStateKeys.favoritesIncludeOnce.legacy[0]]: true
        });
        secrets = createMockSecretStorage({
            [compatibilitySecretKeys.connections.legacyRead[0]]: '{"connections":[]}'
        });

        const inspections = new Map<string, MockConfigurationInspection | undefined>([
            [
                'justybase.sql.showHoverTooltips',
                createInspection('justybase.sql.showHoverTooltips')
            ],
            [
                'netezza.sql.showHoverTooltips',
                createInspection('netezza.sql.showHoverTooltips', { workspaceValue: false })
            ],
            [
                'justybase.query.executionTimeout',
                createInspection('justybase.query.executionTimeout')
            ],
            [
                'netezza.query.executionTimeout',
                createInspection('netezza.query.executionTimeout', { globalLanguageValue: 45 })
            ]
        ]);

        rootConfiguration = {
            get: jest.fn(),
            update: jest.fn(() => Promise.resolve()),
            inspect: jest.fn((key: string) => inspections.get(key))
        } as unknown as jest.Mocked<vscode.WorkspaceConfiguration>;

        const workspaceApi = vscode.workspace as unknown as {
            workspaceFolders?: { uri: { fsPath: string } }[];
            getConfiguration: jest.Mock;
        };
        workspaceApi.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
        workspaceApi.getConfiguration.mockImplementation(() => rootConfiguration);

        (fs.existsSync as unknown as jest.Mock).mockImplementation(
            (candidate: fs.PathLike) => candidate === legacyFavoritesPath
        );
        (fs.mkdirSync as unknown as jest.Mock).mockReturnValue(undefined);
        (fs.copyFileSync as unknown as jest.Mock).mockReturnValue(undefined);

        context = {
            subscriptions: [],
            workspaceState,
            globalState,
            secrets,
            extensionPath: '',
            storagePath: '',
            globalStoragePath: '',
            logPath: '',
            extensionUri: undefined,
            storageUri: undefined,
            globalStorageUri: undefined,
            logUri: undefined,
            environmentVariableCollection: undefined,
            extensionMode: 1,
            asAbsolutePath: (relativePath: string) => relativePath,
            extension: {
                packageJSON: {
                    contributes: {
                        configuration: {
                            properties: {
                                'justybase.sql.showHoverTooltips': { type: 'boolean' },
                                'netezza.sql.showHoverTooltips': { type: 'boolean' },
                                'justybase.query.executionTimeout': { type: 'number' },
                                'netezza.query.executionTimeout': { type: 'number' }
                            }
                        }
                    }
                }
            } as unknown as vscode.Extension<unknown>
        } as unknown as vscode.ExtensionContext;
    });

    it('migrates legacy state, secrets, settings, and workspace files', async () => {
        const logger = {
            info: jest.fn(),
            warn: jest.fn()
        } as unknown as Logger;

        await runCompatibilityMigrations(context, logger);

        expect(globalState.values[compatibilityStateKeys.activeConnection.current]).toBe('LegacyConnection');
        expect(globalState.values[compatibilityStateKeys.variableValues.current]).toEqual({ sample: 'value' });
        expect(workspaceState.values[compatibilityStateKeys.favoritesIncludeOnce.current]).toBe(true);
        expect(globalState.values[compatibilityStateKeys.compatibilityMigrationVersion.current]).toBe(1);

        expect(secrets.store).toHaveBeenCalledWith(
            compatibilitySecretKeys.connections.current,
            '{"connections":[]}'
        );

        expect(rootConfiguration.update).toHaveBeenCalledWith(
            'justybase.sql.showHoverTooltips',
            false,
            vscode.ConfigurationTarget.Workspace,
            undefined
        );
        expect(rootConfiguration.update).toHaveBeenCalledWith(
            'justybase.query.executionTimeout',
            45,
            vscode.ConfigurationTarget.Global,
            true
        );

        expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(currentFavoritesPath), { recursive: true });
        expect(fs.copyFileSync).toHaveBeenCalledWith(legacyFavoritesPath, currentFavoritesPath);
        expect((logger as unknown as { info: jest.Mock }).info).toHaveBeenCalledWith(
            expect.stringContaining('Compatibility migrations applied')
        );
        expect((logger as unknown as { warn: jest.Mock }).warn).not.toHaveBeenCalled();
    });

it('skips configuration migration gracefully when inspect/update are unavailable', async () => {
	const workspaceApi = vscode.workspace as unknown as {
		workspaceFolders?: { uri: { fsPath: string } }[];
		getConfiguration: jest.Mock;
	};
	workspaceApi.workspaceFolders = undefined;
	workspaceApi.getConfiguration.mockReturnValue({} as vscode.WorkspaceConfiguration);

	await expect(runCompatibilityMigrations(context)).resolves.toBeUndefined();
	expect(globalState.values[compatibilityStateKeys.compatibilityMigrationVersion.current]).toBe(1);
});

    it('skips configuration aliases that do not have a registered justybase target', async () => {
        const inspections = new Map<string, MockConfigurationInspection | undefined>([
            [
                'justybase.linter.enabled',
                undefined
            ],
            [
                'netezza.linter.enabled',
                createInspection('netezza.linter.enabled', { workspaceValue: true })
            ]
        ]);

        rootConfiguration.inspect.mockImplementation((key: string) => inspections.get(key));

        context = {
            ...context,
            extension: {
                packageJSON: {
                    contributes: {
                        configuration: {
                            properties: {
                                'justybase.sql.showHoverTooltips': { type: 'boolean' },
                                'netezza.sql.showHoverTooltips': { type: 'boolean' },
                                'netezza.linter.enabled': { type: 'boolean' }
                            }
                        }
                    }
                }
            } as unknown as vscode.Extension<unknown>
        } as vscode.ExtensionContext;

        await expect(runCompatibilityMigrations(context)).resolves.toBeUndefined();

        expect(rootConfiguration.update).not.toHaveBeenCalled();
        expect(globalState.values[compatibilityStateKeys.compatibilityMigrationVersion.current]).toBe(1);
    });

    it('logs and skips configuration migration failures instead of rejecting activation', async () => {
        const logger = {
            info: jest.fn(),
            warn: jest.fn()
        } as unknown as Logger;

        rootConfiguration.update.mockImplementationOnce(async () => {
            throw new Error('unexpected configuration write failure');
        });

        await expect(runCompatibilityMigrations(context, logger)).resolves.toBeUndefined();

        expect((logger as unknown as { warn: jest.Mock }).warn).toHaveBeenCalledWith(
            expect.stringContaining('Compatibility migration skipped setting alias: failed to migrate')
        );
        expect(globalState.values[compatibilityStateKeys.compatibilityMigrationVersion.current]).toBe(1);
    });
});
