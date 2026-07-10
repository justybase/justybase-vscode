import type {
    SessionMonitorAlert,
    SessionMonitorAlertSettings,
    SessionMonitorData,
    SessionMonitorHostToWebviewMessage,
    SessionMonitorOverview,
    SessionMonitorQuery,
    SessionMonitorResources,
    SessionMonitorSession,
    SessionMonitorStorageInfo,
    SessionMonitorViewState,
    SessionMonitorScalar,
    SessionMonitorWebviewToHostMessage,
} from './hostContracts.js';
import { postToHost, asHostMessage } from './protocol.js';
import { getElementById, queryHtml, eventTargetAsInput } from './dom.js';
import {
    escapeHtml,
    formatCostInThousands,
    formatDate,
    formatNumber,
    formatPercent,
    formatRefreshDate,
    formatValue,
    getSkewClass,
    toInt,
} from './utils.js';

function showError(text: string): void {
    console.error('Session Monitor Error:', text);
}

// State
let currentData: SessionMonitorViewState = {
    sessions: [],
    queries: [],
    storage: [],
    resources: {
        gra: [],
        systemUtil: [],
        sysUtilSummary: null
    },
    overview: null,
    alerts: [],
    alertSettings: null,
    refreshedAt: null
};

// DOM Elements
const refreshBtn = getElementById<HTMLButtonElement>('refreshBtn');
const autoRefreshCheckbox = getElementById<HTMLInputElement>('autoRefresh');
const refreshIndicator = getElementById('refreshIndicator');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const saveAlertSettingsBtn = getElementById<HTMLButtonElement>('saveAlertSettingsBtn');
const alertCountEl = getElementById('alertCount');
const alertTabCountEl = getElementById('alertTabCount');
const alertsList = getElementById('alertsList');
const alertsEnabled = getElementById<HTMLInputElement>('alertsEnabled');
const sessionThreshold = getElementById<HTMLInputElement>('sessionThreshold');
const queryThreshold = getElementById<HTMLInputElement>('queryThreshold');
const hostCpuThreshold = getElementById<HTMLInputElement>('hostCpuThreshold');
const spuCpuThreshold = getElementById<HTMLInputElement>('spuCpuThreshold');
const memoryThreshold = getElementById<HTMLInputElement>('memoryThreshold');
const overviewSessions = getElementById('overviewSessions');
const overviewQueries = getElementById('overviewQueries');
const overviewHostCpu = getElementById('overviewHostCpu');
const overviewSpuCpu = getElementById('overviewSpuCpu');
const overviewMemory = getElementById('overviewMemory');
const overviewLoadScore = getElementById('overviewLoadScore');
const overviewLoadLevel = getElementById('overviewLoadLevel');
const overviewRefreshedAt = getElementById('overviewRefreshedAt');
const sessionTabCountEl = getElementById('sessionTabCount');
const queryTabCountEl = getElementById('queryTabCount');

// Filter Inputs
const sessionUserFilter = getElementById<HTMLInputElement>('sessionUserFilter');
const queryUserFilter = getElementById<HTMLInputElement>('queryUserFilter');

// Event Listeners
if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
        postToHost({ command: 'refresh' });
    });
}

if (autoRefreshCheckbox) {
    autoRefreshCheckbox.addEventListener('change', (e) => {
        const target = eventTargetAsInput(e);
        postToHost({ command: 'toggleAutoRefresh', enabled: Boolean(target?.checked) });
    });
}

// Filter listeners
if (sessionUserFilter) {
    sessionUserFilter.addEventListener('input', () => {
        renderSessions();
    });
}

if (queryUserFilter) {
    queryUserFilter.addEventListener('input', () => {
        renderQueries();
    });
}

if (saveAlertSettingsBtn) {
    saveAlertSettingsBtn.addEventListener('click', () => {
        postToHost({
            command: 'updateAlertSettings',
            settings: collectAlertSettings()
        });
    });
}

// Tab switching
tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const tabId = (btn as HTMLElement).dataset.tab;

        tabButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        tabContents.forEach(content => {
            content.classList.toggle('hidden', content.id !== tabId);
        });
    });
});

// Message handling from extension
window.addEventListener('message', event => {
    const message = asHostMessage(event.data);

    switch (message.command) {
        case 'setLoading':
            refreshIndicator?.classList.toggle('visible', message.loading);
            refreshIndicator?.setAttribute('aria-hidden', message.loading ? 'false' : 'true');
            refreshBtn?.toggleAttribute('disabled', message.loading);
            break;
        case 'updateData':
            renderData(message.data);
            break;
        case 'error':
            showError(message.text);
            break;
    }
});

function renderData(data: SessionMonitorData): void {
    currentData = { ...currentData, ...data };

    if (data.sessions) renderSessions();
    if (data.queries) renderQueries();
    if (data.storage) renderStorage(data.storage);
    if (data.resources) renderResources(data.resources);
    if (data.overview) renderOverview(data.overview, data.refreshedAt || currentData.refreshedAt);
    if (data.alertSettings) applyAlertSettings(data.alertSettings);
    if (data.alerts) renderAlerts(data.alerts);
}

function renderSessions() {
    const sessions = currentData.sessions || [];
    const filterValue = (sessionUserFilter?.value ?? '').toLowerCase();

    const filteredSessions = sessions.filter(s => {
        if (!filterValue) return true;
        return (s.USERNAME || '').toLowerCase().includes(filterValue);
    });

    const tbody = queryHtml(document, '#sessionsTable tbody');
    const countEl = getElementById('sessionCount');

    if (countEl) countEl.textContent = String(filteredSessions.length);
    if (sessionTabCountEl) sessionTabCountEl.textContent = String(sessions.length);

    if (!tbody) return;

    if (filteredSessions.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="empty-state">
            <div class="empty-state-icon">📋</div>
            No active sessions found
        </td></tr>`;
        return;
    }

    tbody.innerHTML = filteredSessions.map(s => `
        <tr>
            <td>${s.ID || ''}</td>
            <td>${s.PID || ''}</td>
            <td><strong>${s.USERNAME || ''}</strong></td>
            <td>${s.DBNAME || ''}</td>
            <td>${s.TYPE || ''}</td>
            <td>${formatDate(s.CONNTIME)}</td>
            <td><span class="status-badge status-${(s.STATUS || '').toLowerCase()}">${s.STATUS || ''}</span></td>
            <td>${s.IPADDR || ''}</td>
            <td><div class="sql-preview" title="${escapeHtml(s.COMMAND || '')}">${escapeHtml(s.COMMAND || '')}</div></td>
            <td>
                <button class="btn btn-danger kill-btn" data-session="${s.ID}" data-status="${escapeHtml(s.STATUS || '')}">✕ Kill</button>
            </td>
        </tr>
    `).join('');

    // Attach kill button handlers
    tbody.querySelectorAll('.kill-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const htmlBtn = btn as HTMLElement;
            const sessionId = parseInt(htmlBtn.dataset.session ?? '', 10);
            const status = htmlBtn.dataset.status || '';
            postToHost({ command: 'killSession', sessionId, status });
        });
    });
}

function renderQueries() {
    const queries = currentData.queries || [];
    const filterValue = (queryUserFilter?.value ?? '').toLowerCase();

    const filteredQueries = queries.filter(q => {
        if (!filterValue) return true;
        return (q.USERNAME || '').toLowerCase().includes(filterValue);
    });

    const tbody = queryHtml(document, '#queriesTable tbody');
    const countEl = getElementById('queryCount');

    if (countEl) countEl.textContent = String(filteredQueries.length);
    if (queryTabCountEl) queryTabCountEl.textContent = String(queries.length);

    if (!tbody) return;

    if (filteredQueries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="empty-state">
            <div class="empty-state-icon">⏱️</div>
            No running queries
        </td></tr>`;
        return;
    }

    tbody.innerHTML = filteredQueries.map(q => `
        <tr>
            <td>${q.QS_SESSIONID || ''}</td>
            <td><strong>${q.USERNAME || ''}</strong></td>
            <td>${q.QS_PLANID || ''}</td>
            <td><span class="status-badge status-${(q.QS_STATE || '').toLowerCase()}">${q.QS_STATE || ''}</span></td>
            <td>${q.QS_PRITXT || q.QS_PRIORITY || ''}</td>
            <td>${formatDate(q.QS_TSUBMIT)}</td>
            <td>${formatDate(q.QS_TSTART)}</td>
            <td>${formatCostInThousands(q.QS_ESTCOST)}</td>
            <td>${formatNumber(q.QS_RESROWS)}</td>
            <td><div class="sql-preview" title="${escapeHtml(q.QS_SQL || '')}">${escapeHtml(q.QS_SQL || '')}</div></td>
            <td>
                <button class="btn btn-danger query-kill-btn" data-session="${q.QS_SESSIONID}" data-status="${escapeHtml(q.QS_STATE || '')}">✕ Kill</button>
            </td>
        </tr>
    `).join('');

    // Attach kill button handlers for queries
    tbody.querySelectorAll('.query-kill-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const htmlBtn = btn as HTMLElement;
            const sessionId = parseInt(htmlBtn.dataset.session ?? '', 10);
            postToHost({ command: 'killSession', sessionId });
        });
    });
}

function renderStorage(storage: SessionMonitorStorageInfo[]) {
    const tbody = queryHtml(document, '#storageTable tbody');
    const countEl = getElementById('storageCount');

    if (countEl) countEl.textContent = String(storage.length);
    if (!tbody) return;

    if (storage.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state">
            <div class="empty-state-icon">💾</div>
            No storage data available
        </td></tr>`;
        return;
    }

    tbody.innerHTML = storage.map(s => {
        const usagePercent = s.ALLOC_MB > 0 ? ((s.USED_MB / s.ALLOC_MB) * 100).toFixed(1) : 0;
        const skewClass = getSkewClass(s.AVG_SKEW);

        return `
            <tr>
                <td>${s.DATABASE || ''}</td>
                <td><strong>${s.SCHEMA || ''}</strong></td>
                <td>${formatNumber(s.ALLOC_MB)} MB</td>
                <td>${formatNumber(s.USED_MB)} MB</td>
                <td>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${usagePercent}%"></div>
                    </div>
                    <div class="progress-text">${usagePercent}%</div>
                </td>
                <td><span class="skew-indicator ${skewClass}"></span>${s.AVG_SKEW || 0}</td>
                <td>${s.TABLE_COUNT || 0}</td>
            </tr>
        `;
    }).join('');
}

function renderResources(resources: SessionMonitorResources) {
    const graContainer = getElementById('graTable');
    const sysUtilSummaryContainer = getElementById('sysUtilSummary');
    const sysUtilContainer = getElementById('sysUtilTable');

    // Render GRA data
    if (graContainer) {
        if (resources.gra && resources.gra.length > 0) {
            graContainer.innerHTML = renderGenericTable(resources.gra);
        } else {
            graContainer.innerHTML = '<div class="empty-state">No GRA data available</div>';
        }
    }

    // Render System Utilization summary (outside scrollable area)
    if (sysUtilSummaryContainer) {
        if (resources.sysUtilSummary) {
        const s = resources.sysUtilSummary;
        sysUtilSummaryContainer.innerHTML = `
            <div class="summary-box">
                <div class="summary-item">
                    <span class="summary-label">Host CPU</span>
                    <span class="summary-value">${s.AVG_HOST_CPU_PCT || 0}%</span>
                </div>
                <div class="summary-item">
                    <span class="summary-label">SPU CPU</span>
                    <span class="summary-value">${s.AVG_SPU_CPU_PCT || 0}%</span>
                </div>
                <div class="summary-item">
                    <span class="summary-label">Memory</span>
                    <span class="summary-value">${s.AVG_MEMORY_PCT || 0}%</span>
                </div>
                <div class="summary-item">
                    <span class="summary-label">Disk</span>
                    <span class="summary-value">${s.AVG_DISK_PCT || 0}%</span>
                </div>
                <div class="summary-item">
                    <span class="summary-label">Fabric</span>
                    <span class="summary-value">${s.AVG_FABRIC_PCT || 0}%</span>
                </div>
                <div class="summary-item">
                    <span class="summary-label">Samples</span>
                    <span class="summary-value">${s.SAMPLE_COUNT || 0}</span>
                </div>
            </div>
        `;
        } else {
            sysUtilSummaryContainer.innerHTML = '';
        }
    }

    // Render System Utilization table (inside scrollable area)
    if (sysUtilContainer) {
        if (resources.systemUtil && resources.systemUtil.length > 0) {
            sysUtilContainer.innerHTML = renderGenericTable(resources.systemUtil);
        } else {
            sysUtilContainer.innerHTML = '<div class="empty-state">No system utilization data available</div>';
        }
    }
}

function renderOverview(overview: SessionMonitorOverview, refreshedAt: string | null | undefined) {
    if (overviewSessions) overviewSessions.textContent = formatNumber(overview.activeSessions || 0);
    if (overviewQueries) overviewQueries.textContent = formatNumber(overview.runningQueries || 0);
    if (overviewHostCpu) overviewHostCpu.textContent = `${formatPercent(overview.avgHostCpuPct)}%`;
    if (overviewSpuCpu) overviewSpuCpu.textContent = `${formatPercent(overview.avgSpuCpuPct)}%`;
    if (overviewMemory) overviewMemory.textContent = `${formatPercent(overview.avgMemoryPct)}%`;
    if (overviewLoadScore) overviewLoadScore.textContent = `${formatPercent(overview.loadScore)}%`;
    if (overviewLoadLevel) overviewLoadLevel.textContent = overview.loadLevel || 'LOW';
    if (overviewRefreshedAt) overviewRefreshedAt.textContent = formatRefreshDate(refreshedAt);

    if (overviewLoadLevel) {
        overviewLoadLevel.classList.remove('load-low', 'load-medium', 'load-high', 'load-critical');
        overviewLoadLevel.classList.add(`load-${String(overview.loadLevel || 'low').toLowerCase()}`);
    }

    // Color the overview value based on threshold warnings
    if (overviewHostCpu) overviewHostCpu.style.color = overview.avgHostCpuPct >= 85 ? 'var(--rd)' : '';
    if (overviewSpuCpu) overviewSpuCpu.style.color = overview.avgSpuCpuPct >= 85 ? 'var(--rd)' : '';
    if (overviewMemory) overviewMemory.style.color = overview.avgMemoryPct >= 90 ? 'var(--am)' : '';
}

function renderAlerts(alerts: SessionMonitorAlert[]) {
    const list = alerts || [];
    if (alertCountEl) alertCountEl.textContent = String(list.length);
    if (alertTabCountEl) alertTabCountEl.textContent = String(list.length);

    if (!alertsList) return;

    if (list.length === 0) {
        alertsList.innerHTML = `<div class="empty-state">
            <div class="empty-state-icon">✓</div>
            All thresholds healthy.
        </div>`;
        return;
    }

    alertsList.innerHTML = list.map(alert => `
        <div class="alert-card alert-${escapeHtml(alert.level || 'warning')}">
            <div class="alert-title">${escapeHtml((alert.level || 'warning').toUpperCase())} · ${escapeHtml(alert.metric || '')}</div>
            <div class="alert-message">${escapeHtml(alert.message || '')}</div>
            <div class="alert-meta">Value: ${formatPercent(alert.value)} · Threshold: ${formatPercent(alert.threshold)}</div>
        </div>
    `).join('');
}

function applyAlertSettings(settings: SessionMonitorAlertSettings) {
    if (alertsEnabled) alertsEnabled.checked = Boolean(settings.enabled);
    if (sessionThreshold) sessionThreshold.value = String(settings.sessionThreshold ?? 25);
    if (queryThreshold) queryThreshold.value = String(settings.queryThreshold ?? 10);
    if (hostCpuThreshold) hostCpuThreshold.value = String(settings.hostCpuThreshold ?? 85);
    if (spuCpuThreshold) spuCpuThreshold.value = String(settings.spuCpuThreshold ?? 85);
    if (memoryThreshold) memoryThreshold.value = String(settings.memoryThreshold ?? 90);
}

function collectAlertSettings(): SessionMonitorAlertSettings {
    return {
        enabled: Boolean(alertsEnabled?.checked),
        sessionThreshold: toInt(sessionThreshold?.value ?? '', 25),
        queryThreshold: toInt(queryThreshold?.value ?? '', 10),
        hostCpuThreshold: toInt(hostCpuThreshold?.value ?? '', 85),
        spuCpuThreshold: toInt(spuCpuThreshold?.value ?? '', 85),
        memoryThreshold: toInt(memoryThreshold?.value ?? '', 90)
    };
}

function renderGenericTable(data: Record<string, unknown>[]) {
    if (!data || data.length === 0) return '';

    const columns = Object.keys(data[0]);

    return `
        <table>
            <thead>
                <tr>${columns.map(c => `<th>${c}</th>`).join('')}</tr>
            </thead>
            <tbody>
                ${data.map(row => `
                    <tr>${columns.map(c => `<td>${formatValue(row[c] as SessionMonitorScalar)}</td>`).join('')}</tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

