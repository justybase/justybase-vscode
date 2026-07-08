import * as vscode from 'vscode';
import { FavoritesManager } from '../core/favoritesManager';

type WebviewMessage = Record<string, unknown>;

export class CopilotTableProfilesView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'netezza.copilotProfiles';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _favoritesManager: FavoritesManager
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async data => {
            await this.handleMessage(data);
        });

        void this.postProfiles();
    }

    private async handleMessage(data: unknown): Promise<void> {
        if (!data || typeof data !== 'object') {
            return;
        }

        const message = data as WebviewMessage;
        const type = this.getString(message.type);

        try {
            switch (type) {
                case 'loadProfiles':
                    await this.postProfiles();
                    return;
                case 'saveProfile':
                    await this.handleSaveProfile(message);
                    return;
                case 'deleteProfile':
                    await this.handleDeleteProfile(message);
                    return;
                case 'includeNow':
                    await this.handleIncludeNow(message);
                    return;
                default:
                    return;
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.postResult('error', errorMessage);
        }
    }

    private async handleSaveProfile(message: WebviewMessage): Promise<void> {
        const profileRaw = this.getObject(message.profile);
        const id = this.getString(profileRaw.id).trim();

        // Update Copilot settings on existing favorite
        if (id) {
            await this._favoritesManager.setCopilotSettings(id, {
                autoInclude: this.getBoolean(profileRaw.autoInclude, true),
                enabled: this.getBoolean(profileRaw.enabled, true)
            });

            // Update note if provided
            const notes = this.getString(profileRaw.notes);
            if (notes !== undefined) {
                await this._favoritesManager.updateNote(id, notes);
            }
        }

        await this.postProfiles();
        this.postResult('info', 'Profile saved.');
    }

    private async handleDeleteProfile(message: WebviewMessage): Promise<void> {
        const profileId = this.getString(message.profileId).trim();
        if (!profileId) {
            throw new Error('Profile id is required');
        }
        await this._favoritesManager.removeFavoriteById(profileId);
        await this.postProfiles();
        this.postResult('info', 'Profile removed.');
    }

    private async handleIncludeNow(message: WebviewMessage): Promise<void> {
        const profileId = this.getString(message.profileId).trim();
        if (!profileId) {
            throw new Error('Profile id is required');
        }
        const included = await this._favoritesManager.includeNow(profileId);
        if (!included) {
            throw new Error(`Profile "${profileId}" was not found`);
        }
        await this.postProfiles();
        this.postResult('info', 'Profile will be included in the next Copilot request.');
    }

    private async postProfiles(): Promise<void> {
        if (!this._view) {
            return;
        }
        const favorites = await this._favoritesManager.getTableProfilesForCopilot();
        const profiles = favorites.map(f => ({
            id: f.id,
            database: f.dbName || '',
            schema: f.schema || '',
            table: f.label,
            notes: f.customNote || '',
            autoInclude: f.autoInclude !== false,
            enabled: f.enabled !== false
        }));
        this._view.webview.postMessage({ type: 'profilesData', profiles });
    }

    private postResult(level: 'info' | 'error', message: string): void {
        this._view?.webview.postMessage({
            type: 'operationResult',
            level,
            message
        });
    }

    private getObject(value: unknown): WebviewMessage {
        if (!value || typeof value !== 'object') {
            return {};
        }
        return value as WebviewMessage;
    }

    private getString(value: unknown): string {
        return typeof value === 'string' ? value : '';
    }

    private getBoolean(value: unknown, defaultValue: boolean): boolean {
        if (typeof value === 'boolean') {
            return value;
        }
        return defaultValue;
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = this.createNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Copilot Favorite Tables</title>
    <style nonce="${nonce}">
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            margin: 0;
            padding: 10px;
        }
        .info-box {
            background: var(--vscode-editorInfo-background, var(--vscode-editor-background));
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px;
            margin-bottom: 10px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .section {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px;
            margin-bottom: 10px;
        }
        .row {
            display: flex;
            gap: 6px;
            margin-bottom: 6px;
        }
        input, textarea {
            width: 100%;
            box-sizing: border-box;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 6px;
        }
        textarea {
            min-height: 64px;
            resize: vertical;
        }
        button {
            border: 1px solid var(--vscode-contrastBorder, transparent);
            border-radius: 2px;
            padding: 4px 8px;
            cursor: pointer;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }
        button.secondary {
            color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground);
        }
        ul {
            list-style: none;
            padding: 0;
            margin: 0;
        }
        li {
            border-top: 1px solid var(--vscode-panel-border);
            padding: 8px 0;
        }
        .title {
            font-weight: 600;
        }
        .meta {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            margin: 4px 0;
        }
        .status {
            font-size: 12px;
            margin-bottom: 6px;
        }
        .message {
            font-size: 12px;
            margin-bottom: 8px;
            min-height: 16px;
        }
    </style>
</head>
<body>
    <div class="message" id="statusMessage"></div>

    <div class="info-box">
        💡 This view shows your <strong>Favorite tables</strong> from the Schema browser. Add tables to Favorites using the ⭐ icon in the Schema tree, then configure their Copilot settings here.
    </div>

    <div class="section" id="editSection" style="display: none;">
        <div class="row">
            <input id="databaseInput" placeholder="Database" readonly />
            <input id="schemaInput" placeholder="Schema" readonly />
            <input id="tableInput" placeholder="Table" readonly />
        </div>
        <div class="row">
            <textarea id="notesInput" placeholder="Usage notes for Copilot (business rules, caveats, joins, etc.)"></textarea>
        </div>
        <div class="row">
            <label><input type="checkbox" id="autoIncludeInput" checked /> Auto include</label>
            <label><input type="checkbox" id="enabledInput" checked /> Enabled</label>
        </div>
        <div class="row">
            <button id="saveBtn">Save Settings</button>
            <button id="resetBtn" class="secondary">Cancel</button>
        </div>
    </div>

    <div class="section">
        <div class="row" style="justify-content: space-between; align-items: center;">
            <strong>Favorite Tables for Copilot</strong>
            <button id="refreshBtn" class="secondary">Refresh</button>
        </div>
        <ul id="profilesList"></ul>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const profilesList = document.getElementById('profilesList');
        const statusMessage = document.getElementById('statusMessage');
        const editSection = document.getElementById('editSection');
        const databaseInput = document.getElementById('databaseInput');
        const schemaInput = document.getElementById('schemaInput');
        const tableInput = document.getElementById('tableInput');
        const notesInput = document.getElementById('notesInput');
        const autoIncludeInput = document.getElementById('autoIncludeInput');
        const enabledInput = document.getElementById('enabledInput');
        const saveBtn = document.getElementById('saveBtn');
        const resetBtn = document.getElementById('resetBtn');
        const refreshBtn = document.getElementById('refreshBtn');

        let profiles = [];
        let editingId = '';

        function setStatus(message, level) {
            statusMessage.textContent = message || '';
            statusMessage.style.color = level === 'error'
                ? 'var(--vscode-errorForeground)'
                : 'var(--vscode-descriptionForeground)';
        }

        function resetForm() {
            editingId = '';
            editSection.style.display = 'none';
            databaseInput.value = '';
            schemaInput.value = '';
            tableInput.value = '';
            notesInput.value = '';
            autoIncludeInput.checked = true;
            enabledInput.checked = true;
        }

        function saveProfile() {
            if (!editingId) return;
            vscode.postMessage({
                type: 'saveProfile',
                profile: {
                    id: editingId,
                    notes: notesInput.value,
                    autoInclude: autoIncludeInput.checked,
                    enabled: enabledInput.checked
                }
            });
        }

        function includeNow(profileId) {
            vscode.postMessage({ type: 'includeNow', profileId });
        }

        function removeProfile(profileId) {
            vscode.postMessage({ type: 'deleteProfile', profileId });
        }

        function editProfile(profileId) {
            const profile = profiles.find(item => item.id === profileId);
            if (!profile) {
                return;
            }
            editingId = profile.id || '';
            databaseInput.value = profile.database || '';
            schemaInput.value = profile.schema || '';
            tableInput.value = profile.table || '';
            notesInput.value = profile.notes || '';
            autoIncludeInput.checked = profile.autoInclude !== false;
            enabledInput.checked = profile.enabled !== false;
            editSection.style.display = 'block';
        }

        function renderProfiles() {
            profilesList.innerHTML = '';
            if (!profiles || profiles.length === 0) {
                const emptyItem = document.createElement('li');
                emptyItem.innerHTML = 'No favorite tables found.<br/><small>Add tables to Favorites in the Schema browser using the ⭐ icon.</small>';
                profilesList.appendChild(emptyItem);
                return;
            }

            for (const profile of profiles) {
                const item = document.createElement('li');

                const title = document.createElement('div');
                title.className = 'title';
                title.textContent = (profile.database || '') + '.' + (profile.schema || '') + '.' + (profile.table || '');
                item.appendChild(title);

                const status = document.createElement('div');
                status.className = 'status';
                const modes = [];
                if (profile.enabled) {
                    modes.push(profile.autoInclude ? 'auto' : 'manual');
                } else {
                    modes.push('disabled');
                }
                status.textContent = 'Mode: ' + modes.join(', ');
                item.appendChild(status);

                if (profile.notes) {
                    const notes = document.createElement('div');
                    notes.className = 'meta';
                    notes.textContent = profile.notes;
                    item.appendChild(notes);
                }

                const actions = document.createElement('div');
                actions.className = 'row';

                const editBtn = document.createElement('button');
                editBtn.className = 'secondary';
                editBtn.textContent = 'Edit';
                editBtn.onclick = () => editProfile(profile.id);
                actions.appendChild(editBtn);

                const includeBtn = document.createElement('button');
                includeBtn.className = 'secondary';
                includeBtn.textContent = 'Include Next';
                includeBtn.onclick = () => includeNow(profile.id);
                actions.appendChild(includeBtn);

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'secondary';
                deleteBtn.textContent = 'Remove';
                deleteBtn.onclick = () => removeProfile(profile.id);
                actions.appendChild(deleteBtn);

                item.appendChild(actions);
                profilesList.appendChild(item);
            }
        }

        saveBtn.addEventListener('click', saveProfile);
        resetBtn.addEventListener('click', () => {
            resetForm();
            setStatus('', 'info');
        });
        refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'loadProfiles' }));

        window.addEventListener('message', event => {
            const message = event.data || {};
            if (message.type === 'profilesData') {
                profiles = Array.isArray(message.profiles) ? message.profiles : [];
                renderProfiles();
                return;
            }
            if (message.type === 'operationResult') {
                setStatus(message.message || '', message.level || 'info');
                if (message.level !== 'error') {
                    resetForm();
                }
            }
        });

        vscode.postMessage({ type: 'loadProfiles' });
    </script>
</body>
</html>`;
    }

    private createNonce(): string {
        let result = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
}
