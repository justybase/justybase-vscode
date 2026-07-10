import * as vscode from 'vscode';
import type {
    SessionMonitorAlert,
    SessionMonitorAlertSettings,
    SessionMonitorData,
    SessionMonitorInboundMessage,
    SessionMonitorOutboundMessage,
    SessionMonitorOverview,
    SessionMonitorQuery,
    SessionMonitorResources,
    SessionMonitorSession,
    SessionMonitorStorageInfo
} from '../contracts/webviews';
import type { DatabaseSessionMonitorProvider } from '../contracts/database';
import { ConnectionManager } from '../core/connectionManager';
import { compatibilityStateKeys, getMementoValue, updateMementoValue } from '../compatibility/state';

type AlertSettings = SessionMonitorAlertSettings;

const DEFAULT_ALERT_SETTINGS: AlertSettings = {
    enabled: true,
    sessionThreshold: 25,
    queryThreshold: 10,
    hostCpuThreshold: 85,
    spuCpuThreshold: 85,
    memoryThreshold: 90
};

export class SessionMonitorView {
    public static readonly viewType = 'netezza.sessionMonitor';
    private static currentPanel: SessionMonitorView | undefined;
    private _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _context: vscode.ExtensionContext;
    private _connectionManager: ConnectionManager;
    private _refreshInterval: NodeJS.Timeout | undefined;

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
            async (message: SessionMonitorInboundMessage) => {
                switch (message.command) {
                    case 'refresh':
                        await this._fetchAndSendData();
                        return;
                    case 'killSession':
                        await this._killSession(message.sessionId, message.status);
                        return;
                    case 'toggleAutoRefresh':
                        this._toggleAutoRefresh(message.enabled);
                        return;
                    case 'updateAlertSettings':
                        await this._updateAlertSettings(message.settings);
                        await this._fetchAndSendData();
                        return;
                }
            },
            null,
            this._disposables
        );

        // Initial data load
        this._fetchAndSendData();
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager
    ) {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : undefined;

        if (SessionMonitorView.currentPanel) {
            SessionMonitorView.currentPanel._panel.reveal(column);
            SessionMonitorView.currentPanel._fetchAndSendData();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            SessionMonitorView.viewType,
            'Session Monitor',
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

        SessionMonitorView.currentPanel = new SessionMonitorView(panel, extensionUri, context, connectionManager);
    }

    public dispose() {
        SessionMonitorView.currentPanel = undefined;

        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
        }

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _toggleAutoRefresh(enabled: boolean) {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
            this._refreshInterval = undefined;
        }

        if (enabled) {
            this._refreshInterval = setInterval(() => {
                this._fetchAndSendData();
            }, 120000); // 2 minutes
        }
    }

    private async _getProvider(): Promise<DatabaseSessionMonitorProvider | undefined> {
        const activeName = this._connectionManager.getActiveConnectionName();
        if (!activeName) return undefined;
        const details = await this._connectionManager.getConnection(activeName);
        if (!details?.dbType) return undefined;
        const { getDatabaseDialectByKind } = await import('../core/factories/databaseDialectRegistry');
        const dialect = getDatabaseDialectByKind(details.dbType);
        if (dialect?.capabilities.supportsSessionMonitor && dialect.advancedFeatures?.sessionMonitor) {
            return dialect.advancedFeatures.sessionMonitor;
        }
        return undefined;
    }

    private async _killSession(sessionId: number, status?: string): Promise<void> {
        try {
            const statusHint = status ? ` (status: ${status})` : '';
            const confirmation = await vscode.window.showWarningMessage(
                `Are you sure you want to terminate session ${sessionId}${statusHint}?`,
                { modal: true },
                'Yes, Kill Session'
            );

            if (confirmation !== 'Yes, Kill Session') {
                return;
            }

            const provider = await this._getProvider();
            if (provider) {
                await provider.killSession(this._context, this._connectionManager, sessionId);
                vscode.window.showInformationMessage(`Session ${sessionId} terminated successfully.`);
                // Refresh data
                await this._fetchAndSendData();
            } else {
                throw new Error("Session Monitor is not supported on this connection.");
            }
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`Failed to kill session: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private async _fetchAndSendData(): Promise<void> {
        this._postMessage({ command: 'setLoading', loading: true });

        try {
            const [sessions, queries, storage, resources] = await Promise.all([
                this._fetchSessions(),
                this._fetchQueries(),
                this._fetchStorage(),
                this._fetchResources()
            ]);
            const overview = this._buildOverview(sessions, queries, resources.sysUtilSummary);
            const alertSettings = this._getAlertSettings();
            const alerts = this._buildAlerts(overview, alertSettings);

            const data: SessionMonitorData = {
                sessions,
                queries,
                storage,
                resources,
                overview,
                alertSettings,
                alerts,
                refreshedAt: new Date().toISOString()
            };

            this._postMessage({
                command: 'updateData',
                data
            });
        } catch (err: unknown) {
            this._postMessage({
                command: 'error',
                text: `Failed to fetch data: ${err instanceof Error ? err.message : String(err)}`
            });
        } finally {
            this._postMessage({ command: 'setLoading', loading: false });
        }
    }

    private async _updateAlertSettings(settings: Partial<AlertSettings> | undefined): Promise<void> {
        const current = this._getAlertSettings();
        const next: AlertSettings = {
            enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : current.enabled,
            sessionThreshold: this._clampThreshold(settings?.sessionThreshold, current.sessionThreshold),
            queryThreshold: this._clampThreshold(settings?.queryThreshold, current.queryThreshold),
            hostCpuThreshold: this._clampThreshold(settings?.hostCpuThreshold, current.hostCpuThreshold),
            spuCpuThreshold: this._clampThreshold(settings?.spuCpuThreshold, current.spuCpuThreshold),
            memoryThreshold: this._clampThreshold(settings?.memoryThreshold, current.memoryThreshold)
        };
        await updateMementoValue(this._context.globalState, compatibilityStateKeys.sessionMonitorAlertSettings, next);
    }

    private _postMessage(message: SessionMonitorOutboundMessage): void {
        void this._panel.webview.postMessage(message);
    }

    private _getAlertSettings(): AlertSettings {
        const stored = getMementoValue<Partial<AlertSettings>>(
            this._context.globalState,
            compatibilityStateKeys.sessionMonitorAlertSettings
        );
        return {
            enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : DEFAULT_ALERT_SETTINGS.enabled,
            sessionThreshold: this._clampThreshold(stored?.sessionThreshold, DEFAULT_ALERT_SETTINGS.sessionThreshold),
            queryThreshold: this._clampThreshold(stored?.queryThreshold, DEFAULT_ALERT_SETTINGS.queryThreshold),
            hostCpuThreshold: this._clampThreshold(stored?.hostCpuThreshold, DEFAULT_ALERT_SETTINGS.hostCpuThreshold),
            spuCpuThreshold: this._clampThreshold(stored?.spuCpuThreshold, DEFAULT_ALERT_SETTINGS.spuCpuThreshold),
            memoryThreshold: this._clampThreshold(stored?.memoryThreshold, DEFAULT_ALERT_SETTINGS.memoryThreshold)
        };
    }

    private _buildOverview(sessions: SessionMonitorSession[], queries: SessionMonitorQuery[], sysUtilSummary: unknown): SessionMonitorOverview {
        const summary = typeof sysUtilSummary === 'object' && sysUtilSummary !== null
            ? sysUtilSummary as Record<string, unknown>
            : {};
        const avgHostCpuPct = this._toNumber(summary.AVG_HOST_CPU_PCT);
        const avgSpuCpuPct = this._toNumber(summary.AVG_SPU_CPU_PCT);
        const avgMemoryPct = this._toNumber(summary.AVG_MEMORY_PCT);

        const activeSessions = sessions.length;
        const runningQueries = queries.length;
        const queryPressure = activeSessions > 0
            ? Math.min(100, Math.round((runningQueries / activeSessions) * 100))
            : 0;
        const rawScore = Math.round(
            avgHostCpuPct * 0.3 +
            avgSpuCpuPct * 0.3 +
            avgMemoryPct * 0.2 +
            queryPressure * 0.2
        );
        const loadScore = Math.max(0, Math.min(100, rawScore));

        return {
            activeSessions,
            runningQueries,
            avgHostCpuPct,
            avgSpuCpuPct,
            avgMemoryPct,
            loadScore,
            loadLevel: this._loadLevelFromScore(loadScore)
        };
    }

    private _buildAlerts(overview: SessionMonitorOverview, settings: AlertSettings): SessionMonitorAlert[] {
        if (!settings.enabled) {
            return [];
        }

        const alerts: SessionMonitorAlert[] = [];

        if (overview.activeSessions >= settings.sessionThreshold) {
            alerts.push(this._createAlert('sessions', 'Active sessions', overview.activeSessions, settings.sessionThreshold));
        }
        if (overview.runningQueries >= settings.queryThreshold) {
            alerts.push(this._createAlert('queries', 'Running queries', overview.runningQueries, settings.queryThreshold));
        }
        if (overview.avgHostCpuPct >= settings.hostCpuThreshold) {
            alerts.push(this._createAlert('host-cpu', 'Host CPU', overview.avgHostCpuPct, settings.hostCpuThreshold));
        }
        if (overview.avgSpuCpuPct >= settings.spuCpuThreshold) {
            alerts.push(this._createAlert('spu-cpu', 'SPU CPU', overview.avgSpuCpuPct, settings.spuCpuThreshold));
        }
        if (overview.avgMemoryPct >= settings.memoryThreshold) {
            alerts.push(this._createAlert('memory', 'Memory', overview.avgMemoryPct, settings.memoryThreshold));
        }

        return alerts;
    }

    private _createAlert(metric: string, label: string, value: number, threshold: number): SessionMonitorAlert {
        const level = value >= threshold + 15 ? 'critical' : 'warning';
        return {
            id: metric,
            metric,
            level,
            message: `${label} is above threshold (${value.toFixed(1)} / ${threshold}).`,
            value,
            threshold
        };
    }

    private _toNumber(value: unknown): number {
        if (typeof value === 'number') {
            return Number.isFinite(value) ? value : 0;
        }
        if (typeof value === 'bigint') {
            const converted = Number(value);
            return Number.isFinite(converted) ? converted : 0;
        }
        if (typeof value === 'string') {
            const parsed = Number.parseFloat(value);
            return Number.isFinite(parsed) ? parsed : 0;
        }
        return 0;
    }

    private _clampThreshold(value: unknown, fallback: number): number {
        const parsed = this._toNumber(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return fallback;
        }
        return Math.max(1, Math.min(1000, Math.round(parsed)));
    }

    private _loadLevelFromScore(score: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
        if (score >= 85) {
            return 'CRITICAL';
        }
        if (score >= 65) {
            return 'HIGH';
        }
        if (score >= 35) {
            return 'MEDIUM';
        }
        return 'LOW';
    }

    private async _resolveScopedDatabase(): Promise<string | undefined> {
        const manager = this._connectionManager as unknown as {
            getActiveConnectionName?: () => string | undefined;
            getCurrentDatabase?: (connectionName: string) => Promise<string | undefined>;
        };

        const activeConnectionName = manager.getActiveConnectionName?.();
        if (!activeConnectionName || !manager.getCurrentDatabase) {
            return undefined;
        }

        try {
            const database = await manager.getCurrentDatabase(activeConnectionName);
            const normalized = database?.trim();
            return normalized && normalized.length > 0 ? normalized : undefined;
        } catch {
            return undefined;
        }
    }

    private async _fetchSessions(): Promise<SessionMonitorSession[]> {
        const provider = await this._getProvider();
        if (!provider) return [];
        const scopedDatabase = await this._resolveScopedDatabase();
        try {
            return await provider.getSessions(this._context, this._connectionManager, scopedDatabase) as SessionMonitorSession[];
        } catch (e: unknown) {
            console.error('[SessionMonitorView] Error fetching sessions:', e);
            vscode.window.showErrorMessage(`Failed to fetch sessions: ${e instanceof Error ? e.message : String(e)}`);
            return [];
        }
    }

    private async _fetchQueries(): Promise<SessionMonitorQuery[]> {
        const provider = await this._getProvider();
        if (!provider) return [];
        const scopedDatabase = await this._resolveScopedDatabase();
        try {
            return await provider.getQueries(this._context, this._connectionManager, scopedDatabase) as SessionMonitorQuery[];
        } catch (e: unknown) {
            console.error('[SessionMonitorView] Error fetching queries:', e);
            vscode.window.showErrorMessage(`Failed to fetch queries: ${e instanceof Error ? e.message : String(e)}`);
            return [];
        }
    }

    private async _fetchStorage(): Promise<SessionMonitorStorageInfo[]> {
        const provider = await this._getProvider();
        if (!provider) return [];
        try {
            return await provider.getStorage(this._context, this._connectionManager) as SessionMonitorStorageInfo[];
        } catch (e: unknown) {
            console.error('[SessionMonitorView] Error fetching storage:', e);
            vscode.window.showErrorMessage(`Failed to fetch storage info: ${e instanceof Error ? e.message : String(e)}`);
            return [];
        }
    }

    private async _fetchResources(): Promise<SessionMonitorResources> {
        const provider = await this._getProvider();
        if (!provider) return { gra: [], systemUtil: [], sysUtilSummary: null };
        try {
            return await provider.getResources(this._context, this._connectionManager) as SessionMonitorResources;
        } catch (e: unknown) {
            console.warn('[SessionMonitorView] failed to fetch resources:', e);
            return { gra: [], systemUtil: [], sysUtilSummary: null };
        }
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.title = 'Session Monitor';
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'sessionMonitor.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'sessionMonitor.css'));

        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Session Monitor</title>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>Session Monitor</h2>
            <div class="header-actions">
                <label class="auto-refresh">
                    <input type="checkbox" id="autoRefresh"> Auto-refresh
                </label>
                <div class="refresh-indicator" id="refreshIndicator" aria-hidden="true" title="Refreshing…">
                    <svg class="refresh-spinner" viewBox="0 0 50 50" aria-hidden="true">
                        <circle class="refresh-spinner-circle" cx="25" cy="25" r="20" fill="none" stroke-width="5"/>
                        <path class="refresh-spinner-path" d="M25 5 A20 20 0 0 1 45 25" fill="none" stroke-width="5"/>
                    </svg>
                </div>
                <button id="refreshBtn" class="btn">↻ Refresh</button>
            </div>
        </div>

        <div class="overview-strip">
            <div class="overview-card">
                <span class="overview-label">Active Sessions</span>
                <span class="overview-value" id="overviewSessions">0</span>
            </div>
            <div class="overview-card">
                <span class="overview-label">Running Queries</span>
                <span class="overview-value" id="overviewQueries">0</span>
            </div>
            <div class="overview-card">
                <span class="overview-label">Host CPU</span>
                <span class="overview-value" id="overviewHostCpu">0%</span>
            </div>
            <div class="overview-card">
                <span class="overview-label">SPU CPU</span>
                <span class="overview-value" id="overviewSpuCpu">0%</span>
            </div>
            <div class="overview-card">
                <span class="overview-label">Memory</span>
                <span class="overview-value" id="overviewMemory">0%</span>
            </div>
            <div class="overview-card">
                <span class="overview-label">Load</span>
                <span class="overview-value" id="overviewLoadScore">0%</span>
                <span class="load-level load-low" id="overviewLoadLevel">LOW</span>
            </div>
            <div class="overview-card">
                <span class="overview-label">Refreshed</span>
                <span class="overview-value small" id="overviewRefreshedAt">—</span>
            </div>
        </div>

        <div class="tabs">
            <button class="tab-btn active" data-tab="sessions">Sessions <span class="tab-count" id="sessionTabCount">0</span></button>
            <button class="tab-btn" data-tab="queries">Queries <span class="tab-count" id="queryTabCount">0</span></button>
            <button class="tab-btn" data-tab="storage">Storage</button>
            <button class="tab-btn" data-tab="resources">Resources</button>
            <button class="tab-btn" data-tab="alerts">Alerts <span class="tab-count" id="alertTabCount">0</span></button>
        </div>

        <div class="tab-content" id="sessions">
            <div class="section-header">
                <h3>Active Sessions</h3>
                <span class="spacer"></span>
                <div class="filter-controls">
                    <input type="text" id="sessionUserFilter" placeholder="Filter user…" class="filter-input">
                </div>
                <span class="count" id="sessionCount">0</span>
            </div>
            <div class="table-container">
                <table id="sessionsTable">
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>PID</th>
                            <th>User</th>
                            <th>Database</th>
                            <th>Type</th>
                            <th>Connected</th>
                            <th>Status</th>
                            <th>IP</th>
                            <th>Command</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>
        </div>

        <div class="tab-content hidden" id="queries">
            <div class="section-header">
                <h3>Running Queries</h3>
                <span class="spacer"></span>
                <div class="filter-controls">
                    <input type="text" id="queryUserFilter" placeholder="Filter user…" class="filter-input">
                </div>
                <span class="count" id="queryCount">0</span>
            </div>
            <div class="table-container">
                <table id="queriesTable">
                    <thead>
                        <tr>
                            <th>Session</th>
                            <th>User</th>
                            <th>Plan ID</th>
                            <th>State</th>
                            <th>Priority</th>
                            <th>Submitted</th>
                            <th>Started</th>
                            <th>Est. Cost</th>
                            <th>Rows</th>
                            <th>SQL</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>
        </div>

        <div class="tab-content hidden" id="storage">
            <div class="section-header">
                <h3>Storage by Schema</h3>
                <span class="spacer"></span>
                <span class="count" id="storageCount">0</span>
            </div>
            <div class="table-container">
                <table id="storageTable">
                    <thead>
                        <tr>
                            <th>Database</th>
                            <th>Schema</th>
                            <th>Allocated (MB)</th>
                            <th>Used (MB)</th>
                            <th>Usage %</th>
                            <th>Avg Skew</th>
                            <th>Tables</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>
        </div>

        <div class="tab-content hidden" id="resources">
            <div class="section-header">
                <h3>Resource Utilization</h3>
            </div>
            <div class="resources-grid">
                <div class="resource-section">
                    <h4>GRA Scheduler</h4>
                    <div id="graTable" class="table-container small"></div>
                </div>
                <div class="resource-section">
                    <h4>System Utilization</h4>
                    <div id="sysUtilSummary"></div>
                    <div id="sysUtilTable" class="table-container small"></div>
                </div>
            </div>
        </div>

        <div class="tab-content hidden" id="alerts">
            <div class="section-header">
                <h3>Alert Triggers</h3>
                <span class="spacer"></span>
                <span class="count" id="alertCount">0</span>
            </div>
            <div class="alert-settings">
                <label>
                    <input type="checkbox" id="alertsEnabled">
                    Enable alerts
                </label>
                <label>Sessions ≥ <input id="sessionThreshold" type="number" min="1" step="1"></label>
                <label>Queries ≥ <input id="queryThreshold" type="number" min="1" step="1"></label>
                <label>Host CPU ≥ <input id="hostCpuThreshold" type="number" min="1" max="100" step="1"></label>
                <label>SPU CPU ≥ <input id="spuCpuThreshold" type="number" min="1" max="100" step="1"></label>
                <label>Memory ≥ <input id="memoryThreshold" type="number" min="1" max="100" step="1"></label>
                <button id="saveAlertSettingsBtn" class="btn btn-primary">Save</button>
            </div>
            <div id="alertsList" class="alerts-list"></div>
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
