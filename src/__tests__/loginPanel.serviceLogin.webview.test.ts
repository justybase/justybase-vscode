/**
 * Runs the login panel's real webview script in jsdom and checks the service
 * login mode from form state to the message sent to the extension host.
 */

import { JSDOM } from 'jsdom';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import { LoginPanel } from '../views/loginPanel';

interface PostedMessage {
    command: string;
    passwordChanged?: boolean;
    data?: {
        user?: string;
        password?: string;
        tunnel?: { id: string; serverUrl: string; auth?: string };
        tunnelToken?: string;
        clearTunnelToken?: boolean;
    };
}

function renderPanelHtml(): string {
    let html = '';
    const panel = {
        webview: {
            get html() {
                return html;
            },
            set html(value: string) {
                html = value;
            },
            onDidReceiveMessage: jest.fn(() => ({ dispose: jest.fn() })),
            postMessage: jest.fn().mockResolvedValue(true),
            asWebviewUri: jest.fn(uri => ({ toString: () => `webview-uri://${uri.fsPath}` })),
        },
        viewType: 'netezzaLogin',
        title: 'Connect to Database',
        visible: true,
        active: true,
        onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
        onDidChangeViewState: jest.fn(() => ({ dispose: jest.fn() })),
        reveal: jest.fn(),
        dispose: jest.fn(),
    };
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    const manager = {
        getConnections: jest.fn().mockResolvedValue([]),
        getConnection: jest.fn().mockResolvedValue(undefined),
        getActiveConnectionName: jest.fn().mockReturnValue(null),
        onDidChangeConnections: jest.fn(() => ({ dispose: jest.fn() })),
        onDidChangeActiveConnection: jest.fn(() => ({ dispose: jest.fn() })),
    } as unknown as ConnectionManager;
    LoginPanel.createOrShow({ fsPath: '/test', toString: () => 'file:///test' } as vscode.Uri, manager);
    return html;
}

describe('login panel webview: service login', () => {
    let window: JSDOM['window'];
    let document: Document;
    let posted: PostedMessage[];

    const element = <T extends HTMLElement>(id: string): T => {
        const found = document.getElementById(id);
        if (!found) throw new Error(`Missing element #${id}`);
        return found as T;
    };
    const setValue = (id: string, value: string): void => {
        const input = element<HTMLInputElement>(id);
        input.value = value;
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const setChecked = (id: string, checked: boolean): void => {
        const input = element<HTMLInputElement>(id);
        input.checked = checked;
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const passwordGroup = (): HTMLElement => element('password').closest('.form-group') as HTMLElement;
    const loadConnections = (connections: unknown[]): void => {
        window.dispatchEvent(new window.MessageEvent('message', {
            data: { command: 'updateConnections', connections, activeName: null },
        }));
    };
    const lastSave = (): PostedMessage => {
        const message = [...posted].reverse().find(item => item.command === 'save');
        if (!message) throw new Error('No save message was posted.');
        return message;
    };

    beforeEach(() => {
        (LoginPanel as unknown as { currentPanel: undefined }).currentPanel = undefined;
        posted = [];
        const dom = new JSDOM(renderPanelHtml(), {
            runScripts: 'dangerously',
            beforeParse(target) {
                (target as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
                    postMessage: (message: PostedMessage) => posted.push(message),
                    getState: () => undefined,
                    setState: () => undefined,
                });
            },
        });
        window = dom.window;
        document = dom.window.document;
        setValue('dbType', 'netezza');
        setValue('name', 'Service profile');
        setValue('database', 'DEV');
        setValue('user', 'analyst');
        setChecked('tunnelEnabled', true);
        setValue('tunnelServerUrl', 'https://service.example.test/api/justybase');
        setValue('tunnelTargetId', 'netezza');
    });

    afterEach(() => {
        window.close();
        (LoginPanel as unknown as { currentPanel: undefined }).currentPanel = undefined;
    });

    it('offers service login for Netezza', () => {
        expect(element('tunnelAuthGroup').style.display).toBe('block');
    });

    it('hides the option for a dialect the relay cannot log in for, and leaves that mode', () => {
        setValue('tunnelAuth', 'service-login');

        setValue('dbType', 'postgresql');

        expect(element('tunnelAuthGroup').style.display).toBe('none');
        expect(element<HTMLSelectElement>('tunnelAuth').value).toBe('bearer-token');
        expect(element('tunnelTokenLabel').textContent).toBe('Bearer token');
    });

    it('asks for service credentials and hides the database password', () => {
        expect(passwordGroup().style.display).not.toBe('none');

        setValue('tunnelAuth', 'service-login');

        expect(passwordGroup().style.display).toBe('none');
        expect(document.querySelector('label[for="user"]')?.textContent).toContain('Service login');
        expect(element('tunnelTokenLabel').textContent).toBe('Service password');
        expect(element('tunnelClearTokenLabel').textContent).toBe('Remove the saved service password');
    });

    it('restores the direct form when the mode is switched back', () => {
        const directLabel = document.querySelector('label[for="user"]')?.textContent;
        setValue('tunnelAuth', 'service-login');

        setValue('tunnelAuth', 'bearer-token');

        expect(passwordGroup().style.display).not.toBe('none');
        expect(document.querySelector('label[for="user"]')?.textContent).toBe(directLabel);
        expect(element('tunnelTokenLabel').textContent).toBe('Bearer token');
    });

    it('restores the direct form when the tunnel is switched off', () => {
        setValue('tunnelAuth', 'service-login');

        setChecked('tunnelEnabled', false);

        expect(passwordGroup().style.display).not.toBe('none');
    });

    it('sends the mode and the service password, with no database password', () => {
        setValue('password', 'typed-before-switching');
        setValue('tunnelAuth', 'service-login');
        setValue('tunnelToken', 'service-password');

        element('btnSave').click();

        const { data, passwordChanged } = lastSave();
        expect(data?.tunnel?.auth).toBe('service-login');
        expect(data?.user).toBe('analyst');
        expect(data?.tunnelToken).toBe('service-password');
        expect(data?.password).toBeUndefined();
        expect(passwordChanged).toBe(false);
    });

    it('omits the mode for a bearer token tunnel, so its profile shape is unchanged', () => {
        setValue('password', 'database-password');
        setValue('tunnelToken', 'static-token');

        element('btnSave').click();

        const { data } = lastSave();
        expect(data?.tunnel && 'auth' in data.tunnel).toBe(false);
        expect(data?.password).toBe('database-password');
    });

    describe('editing a saved profile', () => {
        const savedTunnel = {
            id: 'saved-tunnel',
            serverUrl: 'https://service.example.test/api/justybase',
            targetId: 'netezza',
            localPort: 15480,
        };
        const saved = {
            name: 'Saved',
            dbType: 'netezza',
            host: '127.0.0.1',
            port: 15480,
            database: 'DEV',
            user: 'analyst',
        };
        const selectSaved = (tunnel: object): void => {
            loadConnections([{ ...saved, tunnel }]);
            const item = Array.from(document.querySelectorAll<HTMLElement>('#connectionList *'))
                .find(node => node.textContent?.trim() === 'Saved' && node.onclick !== null)
                ?? document.querySelector<HTMLElement>('#connectionList [data-name="Saved"]')
                ?? document.querySelector<HTMLElement>('#connectionList li, #connectionList .connection-item');
            if (!item) throw new Error('The saved profile is not listed.');
            item.click();
        };

        it('reopens a service login profile in service login mode', () => {
            selectSaved({ ...savedTunnel, auth: 'service-login' });

            expect(element<HTMLSelectElement>('tunnelAuth').value).toBe('service-login');
            expect(passwordGroup().style.display).toBe('none');
            expect(element('tunnelTokenLabel').textContent).toBe('Service password');
        });

        it('clears the saved secret when the mode changes and no new one is entered', () => {
            selectSaved(savedTunnel);
            setValue('tunnelAuth', 'service-login');

            element('btnSave').click();

            expect(lastSave().data?.clearTunnelToken).toBe(true);
        });

        it('keeps the saved secret when nothing about the relay changes', () => {
            selectSaved({ ...savedTunnel, auth: 'service-login' });

            element('btnSave').click();

            const { data } = lastSave();
            expect(data?.clearTunnelToken).toBe(false);
            expect(data?.tunnel?.id).toBe('saved-tunnel');
        });
    });
});
