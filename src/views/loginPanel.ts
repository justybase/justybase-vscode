import * as vscode from 'vscode';
import type { LoginPanelInboundMessage, LoginPanelOutboundMessage } from '../contracts/webview';
import type {
    DatabaseConnectionFieldOption,
    DatabaseConnectionFieldSchema,
    DatabaseConnectionFormSchema,
    DatabaseConnectionOptionValue,
    DatabaseDialect,
    DatabaseKind
} from '../contracts/database';
import { resolveConnectionDatabaseKind } from '../core/connectionFactory';
import { allAvailableDialects } from '../dialects';
import { createStandardConnectionForm } from '../core/connectionFormBuilder';
import { ConnectionManager, ConnectionDetails } from '../core/connectionManager';
import { getConnectionAccentOptions } from '../utils/connectionAccent';
import { getDialectIconWebviewUri } from '../utils/dialectIcons';

interface LoginPanelDialectDefinition {
    kind: DatabaseKind;
    displayName: string;
    defaultPort?: number;
    connectionForm: DatabaseConnectionFormSchema;
}

function buildFallbackConnectionForm(defaultPort?: number): DatabaseConnectionFormSchema {
    return createStandardConnectionForm({ defaultPort });
}

function getLoginPanelDialects(): LoginPanelDialectDefinition[] {
    // Use all available dialects for the login panel, not just registered ones
    // This allows users to see all database options even if their extensions aren't installed yet
    return allAvailableDialects.map((dialect: DatabaseDialect) => ({
        kind: dialect.kind,
        displayName: dialect.displayName,
        defaultPort: dialect.defaultPort,
        connectionForm: dialect.connectionForm ?? buildFallbackConnectionForm(dialect.defaultPort)
    }));
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getConnectionFieldValue(
    details: Partial<ConnectionDetails>,
    field: DatabaseConnectionFieldSchema
): DatabaseConnectionOptionValue | undefined {
    if (field.storage === 'options') {
        return details.options?.[field.key];
    }

    return (details as Record<string, DatabaseConnectionOptionValue | undefined>)[field.key];
}

function renderFieldDescription(description?: string): string {
    if (!description) {
        return '';
    }

    return `<div class="form-hint">${escapeHtml(description)}</div>`;
}

function renderFieldOptions(
    options: readonly DatabaseConnectionFieldOption[] | undefined,
    selectedValue: string
): string {
    return (options ?? []).map(option => {
        const isSelected = option.value === selectedValue ? ' selected' : '';
        return `<option value="${escapeHtml(option.value)}"${isSelected}>${escapeHtml(option.label)}</option>`;
    }).join('');
}

function renderAccentOptions(selectedAccentColor?: string): string {
    const normalizedAccent = selectedAccentColor?.trim().toLowerCase() ?? '';
    const optionMarkup = getConnectionAccentOptions().map(option => {
        const isSelected = option.id === normalizedAccent ? ' selected' : '';
        return `<option value="${escapeHtml(option.id)}"${isSelected}>${escapeHtml(option.label)}</option>`;
    }).join('');

    const noneSelected = normalizedAccent.length === 0 ? ' selected' : '';
    return `<option value=""${noneSelected}>None</option>${optionMarkup}`;
}

function renderConnectionField(
    field: DatabaseConnectionFieldSchema,
    value?: DatabaseConnectionOptionValue
): string {
    const layoutClass = field.layout === 'half' ? 'field-half' : 'field-full';
    const description = renderFieldDescription(field.description);
    const valueText = value === undefined || value === null ? '' : String(value);
    const requiredMarker = field.required ? ' <span class="required-marker">*</span>' : '';

    if (field.type === 'checkbox') {
        const checked = value === true || valueText === 'true' ? ' checked' : '';
        return [
            `<div class="form-group ${layoutClass} checkbox-group">`,
            `    <label class="checkbox-label" for="${escapeHtml(field.key)}">`,
            `        <input type="checkbox" id="${escapeHtml(field.key)}"${checked}>`,
            `        <span>${escapeHtml(field.label)}${requiredMarker}</span>`,
            '    </label>',
            `    ${description}`,
            '</div>'
        ].join('\n');
    }

    const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
    const min = field.min !== undefined ? ` min="${field.min}"` : '';
    const max = field.max !== undefined ? ` max="${field.max}"` : '';
    const valueAttribute = valueText.length > 0 ? ` value="${escapeHtml(valueText)}"` : '';

    let inputMarkup: string;
    if (field.type === 'select') {
        inputMarkup = `<select id="${escapeHtml(field.key)}">${renderFieldOptions(field.options, valueText)}</select>`;
    } else {
        const inputType = field.type === 'number' ? 'number' : field.type;
        inputMarkup =
            `<input type="${inputType}" id="${escapeHtml(field.key)}"${placeholder}${valueAttribute}${min}${max}>`;
    }

    return [
        `<div class="form-group ${layoutClass}">`,
        `    <label for="${escapeHtml(field.key)}">${escapeHtml(field.label)}${requiredMarker}</label>`,
        `    ${inputMarkup}`,
        `    ${description}`,
        '</div>'
    ].join('\n');
}

function renderConnectionFields(
    form: DatabaseConnectionFormSchema,
    details: Partial<ConnectionDetails> = {}
): string {
    return form.fields
        .map(field => {
            const value = getConnectionFieldValue(details, field);
            return renderConnectionField(field, value ?? field.defaultValue);
        })
        .join('\n');
}

export class LoginPanel {
    public static currentPanel: LoginPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _dialects: LoginPanelDialectDefinition[];
    private readonly _defaultDialect: LoginPanelDialectDefinition;

    private constructor(
        panel: vscode.WebviewPanel,
        private extensionUri: vscode.Uri,
        private connectionManager: ConnectionManager
    ) {
        this._panel = panel;
        this._dialects = getLoginPanelDialects();
        this._defaultDialect = this._dialects[0];
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message: LoginPanelInboundMessage) => {
                switch (message.command) {
                    case 'save': {
                        try {
                            const originalName = typeof message.originalName === 'string' ? message.originalName : undefined;
                            const passwordChanged = message.passwordChanged === true;
                            const data = await this._preserveStoredPassword(
                                this._normalizeIncomingConnection(message.data),
                                originalName,
                                passwordChanged
                            );
                            const validationError = this._validateConnectionData(data, true);
                            if (validationError) {
                                vscode.window.showErrorMessage(validationError);
                                return;
                            }

                            await this.connectionManager.saveConnection(data);
                            vscode.window.showInformationMessage(`Connection '${data.name}' saved and activated!`);
                            await this.sendConnectionsToWebview();
                        } catch (e: unknown) {
                            const errorMsg = e instanceof Error ? e.message : String(e);
                            vscode.window.showErrorMessage(`Error saving: ${errorMsg}`);
                        }
                        return;
                    }
                    case 'delete': {
                        try {
                            const result = await vscode.window.showWarningMessage(
                                `Are you sure you want to delete '${message.name}'?`,
                                { modal: true },
                                'Yes',
                                'No'
                            );
                            if (result === 'Yes') {
                                await this.connectionManager.deleteConnection(message.name);
                                vscode.window.showInformationMessage(`Connection '${message.name}' deleted.`);
                                await this.sendConnectionsToWebview();
                            }
                        } catch (e: unknown) {
                            const errorMsg = e instanceof Error ? e.message : String(e);
                            vscode.window.showErrorMessage(`Error deleting: ${errorMsg}`);
                        }
                        return;
                    }
                    case 'test': {
                        try {
                            const originalName = typeof message.originalName === 'string' ? message.originalName : undefined;
                            const passwordChanged = message.passwordChanged === true;
                            const data = await this._preserveStoredPassword(
                                this._normalizeIncomingConnection(message.data),
                                originalName,
                                passwordChanged
                            );
                            const validationError = this._validateConnectionData(data, false);
                            if (validationError) {
                                vscode.window.showErrorMessage(validationError);
                                return;
                            }

                            vscode.window.showInformationMessage('Testing connection...');
                            await this.connectionManager.testConnection(data);
                            vscode.window.showInformationMessage('Connection successful!');
                        } catch (e: unknown) {
                            const errorMsg = e instanceof Error ? e.message : String(e);
                            vscode.window.showErrorMessage(`Connection failed: ${errorMsg}`);
                        }
                        return;
                    }
                    case 'loadConnections':
                        await this.sendConnectionsToWebview();
                        return;
                }
            },
            null,
            this._disposables
        );

        this._disposables.push(this.connectionManager.onDidChangeConnections(() => {
            void this.sendConnectionsToWebview();
        }));
        this._disposables.push(this.connectionManager.onDidChangeActiveConnection(() => {
            void this.sendConnectionsToWebview();
        }));

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    }

    private _getDialectDefinition(kind?: string | DatabaseKind): LoginPanelDialectDefinition {
        const normalizedKind = resolveConnectionDatabaseKind(kind);
        return this._dialects.find(dialect => dialect.kind === normalizedKind) ?? this._defaultDialect;
    }

    private _normalizeOptions(options: ConnectionDetails['options'] | undefined): ConnectionDetails['options'] {
        if (!options) {
            return undefined;
        }

        const entries = Object.entries(options).filter(([, value]) => value !== undefined);
        return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }

    private _normalizeIncomingConnection(data: Partial<ConnectionDetails>): ConnectionDetails {
        const dialect = this._getDialectDefinition(data.dbType);
        const normalizedOptions = this._normalizeOptions(data.options);
        if (normalizedOptions && dialect.kind === 'db2') {
            const clientCodepage = typeof normalizedOptions.clientCodepage === 'string'
                ? normalizedOptions.clientCodepage.trim()
                : undefined;
            if (clientCodepage) {
                normalizedOptions.clientCodepage = clientCodepage;
                normalizedOptions.clientCodepageExplicit = true;
            } else {
                delete normalizedOptions.clientCodepage;
                delete normalizedOptions.clientCodepageExplicit;
            }
        }
        const normalizedDatabase =
            (dialect.kind === 'sqlite' || dialect.kind === 'duckdb')
            && normalizedOptions?.mode === 'memory'
            && (!data.database || data.database.trim() === '')
                ? ':memory:'
                : data.database ?? '';

        return {
            name: data.name ?? '',
            host: data.host ?? '',
            port: typeof data.port === 'number' && Number.isFinite(data.port) ? data.port : undefined,
            database: normalizedDatabase,
            user: data.user ?? '',
            password: data.password,
            ...(normalizedOptions ? { options: normalizedOptions } : {}),
            dbType: dialect.kind,
            accentColor: data.accentColor
        };
    }

    private async _preserveStoredPassword(
        data: ConnectionDetails,
        originalName: string | undefined,
        passwordChanged: boolean
    ): Promise<ConnectionDetails> {
        if (passwordChanged || (typeof data.password === 'string' && data.password.length > 0)) {
            return data;
        }

        const candidateNames = Array.from(
            new Set(
                [originalName, data.name].filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
            )
        );

        for (const candidateName of candidateNames) {
            const existing = await this.connectionManager.getConnection(candidateName);
            if (existing && existing.password !== undefined) {
                return {
                    ...data,
                    password: existing.password
                };
            }
        }

        return data;
    }

    private _sanitizeConnectionForWebview(connection: ConnectionDetails): ConnectionDetails {
        const options = connection.options ? { ...connection.options } : undefined;
        if (options) {
            const clientCodepage = typeof options.clientCodepage === 'string' ? options.clientCodepage.trim() : undefined;
            const clientCodepageExplicit = options.clientCodepageExplicit === true;

            delete options.clientCodepageExplicit;

            if (resolveConnectionDatabaseKind(connection.dbType) === 'db2' && clientCodepage === '1208' && !clientCodepageExplicit) {
                delete options.clientCodepage;
            }
        }

        return {
            ...connection,
            password: undefined,
            ...(options && Object.keys(options).length > 0 ? { options } : { options: undefined })
        };
    }

    private _getNumericValidationMessage(field: DatabaseConnectionFieldSchema): string {
        if (field.min !== undefined && field.max !== undefined) {
            return `Valid ${field.label} is required (${field.min}-${field.max})`;
        }

        return `Valid ${field.label} is required`;
    }

    private _hasRequiredFieldValue(
        value: DatabaseConnectionOptionValue | undefined,
        field: DatabaseConnectionFieldSchema
    ): boolean {
        if (field.type === 'checkbox') {
            return value !== undefined;
        }

        if (typeof value === 'number') {
            return Number.isFinite(value);
        }

        if (typeof value === 'boolean') {
            return true;
        }

        return typeof value === 'string' ? value.trim().length > 0 : value !== undefined;
    }

    private _validateConnectionData(data: Partial<ConnectionDetails>, requireName: boolean): string | undefined {
        if (requireName && (!data.name || data.name.trim() === '')) {
            return 'Connection Name is required';
        }

        const dialect = this._getDialectDefinition(data.dbType);
        for (const field of dialect.connectionForm.fields) {
            const value = getConnectionFieldValue(data, field);

            if (field.type === 'number') {
                const hasNumericValue = value !== undefined && value !== null && value !== '';
                if (!hasNumericValue) {
                    if (field.required) {
                        return this._getNumericValidationMessage(field);
                    }
                    continue;
                }

                const numericValue = typeof value === 'number' ? value : Number(value);
                if (
                    !Number.isFinite(numericValue)
                    || (field.min !== undefined && numericValue < field.min)
                    || (field.max !== undefined && numericValue > field.max)
                ) {
                    return this._getNumericValidationMessage(field);
                }
                continue;
            }

            if (field.required && !this._hasRequiredFieldValue(value, field)) {
                return `${field.label} is required`;
            }
        }

        return undefined;
    }

    private async sendConnectionsToWebview() {
        const connections = (await this.connectionManager.getConnections()).map(connection =>
            this._sanitizeConnectionForWebview(connection)
        );
        const activeName = this.connectionManager.getActiveConnectionName() ?? undefined;
        await this._postMessage({ command: 'updateConnections', connections, activeName });
    }

    private _postMessage(message: LoginPanelOutboundMessage): Thenable<boolean> {
        return this._panel.webview.postMessage(message);
    }

    public static createOrShow(extensionUri: vscode.Uri, connectionManager: ConnectionManager) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (LoginPanel.currentPanel) {
            LoginPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'netezzaLogin',
            'Connect to Database',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        LoginPanel.currentPanel = new LoginPanel(panel, extensionUri, connectionManager);
    }

    public static createNew(extensionUri: vscode.Uri, connectionManager: ConnectionManager) {
        if (LoginPanel.currentPanel) {
            LoginPanel.currentPanel.dispose();
        }

        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        const panel = vscode.window.createWebviewPanel(
            'netezzaLogin',
            'Connect to Database',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        LoginPanel.currentPanel = new LoginPanel(panel, extensionUri, connectionManager);
    }

    public dispose() {
        LoginPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const defaultIconUri = getDialectIconWebviewUri(webview, this.extensionUri, this._defaultDialect.kind);
        const dialectIconUris = JSON.stringify(
            Object.fromEntries(
                this._dialects.map(dialect => [
                    dialect.kind,
                    String(getDialectIconWebviewUri(webview, this.extensionUri, dialect.kind))
                ])
            )
        );
        const accentOptions = JSON.stringify(getConnectionAccentOptions());
        const accentOptionsMarkup = renderAccentOptions();
        const sqliteFilePlaceholder = JSON.stringify('Existing or new SQLite file (for example C:\\data\\sample.db)');
        const duckdbFilePlaceholder = JSON.stringify('Existing or new DuckDB file (for example C:\\data\\analytics.duckdb)');
        const dialectOptions = this._dialects.map(dialect =>
            `<option value="${escapeHtml(dialect.kind)}">${escapeHtml(dialect.displayName)}</option>`
        ).join('');
        const dialectsJson = JSON.stringify(this._dialects);
        const initialFieldsHtml = renderConnectionFields(this._defaultDialect.connectionForm);

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Connect to Database</title>
            <style>
                :root {
                    --container-paddding: 20px;
                    --input-padding-vertical: 6px;
                    --input-padding-horizontal: 8px;
                    --input-margin-vertical: 4px;
                    --input-margin-horizontal: 0;
                }
                body {
                    font-family: var(--vscode-font-family);
                    padding: 0;
                    margin: 0;
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    display: flex;
                    height: 100vh;
                    overflow: hidden;
                }

                .sidebar {
                    width: 260px;
                    background-color: var(--vscode-sideBar-background);
                    border-right: 1px solid var(--vscode-panel-border);
                    display: flex;
                    flex-direction: column;
                    flex-shrink: 0;
                    user-select: none;
                }
                .sidebar-header {
                    padding: 10px 15px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    background-color: var(--vscode-sideBarSectionHeader-background);
                }
                .sidebar-title {
                    font-weight: bold;
                    font-size: 11px;
                    text-transform: uppercase;
                    color: var(--vscode-sideBarTitle-foreground);
                }
                .connection-list {
                    flex: 1;
                    overflow-y: auto;
                    padding: 0;
                }
                .connection-item {
                    padding: 8px 15px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    border-left: 3px solid transparent;
                    color: var(--vscode-sideBar-foreground);
                }
                .connection-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .connection-item.active {
                    background-color: var(--vscode-list-activeSelectionBackground);
                    color: var(--vscode-list-activeSelectionForeground);
                    border-left-color: var(--vscode-focusBorder);
                }
                .connection-item .name {
                    flex: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .connection-item .status {
                    font-size: 0.8em;
                    margin-left: 5px;
                    opacity: 0.7;
                }
                .connection-accent,
                .accent-preview {
                    width: 14px;
                    height: 14px;
                    border-radius: 999px;
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    display: inline-block;
                    flex-shrink: 0;
                }
                .accent-preview {
                    width: 18px;
                    height: 18px;
                }
                .dialect-badge {
                    display: inline-flex;
                    align-items: center;
                    padding: 2px 6px;
                    border-radius: 999px;
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    font-size: 10px;
                    line-height: 1.4;
                }

                .main {
                    flex: 1;
                    padding: 40px;
                    overflow-y: auto;
                    display: flex;
                    justify-content: center;
                    align-items: flex-start;
                }
                .form-container {
                    width: 100%;
                    max-width: 520px;
                    background-color: var(--vscode-editorWidget-background);
                    border: 1px solid var(--vscode-widget-border);
                    padding: 30px;
                    border-radius: 4px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                }

                h2 {
                    margin-top: 0;
                    margin-bottom: 6px;
                    font-size: 1.4em;
                    font-weight: 500;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                .form-subtitle {
                    margin-bottom: 25px;
                    padding-bottom: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                }
                .form-grid {
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 0 15px;
                }
                .form-group {
                    margin-bottom: 18px;
                }
                .field-full {
                    grid-column: 1 / -1;
                }
                .field-half {
                    grid-column: span 1;
                }
                .form-hint {
                    margin-top: 6px;
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                }
                .accent-input-row {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }
                .checkbox-group {
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                }
                .checkbox-label {
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 0;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                }
                .checkbox-label input {
                    width: auto;
                }
                .required-marker {
                    color: var(--vscode-errorForeground);
                }

                label {
                    display: block;
                    margin-bottom: 6px;
                    font-weight: 600;
                    font-size: 12px;
                    color: var(--vscode-input-placeholderForeground);
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }

                input, select {
                    width: 100%;
                    padding: 8px 10px;
                    box-sizing: border-box;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
                    font-family: inherit;
                    font-size: 13px;
                }
                input:focus, select:focus {
                    border-color: var(--vscode-focusBorder);
                    outline: 1px solid var(--vscode-focusBorder);
                }

                .actions {
                    margin-top: 30px;
                    display: flex;
                    gap: 12px;
                    padding-top: 20px;
                    border-top: 1px solid var(--vscode-panel-border);
                }
                button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    padding: 8px 16px;
                    border: none;
                    cursor: pointer;
                    border-radius: 2px;
                    font-size: 13px;
                    font-weight: 500;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                button.secondary {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                button.secondary:hover {
                    background: var(--vscode-button-secondaryHoverBackground);
                }
                button.danger {
                    background: var(--vscode-errorForeground);
                    color: white;
                }
                button.icon-btn {
                    padding: 4px;
                    background: transparent;
                    color: var(--vscode-icon-foreground);
                }
                button.icon-btn:hover {
                    background: var(--vscode-toolbar-hoverBackground);
                }

                .icon-img {
                    width: 16px;
                    height: 16px;
                    object-fit: contain;
                }
                .logo-header {
                    width: 32px;
                    height: 32px;
                    margin-right: 10px;
                }
            </style>
        </head>
        <body>
            <div class="sidebar">
                <div class="sidebar-header">
                    <span class="sidebar-title">Saved Connections</span>
                    <button class="icon-btn" id="btnNew" title="New Connection">
                        <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>
                    </button>
                </div>
                <div id="connectionList" class="connection-list"></div>
            </div>

            <div class="main">
                <div class="form-container">
                    <h2 id="formTitle">
                        <img src="${defaultIconUri}" class="logo-header" />
                        New Connection
                    </h2>
                    <div id="formSubtitle" class="form-subtitle">${escapeHtml(this._defaultDialect.displayName)} connection settings</div>

                    <div class="form-group field-full">
                        <label for="name">Connection Name <span class="required-marker">*</span></label>
                        <input type="text" id="name" placeholder="Friendly name (e.g. Production)">
                    </div>

                    <div class="form-group field-full">
                        <label for="dbType">
                            Database Type
                            <img src="${defaultIconUri}" class="icon-img" id="dbTypeIcon" />
                        </label>
                        <select id="dbType">${dialectOptions}</select>
                    </div>

                    <div class="form-group field-full">
                        <label for="accentColor">Connection Accent</label>
                        <div class="accent-input-row">
                            <select id="accentColor">${accentOptionsMarkup}</select>
                            <span id="accentPreview" class="accent-preview" title="No accent"></span>
                        </div>
                        <div class="form-hint">Used for the schema connection node and SQL tab indicator badge.</div>
                    </div>

                    <div id="dialectFields" class="form-grid">${initialFieldsHtml}</div>

                    <div class="actions">
                        <button id="btnSave" onclick="save()">Save & Connect</button>
                        <button id="btnTest" class="secondary" onclick="testConnection()">Test Connection</button>
                        <button id="btnDelete" class="danger" onclick="del()" style="display: none;">Delete</button>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let connections = [];
                let activeName = null;
                let currentEditName = null;
                let passwordDirty = false;
                const dialectIcons = ${dialectIconUris};
                const defaultIconSrc = ${JSON.stringify(String(defaultIconUri))};
                const accentOptions = ${accentOptions};
                const dialects = ${dialectsJson};
                const sqliteFilePlaceholder = ${sqliteFilePlaceholder};
                const duckdbFilePlaceholder = ${duckdbFilePlaceholder};
                const defaultDialectKind = ${JSON.stringify(this._defaultDialect.kind)};
                const accentOptionMap = new Map(accentOptions.map(option => [option.id, option]));
                const dialectMap = new Map(dialects.map(dialect => [dialect.kind, dialect]));
                const localFileDialectConfigs = {
                    sqlite: {
                        filePlaceholder: sqliteFilePlaceholder,
                        memoryTitle: 'SQLite in-memory database'
                    },
                    duckdb: {
                        filePlaceholder: duckdbFilePlaceholder,
                        memoryTitle: 'DuckDB in-memory database'
                    }
                };

                function escapeHtml(value) {
                    return String(value)
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#39;');
                }

                function getDialect(kind) {
                    return dialectMap.get(kind) || dialectMap.get(defaultDialectKind) || dialects[0];
                }

                function getSelectedDialect() {
                    return getDialect(document.getElementById('dbType').value);
                }

                function getDialectDisplayName(kind) {
                    return getDialect(kind).displayName;
                }

                function getDialectIconSrc(kind) {
                    return dialectIcons[kind] || defaultIconSrc;
                }

                function getAccentOption(accentColor) {
                    if (!accentColor) {
                        return undefined;
                    }

                    return accentOptionMap.get(String(accentColor).toLowerCase());
                }

                function buildAccentSwatch(accentColor) {
                    const accentOption = getAccentOption(accentColor);
                    if (!accentOption) {
                        return '';
                    }

                    return '<span class="connection-accent" style="background-color: '
                        + accentOption.previewColor
                        + ';" title="Accent: '
                        + escapeHtml(accentOption.label)
                        + '"></span>';
                }

                function updateAccentPreview() {
                    const accentPreview = document.getElementById('accentPreview');
                    const selectedAccent = getAccentOption(document.getElementById('accentColor').value);

                    accentPreview.style.backgroundColor = selectedAccent ? selectedAccent.previewColor : 'transparent';
                    accentPreview.title = selectedAccent ? 'Accent: ' + selectedAccent.label : 'No accent';
                }

                function initializeAccentOptions() {
                    const accentSelect = document.getElementById('accentColor');
                    if (accentSelect.options.length === 0) {
                        accentSelect.innerHTML = '<option value="">None</option>';

                        accentOptions.forEach(option => {
                            const accentOption = document.createElement('option');
                            accentOption.value = option.id;
                            accentOption.textContent = option.label;
                            accentSelect.appendChild(accentOption);
                        });
                    }

                    if (accentSelect.dataset.initialized !== 'true') {
                        accentSelect.addEventListener('change', updateAccentPreview);
                        accentSelect.dataset.initialized = 'true';
                    }
                    updateAccentPreview();
                }

                function readFieldValue(field, element) {
                    if (!element) {
                        return undefined;
                    }

                    if (field.type === 'checkbox') {
                        return element.checked;
                    }

                    if (field.type === 'number') {
                        return element.value === '' ? undefined : Number(element.value);
                    }

                    return element.value;
                }

                function getConnectionFieldValue(connection, field) {
                    if (field.storage === 'options') {
                        return connection.options ? connection.options[field.key] : undefined;
                    }

                    return connection[field.key];
                }

                function renderFieldOptions(field, selectedValue) {
                    return (field.options || []).map(option => {
                        const isSelected = option.value === selectedValue ? ' selected' : '';
                        return '<option value="'
                            + escapeHtml(option.value)
                            + '"'
                            + isSelected
                            + '>'
                            + escapeHtml(option.label)
                            + '</option>';
                    }).join('');
                }

                function buildFieldMarkup(field, value) {
                    const layoutClass = field.layout === 'half' ? 'field-half' : 'field-full';
                    const requiredMarker = field.required ? ' <span class="required-marker">*</span>' : '';
                    const description = field.description
                        ? '<div class="form-hint">' + escapeHtml(field.description) + '</div>'
                        : '';

                    if (field.type === 'checkbox') {
                        const checked = value === true || String(value) === 'true' ? ' checked' : '';
                        return [
                            '<div class="form-group ' + layoutClass + ' checkbox-group">',
                            '    <label class="checkbox-label" for="' + escapeHtml(field.key) + '">',
                            '        <input type="checkbox" id="' + escapeHtml(field.key) + '"' + checked + '>',
                            '        <span>' + escapeHtml(field.label) + requiredMarker + '</span>',
                            '    </label>',
                            '    ' + description,
                            '</div>'
                        ].join('\\n');
                    }

                    const safeValue = value === undefined || value === null ? '' : String(value);
                    const placeholder = field.placeholder ? ' placeholder="' + escapeHtml(field.placeholder) + '"' : '';
                    const min = field.min !== undefined ? ' min="' + field.min + '"' : '';
                    const max = field.max !== undefined ? ' max="' + field.max + '"' : '';
                    const valueAttribute = safeValue.length > 0 ? ' value="' + escapeHtml(safeValue) + '"' : '';

                    let inputMarkup;
                    if (field.type === 'select') {
                        inputMarkup =
                            '<select id="' + escapeHtml(field.key) + '">' + renderFieldOptions(field, safeValue) + '</select>';
                    } else {
                        const inputType = field.type === 'number' ? 'number' : field.type;
                        inputMarkup =
                            '<input type="'
                            + inputType
                            + '" id="'
                            + escapeHtml(field.key)
                            + '"'
                            + placeholder
                            + valueAttribute
                            + min
                            + max
                            + '>';
                    }

                    return [
                        '<div class="form-group ' + layoutClass + '">',
                        '    <label for="' + escapeHtml(field.key) + '">' + escapeHtml(field.label) + requiredMarker + '</label>',
                        '    ' + inputMarkup,
                        '    ' + description,
                        '</div>'
                    ].join('\\n');
                }

                function renderDialectFields(kind, values = {}) {
                    const dialect = getDialect(kind);
                    const container = document.getElementById('dialectFields');
                    container.innerHTML = dialect.connectionForm.fields.map(field => {
                        const hasExplicitValue = Object.prototype.hasOwnProperty.call(values, field.key);
                        const value = hasExplicitValue ? values[field.key] : field.defaultValue;
                        return buildFieldMarkup(field, value);
                    }).join('\\n');

                    const passwordElement = document.getElementById('password');
                    if (!passwordElement) {
                        passwordDirty = false;
                        return;
                    }

                    passwordDirty = false;
                    if (passwordElement.dataset.initializedPasswordTracking !== 'true') {
                        passwordElement.addEventListener('input', () => {
                            passwordDirty = true;
                        });
                        passwordElement.dataset.initializedPasswordTracking = 'true';
                    }
                }

                function collectCurrentFieldValues() {
                    const dialect = getSelectedDialect();
                    const values = {};

                    dialect.connectionForm.fields.forEach(field => {
                        const element = document.getElementById(field.key);
                        if (!element) {
                            return;
                        }
                        values[field.key] = readFieldValue(field, element);
                    });

                    return values;
                }

                function buildFieldValueMapFromConnection(connection) {
                    const dialect = getDialect(connection.dbType || defaultDialectKind);
                    const values = {};

                    dialect.connectionForm.fields.forEach(field => {
                        values[field.key] = getConnectionFieldValue(connection, field);
                    });

                    return values;
                }

                function updateFormHeading() {
                    const titleText = currentEditName ? 'Edit Connection' : 'New Connection';
                    const dialect = getSelectedDialect();
                    document.getElementById('formTitle').innerHTML =
                        '<img src="' + getDialectIconSrc(dialect.kind) + '" class="logo-header" /> '
                        + escapeHtml(titleText);
                    document.getElementById('formSubtitle').textContent = dialect.displayName + ' connection settings';
                    const dbTypeIcon = document.getElementById('dbTypeIcon');
                    if (dbTypeIcon) {
                        dbTypeIcon.src = getDialectIconSrc(dialect.kind);
                    }
                }

                function synchronizeDialectUiState(kind) {
                    const localConfig = localFileDialectConfigs[kind];
                    if (!localConfig) {
                        return;
                    }

                    const modeElement = document.getElementById('mode');
                    const databaseElement = document.getElementById('database');
                    if (!modeElement || !databaseElement) {
                        return;
                    }

                    const applyLocalMode = () => {
                        if (modeElement.value === 'memory') {
                            databaseElement.value = ':memory:';
                            databaseElement.placeholder = ':memory:';
                            databaseElement.readOnly = true;
                            databaseElement.title = localConfig.memoryTitle;
                            return;
                        }

                        if (databaseElement.value === ':memory:') {
                            databaseElement.value = '';
                        }
                        databaseElement.placeholder = localConfig.filePlaceholder;
                        databaseElement.readOnly = false;
                        databaseElement.title = '';
                    };

                    if (modeElement.dataset.initialized !== 'true') {
                        modeElement.addEventListener('change', applyLocalMode);
                        modeElement.dataset.initialized = 'true';
                    }

                    applyLocalMode();
                }

                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'updateConnections':
                            connections = message.connections;
                            activeName = message.activeName;
                            renderList();
                            break;
                    }
                });

                vscode.postMessage({ command: 'loadConnections' });
                initializeAccentOptions();
                updateFormHeading();
                synchronizeDialectUiState(defaultDialectKind);
                const initialPasswordField = document.getElementById('password');
                if (initialPasswordField && initialPasswordField.dataset.initializedPasswordTracking !== 'true') {
                    initialPasswordField.addEventListener('input', () => {
                        passwordDirty = true;
                    });
                    initialPasswordField.dataset.initializedPasswordTracking = 'true';
                }

                document.getElementById('btnNew').addEventListener('click', () => {
                    clearForm();
                });

                document.getElementById('dbType').addEventListener('change', () => {
                    const currentValues = collectCurrentFieldValues();
                    const preservePasswordDirty = passwordDirty;
                    renderDialectFields(document.getElementById('dbType').value, currentValues);
                    passwordDirty = preservePasswordDirty;
                    updateFormHeading();
                    synchronizeDialectUiState(document.getElementById('dbType').value);
                    
                    // Auto-set default port for the selected dialect
                    const dialect = getSelectedDialect();
                    if (dialect.defaultPort !== undefined) {
                        const portElement = document.getElementById('port');
                        if (portElement) {
                            portElement.value = dialect.defaultPort;
                        }
                    }
                });

                function renderList() {
                    const list = document.getElementById('connectionList');
                    list.innerHTML = '';

                    connections.forEach(conn => {
                        const div = document.createElement('div');
                        div.className = 'connection-item';
                        if (conn.name === currentEditName) {
                            div.classList.add('active');
                        }

                        const dialectBadge =
                            '<span class="dialect-badge">'
                            + escapeHtml(getDialectDisplayName(conn.dbType || defaultDialectKind))
                            + '</span>';
                        div.innerHTML =
                            '<span class="name">'
                            + buildAccentSwatch(conn.accentColor)
                            + '<img src="'
                            + getDialectIconSrc(conn.dbType || defaultDialectKind)
                            + '" class="icon-img"> '
                            + escapeHtml(conn.name)
                            + ' '
                            + dialectBadge
                            + '</span>';
                        if (conn.name === activeName) {
                            div.innerHTML += '<span class="status">●</span>';
                            div.title = 'Active Connection';
                        }

                        div.onclick = () => loadForm(conn);
                        list.appendChild(div);
                    });
                }

                function loadForm(conn) {
                    currentEditName = conn.name;
                    const kind = getDialect(conn.dbType || defaultDialectKind).kind;
                    document.getElementById('name').value = conn.name;
                    document.getElementById('dbType').value = kind;
                    renderDialectFields(kind, buildFieldValueMapFromConnection({ ...conn, dbType: kind }));
                    document.getElementById('accentColor').value = conn.accentColor || '';
                    document.getElementById('btnDelete').style.display = 'block';
                    updateFormHeading();
                    synchronizeDialectUiState(kind);
                    updateAccentPreview();
                    renderList();
                }

                function clearForm() {
                    currentEditName = null;
                    document.getElementById('name').value = '';
                    document.getElementById('dbType').value = defaultDialectKind;
                    renderDialectFields(defaultDialectKind, {});
                    document.getElementById('accentColor').value = '';
                    document.getElementById('btnDelete').style.display = 'none';
                    updateFormHeading();
                    synchronizeDialectUiState(defaultDialectKind);
                    updateAccentPreview();
                    renderList();
                }

                function buildConnectionData(includeNameFallback) {
                    const dialect = getSelectedDialect();
                    const data = {
                        name: document.getElementById('name').value,
                        dbType: dialect.kind,
                        accentColor: document.getElementById('accentColor').value || undefined
                    };
                    const options = {};

                    dialect.connectionForm.fields.forEach(field => {
                        const element = document.getElementById(field.key);
                        const value = readFieldValue(field, element);

                        if (field.storage === 'options') {
                            options[field.key] = value;
                        } else {
                            data[field.key] = value;
                        }
                    });

                    if (Object.keys(options).length > 0) {
                        data.options = options;
                    }

                    if (includeNameFallback && !data.name) {
                        data.name = 'TestConnection';
                    }

                    return data;
                }

                function save() {
                    vscode.postMessage({
                        command: 'save',
                        data: buildConnectionData(false),
                        originalName: currentEditName,
                        passwordChanged: passwordDirty
                    });
                }

                function testConnection() {
                    vscode.postMessage({
                        command: 'test',
                        data: buildConnectionData(true),
                        originalName: currentEditName,
                        passwordChanged: passwordDirty
                    });
                }

                function del() {
                    if (currentEditName) {
                        vscode.postMessage({
                            command: 'delete',
                            name: currentEditName
                        });
                    }
                }
            </script>
        </body>
        </html>`;
    }
}
