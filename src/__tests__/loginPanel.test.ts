/**
 * Unit tests for LoginPanel
 * Tests webview panel creation, messaging, and connection management
 */

import * as vm from 'node:vm';
import * as vscode from 'vscode';
import { LoginPanel } from '../views/loginPanel';
import { ConnectionManager, ConnectionDetails } from '../core/connectionManager';

// We need to access private constructor via testing - use class to simulate behavior
describe('LoginPanel', () => {
    let mockConnectionManager: jest.Mocked<ConnectionManager>;
    let mockExtensionUri: vscode.Uri;
    let mockWebviewPanel: vscode.WebviewPanel;
    let messageHandler: ((message: unknown) => Promise<void>) | null = null;
    let disposeHandler: (() => void) | null = null;
    let connectionsChangedHandler: (() => void) | null = null;
    let activeConnectionChangedHandler: (() => void) | null = null;

    beforeEach(() => {
        jest.clearAllMocks();

        // Reset static state
        (LoginPanel as unknown as { currentPanel: undefined }).currentPanel = undefined;

        mockExtensionUri = {
            fsPath: '/test',
            toString: () => 'file:///test'
        } as vscode.Uri;

        // Mock ConnectionManager
        mockConnectionManager = {
            getConnections: jest.fn().mockResolvedValue([
                {
                    name: 'TestConnection',
                    host: 'localhost',
                    port: 5480,
                    database: 'TESTDB',
                    user: 'admin',
                    accentColor: 'blue'
                }
            ]),
            getConnection: jest.fn().mockResolvedValue(undefined),
            saveConnection: jest.fn().mockResolvedValue(undefined),
            deleteConnection: jest.fn().mockResolvedValue(undefined),
            testConnection: jest.fn().mockResolvedValue(undefined),
            getActiveConnectionName: jest.fn().mockReturnValue('TestConnection'),
            onDidChangeConnections: jest.fn((handler: () => void) => {
                connectionsChangedHandler = handler;
                return { dispose: jest.fn() };
            }),
            onDidChangeActiveConnection: jest.fn((handler: () => void) => {
                activeConnectionChangedHandler = handler;
                return { dispose: jest.fn() };
            })
        } as unknown as jest.Mocked<ConnectionManager>;

        // Mock webview panel
        mockWebviewPanel = {
            webview: {
                html: '',
                onDidReceiveMessage: jest.fn((handler) => {
                    messageHandler = handler;
                    return { dispose: jest.fn() };
                }),
                postMessage: jest.fn().mockResolvedValue(true),
                asWebviewUri: jest.fn((uri) => ({
                    toString: () => `webview-uri://${uri.fsPath}`
                }))
            },
            viewType: 'netezzaLogin',
            title: 'Connect to Database',
            visible: true,
            active: true,
            onDidDispose: jest.fn((handler) => {
                disposeHandler = handler;
                return { dispose: jest.fn() };
            }),
            onDidChangeViewState: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            reveal: jest.fn(),
            dispose: jest.fn()
        } as unknown as vscode.WebviewPanel;

        // Mock window.createWebviewPanel
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockWebviewPanel);
    });

    afterEach(() => {
        // Clean up static state
        (LoginPanel as unknown as { currentPanel: undefined }).currentPanel = undefined;
        messageHandler = null;
        disposeHandler = null;
        connectionsChangedHandler = null;
        activeConnectionChangedHandler = null;
    });

    describe('createOrShow', () => {
        it('should create new panel when none exists', () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);

            expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
                'netezzaLogin',
                'Connect to Database',
                expect.any(Number),
                expect.objectContaining({
                    enableScripts: true,
                    retainContextWhenHidden: true
                })
            );
            expect(LoginPanel.currentPanel).toBeDefined();
        });

        it('should reveal existing panel instead of creating new one', () => {
            // Create first panel
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);
            const firstCallCount = (vscode.window.createWebviewPanel as jest.Mock).mock.calls.length;

            // Try to create second panel
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);

            // Should not have created new panel
            expect((vscode.window.createWebviewPanel as jest.Mock).mock.calls.length).toBe(firstCallCount);
            expect(mockWebviewPanel.reveal).toHaveBeenCalled();
        });

        it('should create new panel when createNew is called even if panel exists', () => {
            // Create first panel
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);
            const firstCallCount = (vscode.window.createWebviewPanel as jest.Mock).mock.calls.length;

            // Call createNew - should create a new panel
            LoginPanel.createNew(mockExtensionUri, mockConnectionManager);

            // Should have created new panel
            expect((vscode.window.createWebviewPanel as jest.Mock).mock.calls.length).toBe(firstCallCount + 1);
            expect(mockWebviewPanel.dispose).toHaveBeenCalled();
        });

        it('should set HTML content with required elements', () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('Connect to Database');
            expect(html).toContain('Connection Name');
            expect(html).toContain('Host');
            expect(html).toContain('Port');
            expect(html).toContain('Database');
            expect(html).toContain('User');
            expect(html).toContain('Password');
            expect(html).toContain('Connection Accent');
            expect(html).toContain('value="sqlite">SQLite</option>');
            expect(html).toContain('value="red">Red</option>');
            expect(html).toContain('value="blue">Blue</option>');
            expect(html).toContain('Save & Connect');
        });

        it('should include dialect icon mappings in HTML', () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('netezza_icon64.png');
            expect(html).toContain('sqlite-dialect.svg');
        });

        it('should subscribe to connection and active-connection updates', () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);

            expect(mockConnectionManager.onDidChangeConnections).toHaveBeenCalled();
            expect(mockConnectionManager.onDidChangeActiveConnection).toHaveBeenCalled();
            expect(connectionsChangedHandler).toBeTruthy();
            expect(activeConnectionChangedHandler).toBeTruthy();
        });

        it('should refresh the webview when connection events fire', async () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);
            (mockWebviewPanel.webview.postMessage as jest.Mock).mockClear();

            connectionsChangedHandler?.();
            await Promise.resolve();

            expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith({
                command: 'updateConnections',
                connections: expect.any(Array),
                activeName: 'TestConnection'
            });
        });

        it('should generate a webview script that initializes without runtime errors', () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);

            const html = mockWebviewPanel.webview.html;
            const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
            expect(scriptMatch?.[1]).toBeTruthy();

            const postMessage = jest.fn();
            const eventHandlers = new Map<string, (event: { data: unknown }) => void>();

            interface FakeOptionElement {
                value: string;
                textContent: string;
            }

            interface FakeElement {
                value: string;
                innerHTML: string;
                options: FakeOptionElement[];
                dataset: Record<string, string>;
                title?: string;
                textContent?: string;
                placeholder?: string;
                readOnly?: boolean;
                style?: { backgroundColor?: string; display?: string };
                addEventListener: jest.Mock;
                appendChild: jest.Mock;
            }

            const elements: Record<string, FakeElement> = {
                accentColor: {
                    value: '',
                    innerHTML: '',
                    options: [
                        { value: '', textContent: 'None' },
                        { value: 'red', textContent: 'Red' }
                    ],
                    dataset: {},
                    addEventListener: jest.fn(),
                    appendChild: jest.fn()
                },
                accentPreview: {
                    value: '',
                    innerHTML: '',
                    options: [],
                    dataset: {},
                    title: '',
                    style: {},
                    addEventListener: jest.fn(),
                    appendChild: jest.fn()
                },
                dbType: {
                    value: 'netezza',
                    innerHTML: '',
                    options: [{ value: 'netezza', textContent: 'Netezza' }],
                    dataset: {},
                    addEventListener: jest.fn(),
                    appendChild: jest.fn()
                },
                formTitle: {
                    value: '',
                    innerHTML: '',
                    options: [],
                    dataset: {},
                    addEventListener: jest.fn(),
                    appendChild: jest.fn()
                },
                formSubtitle: {
                    value: '',
                    innerHTML: '',
                    options: [],
                    dataset: {},
                    textContent: '',
                    addEventListener: jest.fn(),
                    appendChild: jest.fn()
                },
                btnNew: {
                    value: '',
                    innerHTML: '',
                    options: [],
                    dataset: {},
                    addEventListener: jest.fn(),
                    appendChild: jest.fn()
                },
                connectionList: {
                    value: '',
                    innerHTML: '',
                    options: [],
                    dataset: {},
                    addEventListener: jest.fn(),
                    appendChild: jest.fn()
                },
                dialectFields: {
                    value: '',
                    innerHTML: '',
                    options: [],
                    dataset: {},
                    addEventListener: jest.fn(),
                    appendChild: jest.fn()
                }
            };

            expect(() => vm.runInNewContext(scriptMatch![1], {
                acquireVsCodeApi: () => ({ postMessage }),
                window: {
                    addEventListener: (eventName: string, handler: (event: { data: unknown }) => void) => {
                        eventHandlers.set(eventName, handler);
                    }
                },
                document: {
                    getElementById: (id: string) => elements[id] ?? null,
                    createElement: () => ({ value: '', textContent: '' })
                },
                console
            })).not.toThrow();

            expect(postMessage).toHaveBeenCalledWith({ command: 'loadConnections' });
            expect(eventHandlers.has('message')).toBe(true);
            expect(elements.formSubtitle.textContent).toBe('Netezza connection settings');
        });
    });

    describe('message handling', () => {
        beforeEach(() => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);
        });

        describe('save command', () => {
            it('should save connection via ConnectionManager', async () => {
                const connectionData: ConnectionDetails = {
                    name: 'NewConnection',
                    host: 'server.local',
                    port: 5480,
                    database: 'MYDB',
                    user: 'user1',
                    password: 'secret',
                    accentColor: 'purple'
                };

                await messageHandler!({ command: 'save', data: connectionData });

                expect(mockConnectionManager.saveConnection).toHaveBeenCalledWith(
                    expect.objectContaining({
                        ...connectionData,
                        dbType: 'netezza'
                    })
                );
                expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                    expect.stringContaining('NewConnection')
                );
            });

            it('should refresh connections list after save', async () => {
                const connectionData: ConnectionDetails = {
                    name: 'NewConnection',
                    host: 'server.local',
                    port: 5480,
                    database: 'MYDB',
                    user: 'user1',
                    password: 'secret'
                };

                await messageHandler!({ command: 'save', data: connectionData });

                // Should have called postMessage to update UI
                expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
                    expect.objectContaining({
                        command: 'updateConnections'
                    })
                );
            });

            it('should preserve the stored password when editing without changing it', async () => {
                mockConnectionManager.getConnection.mockResolvedValue({
                    name: 'ExistingConnection',
                    host: 'server.local',
                    port: 5480,
                    database: 'MYDB',
                    user: 'user1',
                    password: 'stored-secret',
                    dbType: 'netezza'
                } as ConnectionDetails);

                await messageHandler!({
                    command: 'save',
                    originalName: 'ExistingConnection',
                    passwordChanged: false,
                    data: {
                        name: 'ExistingConnection',
                        host: 'server.local',
                        port: 5480,
                        database: 'MYDB',
                        user: 'user1',
                        password: ''
                    }
                });

                expect(mockConnectionManager.getConnection).toHaveBeenCalledWith('ExistingConnection');
                expect(mockConnectionManager.saveConnection).toHaveBeenCalledWith(
                    expect.objectContaining({
                        name: 'ExistingConnection',
                        password: 'stored-secret'
                    })
                );
            });

            it('should allow saving SQLite connections without host, user, or port', async () => {
                const connectionData: Partial<ConnectionDetails> = {
                    name: 'LocalSQLite',
                    database: ':memory:',
                    dbType: 'sqlite'
                };

                await messageHandler!({ command: 'save', data: connectionData });

                expect(mockConnectionManager.saveConnection).toHaveBeenCalledWith(
                    expect.objectContaining({
                        name: 'LocalSQLite',
                        host: '',
                        port: undefined,
                        database: ':memory:',
                        user: '',
                        dbType: 'sqlite'
                    })
                );
            });

            it('should normalize SQLite in-memory mode to :memory: when no path is provided', async () => {
                const connectionData: Partial<ConnectionDetails> = {
                    name: 'MemorySQLite',
                    database: '',
                    dbType: 'sqlite',
                    options: {
                        mode: 'memory'
                    }
                };

                await messageHandler!({ command: 'save', data: connectionData });

                expect(mockConnectionManager.saveConnection).toHaveBeenCalledWith(
                    expect.objectContaining({
                        name: 'MemorySQLite',
                        database: ':memory:',
                        dbType: 'sqlite',
                        options: {
                            mode: 'memory'
                        }
                    })
                );
            });

            it('should show error message when save fails', async () => {
                mockConnectionManager.saveConnection.mockRejectedValue(new Error('Database error'));

                const connectionData: ConnectionDetails = {
                    name: 'FailConnection',
                    host: 'server.local',
                    port: 5480,
                    database: 'MYDB',
                    user: 'user1',
                    password: 'secret'
                };

                await messageHandler!({ command: 'save', data: connectionData });

                expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                    expect.stringContaining('Database error')
                );
            });

            it('should show error message when save fails with non-Error object', async () => {
                mockConnectionManager.saveConnection.mockRejectedValue('String error message');

                const connectionData: ConnectionDetails = {
                    name: 'FailConnection2',
                    host: 'server.local',
                    port: 5480,
                    database: 'MYDB',
                    user: 'user1',
                    password: 'secret'
                };

                await messageHandler!({ command: 'save', data: connectionData });

                expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                    expect.stringContaining('String error message')
                );
            });

            describe('Validation Rules', () => {
                const validData: ConnectionDetails = {
                    name: 'Test',
                    host: 'localhost',
                    port: 5480,
                    database: 'db',
                    user: 'admin'
                };

                it('should reject empty name', async () => {
                    await messageHandler!({ command: 'save', data: { ...validData, name: '  ' } });
                    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Connection Name is required'));
                    expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
                });

                it('should reject missing name', async () => {
                    await messageHandler!({ command: 'save', data: { ...validData, name: undefined as unknown as string } });
                    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Connection Name is required'));
                    expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
                });

                it('should reject empty host', async () => {
                    await messageHandler!({ command: 'save', data: { ...validData, host: '' } });
                    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Host is required'));
                    expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
                });

                it('should reject empty database', async () => {
                    await messageHandler!({ command: 'save', data: { ...validData, database: ' \t ' } });
                    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Database is required'));
                    expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
                });

                it('should reject empty user', async () => {
                    await messageHandler!({ command: 'save', data: { ...validData, user: '' } });
                    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('User is required'));
                    expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
                });

                it('should reject missing port', async () => {
                    await messageHandler!({ command: 'save', data: { ...validData, port: undefined as unknown as number } });
                    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Valid Port is required'));
                    expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
                });

                it('should reject port < 1', async () => {
                    await messageHandler!({ command: 'save', data: { ...validData, port: 0 } });
                    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Valid Port is required'));
                    expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
                });

                it('should reject port > 65535', async () => {
                    await messageHandler!({ command: 'save', data: { ...validData, port: 65536 } });
                    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Valid Port is required'));
                    expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
                });

                it('should reject NaN port', async () => {
                    await messageHandler!({ command: 'save', data: { ...validData, port: NaN } });
                    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Valid Port is required'));
                    expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
                });
            });
        });

        describe('test command', () => {
            const validData: ConnectionDetails = {
                name: 'TestConnection',
                host: 'server.local',
                port: 5480,
                database: 'TESTDB',
                user: 'admin',
                password: 'password',
                accentColor: 'red'
            };

            it('should interact with ConnectionManager.testConnection', async () => {
                await messageHandler!({ command: 'test', data: validData });

                expect(mockConnectionManager.testConnection).toHaveBeenCalledWith(
                    expect.objectContaining({
                        ...validData,
                        dbType: 'netezza'
                    })
                );
                expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Connection successful!');
            });

            it('should preserve the stored password during test when editing without changing it', async () => {
                mockConnectionManager.getConnection.mockResolvedValue({
                    name: 'ExistingConnection',
                    host: 'server.local',
                    port: 5480,
                    database: 'TESTDB',
                    user: 'admin',
                    password: 'stored-secret',
                    dbType: 'netezza'
                } as ConnectionDetails);

                await messageHandler!({
                    command: 'test',
                    originalName: 'ExistingConnection',
                    passwordChanged: false,
                    data: {
                        ...validData,
                        name: 'ExistingConnection',
                        password: ''
                    }
                });

                expect(mockConnectionManager.getConnection).toHaveBeenCalledWith('ExistingConnection');
                expect(mockConnectionManager.testConnection).toHaveBeenCalledWith(
                    expect.objectContaining({
                        name: 'ExistingConnection',
                        password: 'stored-secret'
                    })
                );
            });

            it('should show error if connection test fails', async () => {
                mockConnectionManager.testConnection.mockRejectedValue(new Error('Auth failed'));

                await messageHandler!({ command: 'test', data: validData });

                expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                    expect.stringContaining('Connection failed: Auth failed')
                );
            });

            it('should reject missing database during test', async () => {
                await messageHandler!({ command: 'test', data: { ...validData, database: '  ' } });
                expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Database is required'));
                expect(mockConnectionManager.testConnection).not.toHaveBeenCalled();
            });
        });

        describe('delete command', () => {
            it('should prompt for confirmation before deleting', async () => {
                (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes');

                await messageHandler!({ command: 'delete', name: 'OldConnection' });

                expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                    expect.stringContaining('OldConnection'),
                    expect.objectContaining({ modal: true }),
                    'Yes',
                    'No'
                );
            });

            it('should delete connection when confirmed', async () => {
                (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes');

                await messageHandler!({ command: 'delete', name: 'OldConnection' });

                expect(mockConnectionManager.deleteConnection).toHaveBeenCalledWith('OldConnection');
                expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                    expect.stringContaining('deleted')
                );
            });

            it('should not delete connection when cancelled', async () => {
                (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('No');

                await messageHandler!({ command: 'delete', name: 'OldConnection' });

                expect(mockConnectionManager.deleteConnection).not.toHaveBeenCalled();
            });

            it('should show error message when delete fails', async () => {
                (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes');
                mockConnectionManager.deleteConnection.mockRejectedValue(new Error('Permission denied'));

                await messageHandler!({ command: 'delete', name: 'ProtectedConnection' });

                expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                    expect.stringContaining('Permission denied')
                );
            });

            it('should show error message when delete fails with non-Error object', async () => {
                (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes');
                mockConnectionManager.deleteConnection.mockRejectedValue('String delete error');

                await messageHandler!({ command: 'delete', name: 'ProtectedConnection2' });

                expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                    expect.stringContaining('String delete error')
                );
            });
        });

        describe('loadConnections command', () => {
            it('should send connections to webview', async () => {
                await messageHandler!({ command: 'loadConnections' });

                expect(mockConnectionManager.getConnections).toHaveBeenCalled();
                expect(mockConnectionManager.getActiveConnectionName).toHaveBeenCalled();
                expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith({
                    command: 'updateConnections',
                    connections: expect.any(Array),
                    activeName: 'TestConnection'
                });
            });

            it('should not expose stored passwords or implicit DB2 client codepage defaults to the webview', async () => {
                mockConnectionManager.getConnections.mockResolvedValue([
                    {
                        name: 'WarehouseDb2',
                        host: 'db2.example.test',
                        port: 50000,
                        database: 'warehouse',
                        user: 'db2inst1',
                        password: 'stored-secret',
                        dbType: 'db2',
                        options: {
                            clientCodepage: '1208'
                        }
                    }
                ]);

                await messageHandler!({ command: 'loadConnections' });

                const updateMessage = (mockWebviewPanel.webview.postMessage as jest.Mock).mock.calls
                    .map(call => call[0])
                    .find(message => message.command === 'updateConnections');

                expect(updateMessage).toBeDefined();
                expect(updateMessage.connections[0].password).toBeUndefined();
                expect(updateMessage.connections[0].options).toBeUndefined();
            });
        });
    });

    describe('dispose', () => {
        it('should clean up panel reference on dispose', () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);
            expect(LoginPanel.currentPanel).toBeDefined();

            // Trigger dispose
            disposeHandler!();

            expect(LoginPanel.currentPanel).toBeUndefined();
        });

        it('should dispose webview panel', () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);
            const panel = LoginPanel.currentPanel;

            // Call dispose method
            panel!.dispose();

            expect(mockWebviewPanel.dispose).toHaveBeenCalled();
            expect(LoginPanel.currentPanel).toBeUndefined();
        });
    });

    describe('HTML content validation', () => {
        it('should include form fields with correct IDs', () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('id="name"');
            expect(html).toContain('id="dbType"');
            expect(html).toContain('id="host"');
            expect(html).toContain('id="port"');
            expect(html).toContain('id="database"');
            expect(html).toContain('id="user"');
            expect(html).toContain('id="password"');
            expect(html).toContain('id="accentColor"');
        });

        it('should include connection list container', () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('id="connectionList"');
        });

        it('should include save and delete buttons', () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('id="btnSave"');
            expect(html).toContain('id="btnDelete"');
            expect(html).toContain('id="btnNew"');
        });

        it('should have default port value of 5480', () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('value="5480"');
        });

        it('should have Netezza as default database type value', () => {
            LoginPanel.createOrShow(mockExtensionUri, mockConnectionManager);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('option value="netezza"');
        });
    });
});
