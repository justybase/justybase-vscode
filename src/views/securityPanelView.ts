import * as vscode from 'vscode';
import type {
    PermissionPayload,
    SecurityPanelInboundMessage,
    SecurityPanelOutboundMessage,
    SecurityPrincipal
} from '../contracts/webviews';
import { ConnectionManager } from '../core/connectionManager';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';

const OBJECT_PRIVILEGES = new Set([
    'ALL',
    'ALL PRIVILEGES',
    'ABORT',
    'ALTER',
    'DELETE',
    'DROP',
    'EXECUTE',
    'EXECUTE AS',
    'GENSTATS',
    'GROOM',
    'INSERT',
    'LABEL ACCESS',
    'LABEL RESTRICT',
    'LABEL EXPAND',
    'LIST',
    'SELECT',
    'TRUNCATE',
    'UNFENCE',
    'UPDATE'
]);

const ADMIN_PRIVILEGES = new Set([
    'ALL ADMIN',
    'BACKUP',
    'AGGREGATE',
    'CREATE AGGREGATE',
    'DATABASE',
    'CREATE DATABASE',
    'EXTERNAL TABLE',
    'CREATE EXTERNAL TABLE',
    'FUNCTION',
    'CREATE FUNCTION',
    'GROUP',
    'CREATE GROUP',
    'LIBRARY',
    'CREATE LIBRARY',
    'MATERIALIZED VIEW',
    'CREATE MATERIALIZED VIEW',
    'PROCEDURE',
    'CREATE PROCEDURE',
    'SCHEDULER RULE',
    'CREATE SCHEDULER RULE',
    'SEQUENCE',
    'CREATE SEQUENCE',
    'SYNONYM',
    'CREATE SYNONYM',
    'TABLE',
    'CREATE TABLE',
    'TEMP TABLE',
    'CREATE TEMP TABLE',
    'USER',
    'CREATE USER',
    'VIEW',
    'CREATE VIEW',
    'HARDWARE',
    'MANAGE HARDWARE',
    'SECURITY',
    'MANAGE SECURITY',
    'SYSTEM',
    'MANAGE SYSTEM',
    'RESTORE'
]);

const OBJECT_TYPES = new Set([
    'AGGREGATE',
    'DATABASE',
    'EXTERNAL TABLE',
    'FUNCTION',
    'GROUP',
    'MANAGEMENT TABLE',
    'MANAGEMENT VIEW',
    'PROCEDURE',
    'SCHEMA',
    'SEQUENCE',
    'SYNONYM',
    'SYSTEM TABLE',
    'SYSTEM VIEW',
    'TABLE',
    'USER',
    'VIEW'
]);

export class SecurityPanelView {
    public static readonly viewType = 'netezza.securityPanel';
    private static currentPanel: SecurityPanelView | undefined;

    private _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    private readonly _connectionManager: ConnectionManager;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;
        this._connectionManager = connectionManager;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message: SecurityPanelInboundMessage) => {
                switch (message.command) {
                    case 'loadData':
                        await this._loadData();
                        return;
                    case 'previewSql':
                        await this._previewSql(message.payload);
                        return;
                    case 'executeSql':
                        await this._executeSql(message.payload);
                        return;
                }
            },
            null,
            this._disposables
        );

        this._loadData();
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager
    ) {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : undefined;

        if (SecurityPanelView.currentPanel) {
            SecurityPanelView.currentPanel._panel.reveal(column);
            SecurityPanelView.currentPanel._loadData();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            SecurityPanelView.viewType,
            'Security Panel',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'dist')
                ],
                retainContextWhenHidden: true
            }
        );

        SecurityPanelView.currentPanel = new SecurityPanelView(panel, extensionUri, context, connectionManager);
    }

    public dispose() {
        SecurityPanelView.currentPanel = undefined;
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _loadData(): Promise<void> {
        this._postMessage({ command: 'setLoading', loading: true });
        try {
            const principals = await this._fetchPrincipals();
            this._postMessage({ command: 'setData', data: { principals } });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._postMessage({ command: 'error', text: `Failed to load security metadata: ${message}` });
        } finally {
            this._postMessage({ command: 'setLoading', loading: false });
        }
    }

    private async _previewSql(payload: PermissionPayload | undefined): Promise<void> {
        const sql = this._buildPermissionSql(payload);
        if (!sql) {
            this._postMessage({
                command: 'error',
                text: 'Invalid permission request. Use valid Netezza identifiers and fields.'
            });
            return;
        }

        this._postMessage({ command: 'previewSql', sql });
    }

    private async _executeSql(payload: PermissionPayload | undefined): Promise<void> {
        const sql = this._buildPermissionSql(payload);
        if (!sql) {
            this._postMessage({
                command: 'error',
                text: 'Invalid permission request. Cannot execute SQL.'
            });
            return;
        }

        try {
            await runQueryRaw(this._context, sql, true, this._connectionManager, undefined);
            vscode.window.showInformationMessage('Security command executed successfully.');
            this._postMessage({ command: 'executed', sql });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to execute security command: ${message}`);
            this._postMessage({ command: 'error', text: `Execution failed: ${message}` });
        }
    }

    private _postMessage(message: SecurityPanelOutboundMessage) {
        void this._panel.webview.postMessage(message);
    }

    private async _fetchPrincipals(): Promise<SecurityPrincipal[]> {
        const sql = `
            SELECT USERNAME AS NAME, 'USER' AS TYPE
            FROM _V_USER
            UNION ALL
            SELECT GROUPNAME AS NAME, 'GROUP' AS TYPE
            FROM _V_GROUP
            ORDER BY TYPE, NAME
            LIMIT 2000
        `;
        try {
            const result = await runQueryRaw(this._context, sql, true, this._connectionManager, undefined, undefined, undefined, undefined, 2000, false);
            if (!result || !result.data) {
                return [];
            }
            return queryResultToRows<SecurityPrincipal>(result);
        } catch {
            const fallbackSql = `
                SELECT USERNAME AS NAME, 'USER' AS TYPE
                FROM _V_USER
                ORDER BY NAME
                LIMIT 2000
            `;
            try {
                const fallbackResult = await runQueryRaw(
                    this._context,
                    fallbackSql,
                    true,
                    this._connectionManager,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    2000,
                    false
                );
                if (!fallbackResult || !fallbackResult.data) {
                    return [];
                }
                return queryResultToRows<SecurityPrincipal>(fallbackResult);
            } catch {
                return [];
            }
        }
    }

    private _buildPermissionSql(payload: PermissionPayload | undefined): string | undefined {
        const normalizedAction = (payload?.action || '').trim().toUpperCase();
        const grantVariant = (payload?.grantVariant || 'object').trim().toLowerCase();

        if (normalizedAction !== 'GRANT' && normalizedAction !== 'REVOKE') {
            return undefined;
        }
        const action: 'GRANT' | 'REVOKE' = normalizedAction;

        if (grantVariant === 'raw') {
            return this._buildRawPermissionSql(payload?.customSql, action);
        }

        if (grantVariant === 'admin') {
            return this._buildAdminPermissionSql(payload, action);
        }

        return this._buildObjectPermissionSql(payload, action);
    }

    private _buildObjectPermissionSql(payload: PermissionPayload | undefined, action: 'GRANT' | 'REVOKE'): string | undefined {
        const privilegeInput = payload?.objectPrivileges || payload?.privilege || '';
        const privileges = this._normalizePrivilegeList(privilegeInput, OBJECT_PRIVILEGES);
        const objectTarget = this._normalizeClause(payload?.objectTarget || this._legacyObjectTarget(payload));
        const typeClause = this._normalizeObjectTypeClause(payload?.objectTypeClause);
        const targetPrincipal = this._buildTargetPrincipal(payload);

        if (!privileges || !objectTarget || !targetPrincipal) {
            return undefined;
        }

        const principalKeyword = action === 'GRANT' ? 'TO' : 'FROM';
        const withGrantOption = action === 'GRANT' && payload?.withGrantOption ? ' WITH GRANT OPTION' : '';
        const optionalTypeClause = typeClause ? ` TYPE ${typeClause}` : '';

        return `${action} ${privileges} ON ${objectTarget}${optionalTypeClause} ${principalKeyword} ${targetPrincipal}${withGrantOption};`;
    }

    private _buildAdminPermissionSql(payload: PermissionPayload | undefined, action: 'GRANT' | 'REVOKE'): string | undefined {
        const privilegeInput = payload?.adminPrivileges || '';
        const privileges = this._normalizePrivilegeList(privilegeInput, ADMIN_PRIVILEGES);
        const scope = this._normalizeClause(payload?.adminScope || '');
        const targetPrincipal = this._buildTargetPrincipal(payload);

        if (!privileges || !targetPrincipal) {
            return undefined;
        }

        const principalKeyword = action === 'GRANT' ? 'TO' : 'FROM';
        const withGrantOption = action === 'GRANT' && payload?.withGrantOption ? ' WITH GRANT OPTION' : '';
        const scopeClause = scope ? ` IN ${scope}` : '';

        return `${action} ${privileges}${scopeClause} ${principalKeyword} ${targetPrincipal}${withGrantOption};`;
    }

    private _buildRawPermissionSql(rawSql: string | undefined, action: 'GRANT' | 'REVOKE'): string | undefined {
        const normalized = (rawSql || '').trim();
        if (!normalized) {
            return undefined;
        }

        const trimmedWithoutTerminator = normalized.endsWith(';')
            ? normalized.substring(0, normalized.length - 1).trim()
            : normalized;
        if (!trimmedWithoutTerminator) {
            return undefined;
        }

        if (
            trimmedWithoutTerminator.includes(';') ||
            trimmedWithoutTerminator.includes('--') ||
            trimmedWithoutTerminator.includes('/*')
        ) {
            return undefined;
        }

        const startsWithAction = new RegExp(`^${action}\\s+`, 'i').test(trimmedWithoutTerminator);
        return startsWithAction ? `${trimmedWithoutTerminator};` : undefined;
    }

    private _legacyObjectTarget(payload: PermissionPayload | undefined): string {
        const legacyObjectType = (payload?.objectType || '').trim().toUpperCase();
        const legacyObjectName = (payload?.objectName || '').trim();
        if (!legacyObjectType || !legacyObjectName) {
            return '';
        }
        return `${legacyObjectType} ${legacyObjectName}`;
    }

    private _normalizePrivilegeList(value: string, allowedPrivileges: Set<string>): string | undefined {
        const parts = value
            .split(',')
            .map(part => this._normalizeKeyword(part))
            .filter((part): part is string => Boolean(part));

        if (parts.length === 0) {
            return undefined;
        }

        return parts.every(part => allowedPrivileges.has(part)) ? parts.join(', ') : undefined;
    }

    private _buildTargetPrincipal(payload: PermissionPayload | undefined): string | undefined {
        const principalType = this._normalizeKeyword(payload?.principalType || 'USER');
        if (principalType === 'PUBLIC') {
            return 'PUBLIC';
        }

        const principalName = this._normalizePrincipal(payload?.principal || '');
        if (!principalName) {
            return undefined;
        }

        return principalType === 'GROUP' ? `GROUP ${principalName}` : principalName;
    }

    private _normalizeObjectTypeClause(value: string | undefined): string | undefined {
        const normalized = this._normalizeKeyword(value || '');
        if (!normalized) {
            return undefined;
        }
        return OBJECT_TYPES.has(normalized) ? normalized : undefined;
    }

    private _normalizePrincipal(value: string): string | undefined {
        const normalized = value.trim();
        if (!normalized) {
            return undefined;
        }
        if (/^"[A-Za-z0-9_.$\s]+"$/.test(normalized)) {
            return normalized;
        }
        const normalizedKeyword = this._normalizeKeyword(normalized);
        return /^[A-Z_][A-Z0-9_$]*$/.test(normalizedKeyword) ? normalizedKeyword : undefined;
    }

    private _normalizeClause(value: string): string | undefined {
        const normalized = value.trim().replace(/\s+/g, ' ');
        if (!normalized || normalized.includes(';') || normalized.includes('--') || normalized.includes('/*')) {
            return undefined;
        }
        return normalized;
    }

    private _normalizeKeyword(value: string): string {
        return value.trim().replace(/\s+/g, ' ').toUpperCase();
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.title = 'Security Panel';
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'securityPanel.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'securityPanel.css'));
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Security Panel</title>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>🔐 Security Panel</h2>
            <button id="refreshBtn" class="btn btn-secondary">↻ Refresh users/groups</button>
        </div>

        <p class="hint">Netezza SQL-first panel for permission management (GRANT / REVOKE).</p>

        <div class="form-grid">
            <label>Action
                <select id="action">
                    <option value="GRANT">GRANT</option>
                    <option value="REVOKE">REVOKE</option>
                </select>
            </label>

            <label>Variant
                <select id="grantVariant">
                    <option value="object">Object privileges (ON ...)</option>
                    <option value="admin">Administration privileges (IN ...)</option>
                    <option value="raw">Raw SQL (full IBM syntax)</option>
                </select>
            </label>

            <label>Principal Type
                <select id="principalType">
                    <option value="USER">USER</option>
                    <option value="GROUP">GROUP</option>
                    <option value="PUBLIC">PUBLIC</option>
                </select>
            </label>

            <label id="principalLabel">Principal
                <input id="principal" type="text" placeholder="e.g. ANALYST_ROLE">
            </label>

            <label id="principalPickerLabel">Pick from detected users/groups
                <select id="principalPicker">
                    <option value="">Select user/group...</option>
                </select>
            </label>

            <label class="variant-section object-variant">Object privileges (comma separated)
                <input
                    id="objectPrivileges"
                    type="text"
                    value="SELECT"
                    placeholder="e.g. SELECT, INSERT, EXECUTE AS, LABEL ACCESS"
                >
            </label>

            <label class="variant-section object-variant">ON target
                <input
                    id="objectTarget"
                    type="text"
                    placeholder="e.g. TABLE SALES, ALL TABLES IN SCHEMA REPORTING, PROCEDURE PROC1(INT)"
                >
            </label>

            <label class="variant-section object-variant">Optional TYPE clause
                <select id="objectTypeClause">
                    <option value="">(none)</option>
                    <option value="AGGREGATE">AGGREGATE</option>
                    <option value="DATABASE">DATABASE</option>
                    <option value="EXTERNAL TABLE">EXTERNAL TABLE</option>
                    <option value="FUNCTION">FUNCTION</option>
                    <option value="GROUP">GROUP</option>
                    <option value="MANAGEMENT TABLE">MANAGEMENT TABLE</option>
                    <option value="MANAGEMENT VIEW">MANAGEMENT VIEW</option>
                    <option value="PROCEDURE">PROCEDURE</option>
                    <option value="SCHEMA">SCHEMA</option>
                    <option value="SEQUENCE">SEQUENCE</option>
                    <option value="SYNONYM">SYNONYM</option>
                    <option value="SYSTEM TABLE">SYSTEM TABLE</option>
                    <option value="SYSTEM VIEW">SYSTEM VIEW</option>
                    <option value="TABLE">TABLE</option>
                    <option value="USER">USER</option>
                    <option value="VIEW">VIEW</option>
                </select>
            </label>

            <label class="variant-section admin-variant hidden">Administration privileges (comma separated)
                <input
                    id="adminPrivileges"
                    type="text"
                    value="CREATE TABLE"
                    placeholder="e.g. CREATE TABLE, MANAGE SECURITY, ALL ADMIN"
                >
            </label>

            <label class="variant-section admin-variant hidden">Optional IN scope
                <input id="adminScope" type="text" placeholder="e.g. MYDB.ALL or ALL.ALL">
            </label>

            <label class="variant-section raw-variant full-width hidden">Raw SQL (full IBM GRANT/REVOKE syntax)
                <textarea id="customSql" rows="4" placeholder="GRANT CREATE TABLE IN MYDB.MYSCHEMA TO GROUP ANALYSTS;"></textarea>
            </label>

            <label class="checkbox-label" id="grantOptionRow">
                <span class="checkbox-label-text">Grant Option</span>
                <span class="checkbox-wrapper">
                    <input id="withGrantOption" type="checkbox">
                    <span>WITH GRANT OPTION</span>
                </span>
            </label>
        </div>

        <div class="actions">
            <button id="previewBtn" class="btn btn-primary">Preview SQL</button>
            <button id="executeBtn" class="btn btn-danger">Execute</button>
        </div>

        <div class="section">
            <h3>SQL Preview</h3>
            <textarea id="sqlPreview" readonly></textarea>
            <div id="statusMessage" class="status-message"></div>
        </div>

        <div class="section">
            <h3>Detected Users / Groups</h3>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Type</th>
                        </tr>
                    </thead>
                    <tbody id="principalTableBody">
                        <tr><td colspan="2" class="empty">No data loaded</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
