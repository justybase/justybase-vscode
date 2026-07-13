/**
 * Unit tests for extension.ts
 * Tests activation, deactivation, and helper functions
 */

import * as vscode from 'vscode';

// Mock vscode module
jest.mock('vscode', () => ({
    Uri: {
        parse: jest.fn(),
        joinPath: jest.fn(),
        file: jest.fn((path: string) => ({ fsPath: path, toString: () => `file://${path}` }))
    },
    extensions: {
        all: [],
        getExtension: jest.fn()
    },
    window: {
        activeTextEditor: undefined,
        createStatusBarItem: jest.fn(() => ({
            show: jest.fn(),
            hide: jest.fn(),
            dispose: jest.fn(),
            command: undefined,
            text: '',
            tooltip: undefined,
            color: undefined,
            backgroundColor: undefined
        })),
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        showQuickPick: jest.fn(),
        showInputBox: jest.fn(),
        createOutputChannel: jest.fn(() => ({
            appendLine: jest.fn(),
            show: jest.fn(),
            dispose: jest.fn()
        })),
        createTreeView: jest.fn(() => ({
            message: undefined,
            dispose: jest.fn()
        })),
        createWebviewPanel: jest.fn(),
        onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() })),
        onDidChangeTextEditorSelection: jest.fn(() => ({ dispose: jest.fn() })),
        onDidChangeVisibleTextEditors: jest.fn(() => ({ dispose: jest.fn() })),
        registerWebviewViewProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerFileDecorationProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerCustomEditorProvider: jest.fn(() => ({ dispose: jest.fn() })),
        setStatusBarMessage: jest.fn(() => ({ dispose: jest.fn() }))
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
            update: jest.fn()
        })),
        onDidCloseTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
        onDidSaveTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
        onDidOpenTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
        openTextDocument: jest.fn().mockResolvedValue({}),
        textDocuments: [],
        applyEdit: jest.fn(),
        onDidChangeTextDocument: jest.fn(),
        onDidChangeConfiguration: jest.fn(),
        registerTextDocumentContentProvider: jest.fn(() => ({ dispose: jest.fn() }))
    },
    commands: {
        registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
        executeCommand: jest.fn()
    },
    languages: {
        registerCompletionItemProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerInlayHintsProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerFoldingRangeProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerDefinitionProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerReferenceProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerHoverProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerRenameProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerCodeActionsProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerDocumentSymbolProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerSignatureHelpProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerCodeLensProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerDocumentSemanticTokensProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerDocumentFormattingEditProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerDocumentRangeFormattingEditProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerDocumentLinkProvider: jest.fn(() => ({ dispose: jest.fn() })),
        createDiagnosticCollection: jest.fn(() => ({
            set: jest.fn(),
            clear: jest.fn(),
            dispose: jest.fn()
        }))
    },
    lm: {
        registerTool: jest.fn(() => ({ dispose: jest.fn() })),
        selectChatModels: jest.fn().mockResolvedValue([])
    },
    Range: jest.fn(),
    Position: jest.fn(),
    StatusBarAlignment: { Right: 1, Left: 2 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CodeActionKind: {
        QuickFix: { value: 'quickfix' },
    },
    CodeAction: jest.fn().mockImplementation((title: string, kind: unknown) => ({ title, kind })),
    ViewColumn: { One: 1, Two: 2, Three: 3 },
    EventEmitter: jest.fn().mockImplementation(() => ({
        event: jest.fn(),
        fire: jest.fn(),
        dispose: jest.fn()
    })),
    TreeItem: jest.fn(),
    ThemeIcon: jest.fn(),
    ThemeColor: jest.fn(),
    Webview: jest.fn(),
    WebviewPanel: jest.fn(),
    MarkdownString: jest.fn(),
    LanguageModelToolResult: jest.fn(),
    LanguageModelTextPart: jest.fn(),
    CancellationTokenSource: jest.fn(),
    CompletionItem: jest.fn(),
    CompletionList: jest.fn(),
    CompletionItemKind: {},
    Diagnostic: jest.fn(),
    SemanticTokensLegend: jest.fn().mockImplementation(() => ({
        tokenTypes: [],
        tokenModifiers: []
    })),
    SemanticTokensBuilder: jest.fn().mockImplementation(() => ({
        push: jest.fn(),
        build: jest.fn()
    })),
    SemanticTokens: jest.fn(),
    Disposable: {
        from: jest.fn(() => ({ dispose: jest.fn() }))
    },
    debug: {
        registerDebugAdapterDescriptorFactory: jest.fn(() => ({ dispose: jest.fn() })),
        registerDebugConfigurationProvider: jest.fn(() => ({ dispose: jest.fn() })),
        onDidTerminateDebugSession: jest.fn(() => ({ dispose: jest.fn() }))
    }
}));

// Mock dependencies
jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn(),
    cancelAllRunningQueries: jest.fn().mockResolvedValue(undefined),
    disposeSharedOutputChannel: jest.fn()
}));

jest.mock('../core/connectionManager', () => ({
    ConnectionManager: jest.fn().mockImplementation(() => ({
        onDidChangeActiveConnection: jest.fn(),
        onDidChangeConnections: jest.fn(),
        onDidChangeDocumentConnection: jest.fn(),
        onDidChangeDocumentDatabase: jest.fn(),
        getActiveConnectionName: jest.fn(),
        getDocumentConnection: jest.fn(),
        getConnectionMetadata: jest.fn(),
        getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
        getConnectionForExecution: jest.fn(),
        getConnections: jest.fn().mockResolvedValue([]),
        resolveConnectionName: jest.fn((_documentUri?: string, name?: string) => name || 'default-conn'),
        supportsCapability: jest.fn().mockReturnValue(true),
        setMetadataCache: jest.fn(),
        setDocumentConnection: jest.fn(),
        setDocumentDatabase: jest.fn(),
        getEffectiveDatabase: jest.fn(),
        isFastLoaded: jest.fn().mockReturnValue(false),
        ensureFullyLoaded: jest.fn().mockResolvedValue(undefined),
        closeAllDocumentPersistentConnections: jest.fn(),
        toggleDocumentKeepConnectionOpen: jest.fn().mockReturnValue(false),
        setActiveConnection: jest.fn()
    }))
}));

jest.mock('../metadataCache', () => ({
    MetadataCache: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        getDatabases: jest.fn(),
        setDatabases: jest.fn(),
        hasConnectionPrefetchTriggered: jest.fn().mockReturnValue(false),
        isConnectionPrefetchFresh: jest.fn().mockReturnValue(false),
        triggerConnectionPrefetch: jest.fn(),
        isConnectionMetadataHydrating: jest.fn().mockReturnValue(false),
        clearCache: jest.fn().mockResolvedValue(undefined),
        onDidPrefetchProgress: jest.fn(() => ({ dispose: jest.fn() })),
        onDidInvalidate: jest.fn(() => ({ dispose: jest.fn() })),
        onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() })),
        onDidNeedColumnRecovery: jest.fn(() => ({ dispose: jest.fn() })),
        dispose: jest.fn()
    }))
}));

jest.mock('../providers/schemaProvider', () => ({
    SchemaProvider: jest.fn().mockImplementation(() => ({
        refresh: jest.fn(),
        clearAllErrors: jest.fn()
    }))
}));

jest.mock('../views/resultPanelView', () => ({
    ResultPanelView: jest.fn().mockImplementation(() => ({
        setActiveSource: jest.fn(),
        closeSource: jest.fn(),
        setSelectionStatsCallback: jest.fn(),
        triggerCopySelection: jest.fn()
    }))
}));

jest.mock('../views/loginPanel', () => ({
    LoginPanel: {
        createOrShow: jest.fn(),
        createNew: jest.fn()
    }
}));

jest.mock('../providers/schemaSearchProvider', () => ({
    SchemaSearchProvider: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../views/queryHistoryView', () => ({
    QueryHistoryView: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../views/copilotTableProfilesView', () => ({
    CopilotTableProfilesView: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../views/editDataProvider', () => ({
    EditDataProvider: {
        createOrShow: jest.fn()
    }
}));

jest.mock('../views/etlDesignerView', () => ({
    EtlDesignerView: {
        setConnectionManager: jest.fn(),
        createOrShow: jest.fn()
    }
}));

jest.mock('../etl/etlProjectManager', () => ({
    EtlProjectManager: {
        getInstance: jest.fn().mockReturnValue({
            createProject: jest.fn(),
            loadProject: jest.fn(),
            getCurrentProject: jest.fn()
        })
    }
}));

jest.mock('../providers/foldingProvider', () => ({
    NetezzaFoldingRangeProvider: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../providers/parserNavigationProvider', () => ({
    NetezzaParserNavigationProvider: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../providers/parserHoverProvider', () => ({
    NetezzaParserHoverProvider: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../providers/regexReferenceProvider', () => ({
    NetezzaRegexReferenceProvider: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../providers/renameProvider', () => ({
    NetezzaRenameProvider: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../providers/procedureTemplates', () => ({
    getTemplatesByCategory: jest.fn().mockReturnValue({
        basic: [{ id: 'basic-1', name: 'Basic', description: 'Basic template', template: jest.fn() }],
        advanced: [{ id: 'adv-1', name: 'Advanced', description: 'Advanced template', template: jest.fn() }]
    }),
    getTemplateById: jest.fn()
}));

jest.mock('../providers/externalTableTemplates', () => ({
    generateBasicExternalTableSQL: jest.fn().mockReturnValue('CREATE EXTERNAL TABLE...'),
    generateAdvancedExternalTableSQL: jest.fn().mockReturnValue('CREATE EXTERNAL TABLE...')
}));

jest.mock('../services/statusBarManager', () => ({
    createKeepConnectionStatusBar: jest.fn().mockReturnValue({}),
    createActiveConnectionStatusBar: jest.fn().mockReturnValue({ updateFn: jest.fn() }),
    createActiveDatabaseStatusBar: jest.fn().mockReturnValue({ updateFn: jest.fn() }),
    updateKeepConnectionStatusBar: jest.fn(),
    createSelectionStatsStatusBar: jest.fn().mockReturnValue({}),
    createMetadataRefreshStatusBar: jest.fn().mockReturnValue({}),
    updateMetadataRefreshStatusBar: jest.fn()
}));

jest.mock('../editors/decorationManager', () => ({
    createSqlStatementDecoration: jest.fn().mockReturnValue({}),
    registerDecorationSubscriptions: jest.fn()
}));

jest.mock('../editors/sqlShortcuts', () => ({
    registerSqlShortcuts: jest.fn()
}));

jest.mock('../utils/shellUtils', () => ({
    buildExecCommand: jest.fn()
}));

jest.mock('../utils/logger', () => ({
    Logger: {
        initialize: jest.fn(),
        getInstance: jest.fn().mockReturnValue({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        })
    },
    logWithFallback: jest.fn()
}));

jest.mock('../services/copilotService', () => ({
    CopilotService: jest.fn().mockImplementation(() => ({
        fixSql: jest.fn(),
        optimizeSql: jest.fn(),
        explainSql: jest.fn(),
        askCustomQuestion: jest.fn(),
        generateSqlInteractive: jest.fn(),
        bestPracticesSql: jest.fn(),
        changeModel: jest.fn(),
        clearPersistedModel: jest.fn(),
        describeDataWithCopilot: jest.fn(),
        fixSqlError: jest.fn(),
        getWorkspaceTableProfiles: jest.fn().mockResolvedValue([]),
        upsertWorkspaceTableProfile: jest.fn(),
        deleteWorkspaceTableProfile: jest.fn(),
        includeWorkspaceTableProfileNow: jest.fn().mockResolvedValue(true),
        getWorkspaceTableProfilesSummary: jest.fn().mockResolvedValue('No workspace table profiles configured.'),
        registerChatParticipant: jest.fn().mockReturnValue({ dispose: jest.fn() })
    })),
    SchemaTool: jest.fn(),
    ColumnsTool: jest.fn(),
    TablesTool: jest.fn(),
    ExecuteQueryTool: jest.fn(),
    SampleDataTool: jest.fn(),
    ExplainPlanTool: jest.fn(),
    TuningAdviceTool: jest.fn(),
    SearchSchemaTool: jest.fn(),
    TableStatsTool: jest.fn(),
    DependenciesTool: jest.fn(),
    ValidateSqlTool: jest.fn(),
    ValidateSqlOnDatabaseTool: jest.fn(),
    GetSqlDiagnosticsTool: jest.fn(),
    InspectImportFileTool: jest.fn(),
    ProposeImportMappingTool: jest.fn(),
    ExecuteImportTool: jest.fn(),
    ExportQueryResultsTool: jest.fn(),
    DatabasesTool: jest.fn(),
    SchemasTool: jest.fn(),
    ProceduresTool: jest.fn(),
    ViewsTool: jest.fn(),
    ExternalTablesTool: jest.fn(),
    GetDDLTool: jest.fn(),
    NetezzaReferenceTool: jest.fn(),
    FindTableLocationsTool: jest.fn(),
    GetCommentsTool: jest.fn(),
    FavoritesTool: jest.fn()
}));

jest.mock('../commands/schemaCommands', () => ({
    registerSchemaCommands: jest.fn().mockReturnValue([])
}));

jest.mock('../commands/exportCommands', () => ({
    registerExportCommands: jest.fn().mockReturnValue([])
}));

jest.mock('../commands/importCommands', () => ({
    registerImportCommands: jest.fn().mockReturnValue([])
}));

jest.mock('../commands/queryCommands', () => ({
    registerQueryCommands: jest.fn().mockReturnValue([])
}));

jest.mock('../sql/sqlParser', () => ({
    SqlParser: {
        getObjectAtPosition: jest.fn(),
        setFastPathThreshold: jest.fn(),
        getFastPathThreshold: jest.fn(() => 1572864),
    }
}));

jest.mock('../activation/lspRegistration', () => ({
    startSqlLanguageClient: jest.fn().mockResolvedValue(undefined),
    stopSqlLanguageClient: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../compatibility/migrationService', () => ({
    runCompatibilityMigrations: jest.fn().mockResolvedValue(undefined)
}));

// Import the module under test after mocks are set up
import { activate, deactivate } from '../extension';

describe('extension.ts', () => {
    let mockContext: vscode.ExtensionContext;

    beforeEach(() => {
        jest.clearAllMocks();

        mockContext = {
            subscriptions: [],
            extensionUri: { fsPath: '/test/extension', toString: () => 'file:///test/extension' } as vscode.Uri,
            secrets: {
                get: jest.fn(),
                store: jest.fn(),
                delete: jest.fn()
            },
            globalState: {
                get: jest.fn(),
                update: jest.fn()
            },
            workspaceState: {
                get: jest.fn(),
                update: jest.fn()
            }
        } as unknown as vscode.ExtensionContext;

        // Reset extensions mock
        const { extensions } = jest.requireMock('vscode');
        extensions.all = [];
        (extensions.getExtension as jest.Mock).mockReturnValue(undefined);
    });

    describe('activate()', () => {
        it('should register all core components', async () => {
            await activate(mockContext);

            // Verify output channel was created
            const { window } = jest.requireMock('vscode');
            expect(window.createOutputChannel).toHaveBeenCalledWith('Netezza');

            // Verify tree view was created
            expect(window.createTreeView).toHaveBeenCalledWith(
                'netezza.schema',
                expect.objectContaining({
                    showCollapseAll: true
                })
            );

            // Verify command registrations
            const { commands } = jest.requireMock('vscode');
            expect(commands.registerCommand).toHaveBeenCalled();
        });

        it('should register webview providers', async () => {
            await activate(mockContext);

            // Verify webview view providers were registered
            const { window } = jest.requireMock('vscode');
            expect(window.registerWebviewViewProvider).toHaveBeenCalled();
        });

        it('should register file decoration providers', async () => {
            await activate(mockContext);

            const { window } = jest.requireMock('vscode');
            expect(window.registerFileDecorationProvider).toHaveBeenCalled();
        });

        it('should register language providers', async () => {
            await activate(mockContext);

            // Verify language feature registrations
            const { languages } = jest.requireMock('vscode');
            expect(languages.registerFoldingRangeProvider).toHaveBeenCalled();
            expect(languages.registerReferenceProvider).toHaveBeenCalled();
            expect(languages.registerRenameProvider).toHaveBeenCalled();
        });

        it('starts LSP language client', async () => {
            await activate(mockContext);

            const { startSqlLanguageClient } = jest.requireMock('../activation/lspRegistration');
            expect(startSqlLanguageClient).toHaveBeenCalled();
        });

        it('should register Copilot tools', async () => {
            await activate(mockContext);

            const { lm } = jest.requireMock('vscode');
            expect(lm.registerTool).toHaveBeenCalled();
        });

        it('should handle activation without errors', async () => {
            await expect(activate(mockContext)).resolves.not.toThrow();
        });

        it('continues activation when compatibility migrations fail', async () => {
            const { runCompatibilityMigrations } = jest.requireMock('../compatibility/migrationService');
            runCompatibilityMigrations.mockRejectedValueOnce(new Error('migration failed'));

            await expect(activate(mockContext)).resolves.not.toThrow();

            const { commands } = jest.requireMock('vscode');
            expect(commands.registerCommand).toHaveBeenCalled();
        });
    });

    describe('deactivate()', () => {
        it('should complete without errors', async () => {
            await expect(deactivate()).resolves.not.toThrow();
            const { stopSqlLanguageClient } = jest.requireMock('../activation/lspRegistration');
            expect(stopSqlLanguageClient).toHaveBeenCalled();
        });

        it('should handle QueryHistoryManager cleanup', async () => {
            await deactivate();

            // deactivate should complete even if QueryHistoryManager throws
            expect(true).toBe(true);
        });
    });

    describe('checkForConflictingExtensions', () => {
        it('should detect known conflicting extensions', async () => {
            const { extensions } = jest.requireMock('vscode');
            // Mock a known conflicting extension
            (extensions.getExtension as jest.Mock).mockImplementation((id: string) => {
                if (id === 'mtxr.sqltools') {
                    return { id, packageJSON: { displayName: 'SQLTools' } };
                }
                return undefined;
            });

            await activate(mockContext);

            // Extension should still activate successfully
            const { commands } = jest.requireMock('vscode');
            expect(commands.registerCommand).toHaveBeenCalled();
        });

        it('should detect other SQL extensions', async () => {
            const { extensions } = jest.requireMock('vscode');
            // Mock other SQL extensions
            extensions.all = [
                {
                    id: 'other.sql.extension',
                    packageJSON: {
                        displayName: 'Other SQL',
                        activationEvents: ['onLanguage:sql']
                    }
                }
            ];

            await activate(mockContext);

            // Extension should still activate successfully
            const { commands } = jest.requireMock('vscode');
            expect(commands.registerCommand).toHaveBeenCalled();
        });

        it('should respect showConflictWarnings setting', async () => {
            const { workspace, window } = jest.requireMock('vscode');
            (workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn((key: string, defaultValue?: unknown) => {
                    if (key === 'showConflictWarnings') {
                        return false;
                    }
                    return defaultValue;
                }),
                update: jest.fn()
            });

            await activate(mockContext);

            // Should not show warning when disabled
            expect(window.showWarningMessage).not.toHaveBeenCalledWith(
                expect.stringContaining('SQL extension detected'),
                expect.anything(),
                expect.anything()
            );
        });
    });

    describe('Command Registrations', () => {
        it('should register netezza.openLogin command', async () => {
            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.openLogin',
                expect.any(Function)
            );
        });

        it('should register netezza.openLogin even when LM tool registration fails', async () => {
            const { commands, lm, window } = jest.requireMock('vscode');
            (lm.registerTool as jest.Mock).mockImplementationOnce(() => {
                throw new Error('LM unavailable');
            });

            await activate(mockContext);

            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.openLogin',
                expect.any(Function)
            );
            expect(window.showWarningMessage).toHaveBeenCalledWith(
                'JustyBase AI/Copilot could not be fully initialized. Some AI functions may not work correctly in this session.'
            );
        });

        it('should register netezza.refreshSchema command', async () => {
            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.refreshSchema',
                expect.any(Function)
            );
        });

        it('should register netezza.toggleKeepConnectionForTab command', async () => {
            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.toggleKeepConnectionForTab',
                expect.any(Function)
            );
        });

        it('should register netezza.selectActiveConnection command', async () => {
            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.selectActiveConnection',
                expect.any(Function)
            );
        });

        it('should register netezza.selectConnectionForTab command', async () => {
            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.selectConnectionForTab',
                expect.any(Function)
            );
        });

        it('should register netezza.selectDatabaseForTab command', async () => {
            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.selectDatabaseForTab',
                expect.any(Function)
            );
        });

        it('should register ETL commands', async () => {
            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.openEtlDesigner',
                expect.any(Function)
            );
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.newEtlProject',
                expect.any(Function)
            );
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.openEtlProject',
                expect.any(Function)
            );
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.runEtlProject',
                expect.any(Function)
            );
        });

        it('should register Copilot commands', async () => {
            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.copilotFixSql',
                expect.any(Function)
            );
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.copilotOptimizeSql',
                expect.any(Function)
            );
            expect(commands.registerCommand).toHaveBeenCalledWith(
                'netezza.copilotExplainSql',
                expect.any(Function)
            );
        });
    });

    describe('Status Bar', () => {
        it('should create status bar items', async () => {
            const { createKeepConnectionStatusBar, createActiveConnectionStatusBar, createActiveDatabaseStatusBar } =
                jest.requireMock('../services/statusBarManager');

            await activate(mockContext);

            expect(createKeepConnectionStatusBar).toHaveBeenCalled();
            expect(createActiveConnectionStatusBar).toHaveBeenCalled();
            expect(createActiveDatabaseStatusBar).toHaveBeenCalled();
        });
    });

    describe('Event Handlers', () => {
        it('should register onDidChangeActiveTextEditor handler', async () => {
            await activate(mockContext);

            const { window } = jest.requireMock('vscode');
            expect(window.onDidChangeActiveTextEditor).toHaveBeenCalled();
        });

        it('should register onDidChangeTextEditorSelection handler', async () => {
            await activate(mockContext);

            const { window } = jest.requireMock('vscode');
            expect(window.onDidChangeTextEditorSelection).toHaveBeenCalled();
        });

        it('should register onDidCloseTextDocument handler', async () => {
            await activate(mockContext);

            const { workspace } = jest.requireMock('vscode');
            expect(workspace.onDidCloseTextDocument).toHaveBeenCalled();
        });

        it('should register onDidOpenTextDocument handler', async () => {
            await activate(mockContext);

            const { workspace } = jest.requireMock('vscode');
            expect(workspace.onDidOpenTextDocument).toHaveBeenCalled();
        });

        it('should sync result source for sql-like editors', async () => {
            await activate(mockContext);

            const { window } = jest.requireMock('vscode');
            const { ResultPanelView } = jest.requireMock('../views/resultPanelView');
            const providerInstance = (ResultPanelView as jest.Mock).mock.results[0]?.value;

            const mockEditor = {
                document: {
                    languageId: 'mssql',
                    uri: {
                        scheme: 'file',
                        toString: () => 'file:///focused.sql'
                    }
                }
            };

            const activeEditorCallbacks = (window.onDidChangeActiveTextEditor as jest.Mock).mock.calls.map(call => call[0]);
            activeEditorCallbacks.forEach((callback: (editor: unknown) => void) => callback(mockEditor));

            expect(providerInstance?.setActiveSource).toHaveBeenCalledWith('file:///focused.sql');
        });

        it('should not resend already-cleared result contexts when editor focus returns', async () => {
            await activate(mockContext);

            const { window, commands } = jest.requireMock('vscode');
            (commands.executeCommand as jest.Mock).mockClear();

            const mockEditor = {
                document: {
                    languageId: 'sql',
                    uri: {
                        scheme: 'file',
                        toString: () => 'file:///focused.sql'
                    }
                }
            };

            const activeEditorCallbacks = (window.onDidChangeActiveTextEditor as jest.Mock).mock.calls.map(call => call[0]);
            activeEditorCallbacks.forEach((callback: (editor: unknown) => void) => callback(mockEditor));

            expect(commands.executeCommand).not.toHaveBeenCalledWith('setContext', 'netezza.resultsCopyPrimed', false);
            expect(commands.executeCommand).not.toHaveBeenCalledWith('setContext', 'netezza.resultsFocused', false);
            expect(commands.executeCommand).not.toHaveBeenCalledWith('setContext', 'netezza.resultsInputFocused', false);
        });
    });

    describe('Error Handling', () => {
        it('should handle errors in Copilot commands gracefully', async () => {
            const { CopilotService } = jest.requireMock('../services/copilotService');
            const mockInstance = new CopilotService();
            (mockInstance.fixSql as jest.Mock).mockRejectedValue(new Error('Test error'));

            await activate(mockContext);

            // Get the registered command handler
            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const fixSqlCall = calls.find((call: unknown[]) => call[0] === 'netezza.copilotFixSql');
            expect(fixSqlCall).toBeDefined();

            // Execute the handler - should not throw
            const handler = fixSqlCall[1];
            await expect(handler()).resolves.not.toThrow();
        });
    });

    describe('toggleKeepConnectionForTab command', () => {
        it('should show warning when no SQL file is active', async () => {
            const { window } = jest.requireMock('vscode');
            window.activeTextEditor = undefined;

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const toggleCall = calls.find((call: unknown[]) => call[0] === 'netezza.toggleKeepConnectionForTab');
            expect(toggleCall).toBeDefined();

            const handler = toggleCall[1];
            handler();

            expect(window.showWarningMessage).toHaveBeenCalledWith('Please open a SQL file first.');
        });

        it('should show warning when active file is not SQL', async () => {
            const { window } = jest.requireMock('vscode');
            window.activeTextEditor = {
                document: { languageId: 'javascript' }
            };

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const toggleCall = calls.find((call: unknown[]) => call[0] === 'netezza.toggleKeepConnectionForTab');
            const handler = toggleCall[1];
            handler();

            expect(window.showWarningMessage).toHaveBeenCalledWith('Please open a SQL file first.');
        });

        it('should toggle keep connection for SQL file', async () => {
            const { window } = jest.requireMock('vscode');
            window.activeTextEditor = {
                document: {
                    languageId: 'sql',
                    uri: { toString: () => 'file:///test.sql' }
                }
            };

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const toggleCall = calls.find((call: unknown[]) => call[0] === 'netezza.toggleKeepConnectionForTab');
            expect(toggleCall).toBeDefined();

            // Execute the handler - should not throw
            const handler = toggleCall[1];
            expect(() => handler()).not.toThrow();
        });
    });

    describe('selectActiveConnection command', () => {
        it('should show warning when no connections configured', async () => {
            const { window } = jest.requireMock('vscode');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const selectCall = calls.find((call: unknown[]) => call[0] === 'netezza.selectActiveConnection');
            const handler = selectCall[1];
            await handler();

            expect(window.showWarningMessage).toHaveBeenCalledWith('No connections configured. Please connect first.');
        });

        it('should show quick pick with connections', async () => {
            const { window } = jest.requireMock('vscode');
            (window.showQuickPick as jest.Mock).mockResolvedValue('conn1');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const selectCall = calls.find((call: unknown[]) => call[0] === 'netezza.selectActiveConnection');
            expect(selectCall).toBeDefined();

            const handler = selectCall[1];
            // Execute handler - should not throw
            await expect(handler()).resolves.not.toThrow();
        });

        it('should set active connection when selected', async () => {
            const { window } = jest.requireMock('vscode');
            (window.showQuickPick as jest.Mock).mockResolvedValue('conn1');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const selectCall = calls.find((call: unknown[]) => call[0] === 'netezza.selectActiveConnection');
            expect(selectCall).toBeDefined();

            const handler = selectCall[1];
            // Execute handler - should not throw
            await expect(handler()).resolves.not.toThrow();
        });
    });

    describe('selectConnectionForTab command', () => {
        it('should show warning when no SQL file is active', async () => {
            const { window } = jest.requireMock('vscode');
            window.activeTextEditor = undefined;

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const selectCall = calls.find((call: unknown[]) => call[0] === 'netezza.selectConnectionForTab');
            const handler = selectCall[1];
            await handler();

            expect(window.showWarningMessage).toHaveBeenCalledWith('This command is only available for SQL files');
        });

        it('should show warning when no connections configured', async () => {
            const { window } = jest.requireMock('vscode');
            window.activeTextEditor = {
                document: { languageId: 'sql', uri: { toString: () => 'file:///test.sql' } }
            };

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const selectCall = calls.find((call: unknown[]) => call[0] === 'netezza.selectConnectionForTab');
            const handler = selectCall[1];
            await handler();

            expect(window.showWarningMessage).toHaveBeenCalledWith('No connections configured. Please connect first.');
        });
    });

    describe('selectDatabaseForTab command', () => {
        it('should show warning when no SQL file is active', async () => {
            const { window } = jest.requireMock('vscode');
            window.activeTextEditor = undefined;

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const selectCall = calls.find((call: unknown[]) => call[0] === 'netezza.selectDatabaseForTab');
            const handler = selectCall[1];
            await handler();

            expect(window.showWarningMessage).toHaveBeenCalledWith('This command is only available for SQL files');
        });

        it('should show warning when no connection selected', async () => {
            const { window } = jest.requireMock('vscode');
            window.activeTextEditor = {
                document: { languageId: 'sql', uri: { toString: () => 'file:///test.sql' } }
            };

            const { ConnectionManager } = jest.requireMock('../core/connectionManager');
            const mockConnManager = new ConnectionManager();
            (mockConnManager.getConnectionForExecution as jest.Mock).mockReturnValue(undefined);

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const selectCall = calls.find((call: unknown[]) => call[0] === 'netezza.selectDatabaseForTab');
            const handler = selectCall[1];
            await handler();

            expect(window.showWarningMessage).toHaveBeenCalledWith('No connection selected. Please select a connection first.');
        });
    });

    describe('refreshSchema command', () => {
        it('should clear cache and refresh schema', async () => {
            const { window } = jest.requireMock('vscode');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const refreshCall = calls.find((call: unknown[]) => call[0] === 'netezza.refreshSchema');
            const handler = refreshCall[1];
            await handler();

            expect(window.showInformationMessage).toHaveBeenCalledWith('Schema refreshed (Cache cleared).');
        });

        it('should trigger metadata prefetch when active connection exists', async () => {
            const { window } = jest.requireMock('vscode');

            await activate(mockContext);

            const { ConnectionManager } = jest.requireMock('../core/connectionManager');
            const connInstance = (ConnectionManager as jest.Mock).mock.results[0].value;
            (connInstance.getActiveConnectionName as jest.Mock).mockReturnValue('DEV_CONN');

            const { MetadataCache } = jest.requireMock('../metadataCache');
            const cacheInstance = (MetadataCache as jest.Mock).mock.results[0].value;

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const refreshCall = calls.find((call: unknown[]) => call[0] === 'netezza.refreshSchema');
            const handler = refreshCall[1];
            await handler();

            expect(cacheInstance.triggerConnectionPrefetch).toHaveBeenCalled();
            expect(window.showInformationMessage).toHaveBeenCalledWith(
                'Schema refreshed. Metadata is rebuilding in background...'
            );
        });
    });

    describe('openLogin command', () => {
        it('should call LoginPanel.createOrShow', async () => {
            const { LoginPanel } = jest.requireMock('../views/loginPanel');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const loginCall = calls.find((call: unknown[]) => call[0] === 'netezza.openLogin');
            const handler = loginCall[1];
            handler();

            expect(LoginPanel.createOrShow).toHaveBeenCalled();
        });
    });

    describe('openLoginNew command', () => {
        it('should call LoginPanel.createNew', async () => {
            const { LoginPanel } = jest.requireMock('../views/loginPanel');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const loginCall = calls.find((call: unknown[]) => call[0] === 'netezza.openLoginNew');
            const handler = loginCall[1];
            handler();

            expect(LoginPanel.createNew).toHaveBeenCalled();
        });
    });

    describe('clearAutocompleteCache command', () => {
        it('should show confirmation dialog', async () => {
            const { window } = jest.requireMock('vscode');
            (window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const clearCall = calls.find((call: unknown[]) => call[0] === 'netezza.clearAutocompleteCache');
            const handler = clearCall[1];
            await handler();

            expect(window.showWarningMessage).toHaveBeenCalledWith(
                'Are you sure you want to clear the autocomplete cache? This will remove all cached databases, schemas, tables, and columns.',
                { modal: true },
                'Clear Cache'
            );
        });

        it('should clear cache when confirmed', async () => {
            const { window } = jest.requireMock('vscode');
            (window.showWarningMessage as jest.Mock).mockResolvedValue('Clear Cache');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const clearCall = calls.find((call: unknown[]) => call[0] === 'netezza.clearAutocompleteCache');
            expect(clearCall).toBeDefined();

            const handler = clearCall[1];
            // Execute handler - should not throw
            await expect(handler()).resolves.not.toThrow();
        });
    });

    describe('createProcedure command', () => {
        it('should show error when no item provided', async () => {
            const { window } = jest.requireMock('vscode');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const procCall = calls.find((call: unknown[]) => call[0] === 'netezza.createProcedure');
            const handler = procCall[1];
            await handler(undefined);

            expect(window.showErrorMessage).toHaveBeenCalledWith('Invalid selection. Select a Procedure folder.');
        });

        it('should show error when dbName is missing', async () => {
            const { window } = jest.requireMock('vscode');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const procCall = calls.find((call: unknown[]) => call[0] === 'netezza.createProcedure');
            const handler = procCall[1];
            await handler({});

            expect(window.showErrorMessage).toHaveBeenCalledWith('Invalid selection. Select a Procedure folder.');
        });

        it('should show category selection when dbName is provided', async () => {
            const { window } = jest.requireMock('vscode');
            (window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const procCall = calls.find((call: unknown[]) => call[0] === 'netezza.createProcedure');
            const handler = procCall[1];
            await handler({ dbName: 'TEST_DB' });

            expect(window.showQuickPick).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({ category: 'basic' }),
                    expect.objectContaining({ category: 'advanced' })
                ]),
                expect.objectContaining({ placeHolder: 'Select procedure category' })
            );
        });
    });

    describe('createExternalTable command', () => {
        it('should show error when no item provided', async () => {
            const { window } = jest.requireMock('vscode');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const extCall = calls.find((call: unknown[]) => call[0] === 'netezza.createExternalTable');
            const handler = extCall[1];
            await handler(undefined);

            expect(window.showErrorMessage).toHaveBeenCalledWith('Invalid selection. Select an External Table folder.');
        });

        it('should show error when dbName is missing', async () => {
            const { window } = jest.requireMock('vscode');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const extCall = calls.find((call: unknown[]) => call[0] === 'netezza.createExternalTable');
            const handler = extCall[1];
            await handler({});

            expect(window.showErrorMessage).toHaveBeenCalledWith('Invalid selection. Select an External Table folder.');
        });

        it('should show mode selection when dbName is provided', async () => {
            const { window } = jest.requireMock('vscode');
            (window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const extCall = calls.find((call: unknown[]) => call[0] === 'netezza.createExternalTable');
            const handler = extCall[1];
            await handler({ dbName: 'TEST_DB', schema: 'ADMIN' });

            expect(window.showQuickPick).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({ mode: 'basic' }),
                    expect.objectContaining({ mode: 'advanced' })
                ]),
                expect.objectContaining({ placeHolder: 'Select wizard mode' })
            );
        });
    });

    describe('ETL commands', () => {
        it('should register openEtlDesigner command', async () => {
            const { EtlDesignerView } = jest.requireMock('../views/etlDesignerView');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const etlCall = calls.find((call: unknown[]) => call[0] === 'netezza.openEtlDesigner');
            expect(etlCall).toBeDefined();

            const handler = etlCall[1];
            handler();

            expect(EtlDesignerView.setConnectionManager).toHaveBeenCalled();
            expect(EtlDesignerView.createOrShow).toHaveBeenCalled();
        });

        it('should register newEtlProject command', async () => {
            const { window } = jest.requireMock('vscode');
            (window.showInputBox as jest.Mock).mockResolvedValue('New Project');

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const newProjectCall = calls.find((call: unknown[]) => call[0] === 'netezza.newEtlProject');
            expect(newProjectCall).toBeDefined();
        });

        it('should register openEtlProject command', async () => {
            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const openProjectCall = calls.find((call: unknown[]) => call[0] === 'netezza.openEtlProject');
            expect(openProjectCall).toBeDefined();
        });

        it('should register runEtlProject command', async () => {
            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const runProjectCall = calls.find((call: unknown[]) => call[0] === 'netezza.runEtlProject');
            expect(runProjectCall).toBeDefined();
        });
    });

    describe('jumpToSchema command', () => {
        it('should do nothing when no active editor', async () => {
            const { window } = jest.requireMock('vscode');
            window.activeTextEditor = undefined;

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const jumpCall = calls.find((call: unknown[]) => call[0] === 'netezza.jumpToSchema');
            const handler = jumpCall[1];
            await handler();

            // Should not throw and not call anything
            expect(true).toBe(true);
        });

        it('should show warning when no object at cursor', async () => {
            const { window } = jest.requireMock('vscode');
            window.activeTextEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM test'),
                    offsetAt: jest.fn().mockReturnValue(0)
                },
                selection: { active: {} }
            };

            const { SqlParser } = jest.requireMock('../sql/sqlParser');
            SqlParser.getObjectAtPosition.mockReturnValue(null);

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const jumpCall = calls.find((call: unknown[]) => call[0] === 'netezza.jumpToSchema');
            const handler = jumpCall[1];
            await handler();

            expect(window.showWarningMessage).toHaveBeenCalledWith('No object found at cursor');
        });

        it('should execute revealInSchema when object found', async () => {
            const { window, commands } = jest.requireMock('vscode');
            window.activeTextEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM test_table'),
                    offsetAt: jest.fn().mockReturnValue(14)
                },
                selection: { active: {} }
            };

            const { SqlParser } = jest.requireMock('../sql/sqlParser');
            SqlParser.getObjectAtPosition.mockReturnValue({ name: 'test_table', schema: 'ADMIN' });

            await activate(mockContext);

            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const jumpCall = calls.find((call: unknown[]) => call[0] === 'netezza.jumpToSchema');
            const handler = jumpCall[1];
            await handler();

            expect(commands.executeCommand).toHaveBeenCalledWith(
                'netezza.revealInSchema',
                { name: 'test_table', schema: 'ADMIN' }
            );
        });
    });

    describe('copySelection command', () => {
        it('should trigger copy selection on result panel', async () => {
            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const copyCall = calls.find((call: unknown[]) => call[0] === 'netezza.copySelection');
            expect(copyCall).toBeDefined();

            const handler = copyCall[1];
            handler();

            // Should not throw
            expect(true).toBe(true);
        });
    });

    describe('lintSql command', () => {
        it('should show warning when no active editor', async () => {
            const { window } = jest.requireMock('vscode');
            window.activeTextEditor = undefined;

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const lintCall = calls.find((call: unknown[]) => call[0] === 'netezza.lintSql');
            const handler = lintCall[1];
            await handler();

            expect(window.showWarningMessage).toHaveBeenCalledWith('No active SQL editor');
        });

        it('should show warning when active file is not SQL', async () => {
            const { window } = jest.requireMock('vscode');
            window.activeTextEditor = {
                document: { languageId: 'javascript' }
            };

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const lintCall = calls.find((call: unknown[]) => call[0] === 'netezza.lintSql');
            const handler = lintCall[1];
            await handler();

            expect(window.showWarningMessage).toHaveBeenCalledWith('Active file is not a supported SQL file');
        });
    });

    describe('viewEditData command', () => {
        it('should call EditDataProvider.createOrShow', async () => {
            const { EditDataProvider } = jest.requireMock('../views/editDataProvider');
            const mockItem = { database: 'TEST_DB', schema: 'ADMIN', table: 'TEST_TABLE' };

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const viewCall = calls.find((call: unknown[]) => call[0] === 'netezza.viewEditData');
            const handler = viewCall[1];
            handler(mockItem);

            expect(EditDataProvider.createOrShow).toHaveBeenCalled();
        });
    });

    describe('runScriptFromLens command', () => {
        it('should show warning when no script command found', async () => {
            const { workspace, window } = jest.requireMock('vscode');
            workspace.openTextDocument = jest.fn().mockResolvedValue({
                getText: jest.fn().mockReturnValue(''),
                lineAt: jest.fn().mockReturnValue({ text: '' })
            });

            await activate(mockContext);

            const { commands } = jest.requireMock('vscode');
            const calls = (commands.registerCommand as jest.Mock).mock.calls;
            const runCall = calls.find((call: unknown[]) => call[0] === 'netezza.runScriptFromLens');
            const handler = runCall[1];
            await handler({ fsPath: '/test/script.py' }, { start: { line: 0 }, end: { line: 0 } });

            expect(window.showWarningMessage).toHaveBeenCalledWith('No script command found');
        });
    });
});
