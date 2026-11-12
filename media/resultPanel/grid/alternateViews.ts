import { appendRunLogRows, parseRunMessage } from '../logRunGroups.js';
import { renderSqlQueueLogs } from '../sqlQueueLogs.js';
import { postHostMessage } from '../protocol.js';
import { shouldRightAlignCell } from '../utils.js';
import {
    getActiveGridIndex,
    addGrid,
    getGlobalFilterState,
} from '../state.js';
import type { LogRow, ResultSet } from '../types.js';
import { getActiveSourceUri, getResultPanelWindow, getResultSetAt, getResultSets } from '../types.js';
import { asHtml } from '../dom.js';
import type { ResultSetWithExtras, StateCardOptions } from './types.js';
import { resolveScrollStateForResultSet, applyScrollStateToTarget } from './persistence.js';

const vscode = { postMessage: postHostMessage };

export function renderStateCard(container: HTMLElement, options: StateCardOptions): void {
    const {
        title,
        description,
        hint,
        tone = 'neutral'
    } = options;

    container.innerHTML = `
        <div class="result-state-card state-${tone}">
            <div class="result-state-title">${title}</div>
            ${description ? `<div class="result-state-description">${description}</div>` : ''}
            ${hint ? `<div class="result-state-hint">${hint}</div>` : ''}
        </div>
    `;
}

export function applyRightAlignmentClass(
    element: HTMLElement,
    dataType: string | undefined,
    inferredNumericKind: 'decimal' | 'integer' | undefined,
    value?: unknown,
) {
    const shouldAlignRight = shouldRightAlignCell(dataType, { inferredNumericKind, value });
    if (shouldAlignRight) {
        element.classList.add('cell-align-right');
    } else {
        element.classList.remove('cell-align-right');
    }
    return shouldAlignRight;
}

export function createLogConsole(rs: ResultSet, rsIndex: number, container: HTMLElement): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'grid-wrapper console-wrapper';
    wrapper.style.display = rsIndex === getActiveGridIndex() ? 'block' : 'none';
    wrapper.dataset.index = String(rsIndex);

    const consoleView = document.createElement('div');
    consoleView.className = 'console-view';

    if (rs.data && Array.isArray(rs.data)) {
        appendRunLogRows(consoleView, rs.data as LogRow[], createLogLineElement);
    }

    wrapper.appendChild(consoleView);
    renderSqlQueueLogs(wrapper);
    container.appendChild(wrapper);

    const mockGrid = {
        executionTimestamp: rs.executionTimestamp
    };
    addGrid(mockGrid);

    if (rsIndex === getActiveGridIndex()) {
        const scrollState = resolveScrollStateForResultSet(rsIndex, getActiveSourceUri());
        if (scrollState && ((scrollState.scrollTop ?? 0) > 0 || (scrollState.scrollLeft ?? 0) > 0)) {
            applyScrollStateToTarget(consoleView, scrollState);
        } else {
            consoleView.scrollTop = consoleView.scrollHeight;
        }
    }
}

export function createTextContentView(rs: ResultSet, rsIndex: number, container: HTMLElement): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'grid-wrapper text-content-wrapper';
    wrapper.style.display = rsIndex === getActiveGridIndex() ? 'block' : 'none';
    wrapper.style.height = '100%';
    wrapper.style.overflow = 'auto';
    wrapper.style.position = 'relative';
    wrapper.dataset.index = String(rsIndex);

    const contentView = document.createElement('pre');
    contentView.className = 'text-content-view';
    contentView.style.margin = '0';
    contentView.style.padding = '16px';
    contentView.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
    contentView.style.fontSize = 'var(--vscode-editor-font-size, 13px)';
    contentView.style.whiteSpace = 'pre-wrap';
    contentView.style.wordBreak = 'break-word';
    contentView.style.color = 'var(--vscode-editor-foreground)';
    contentView.style.backgroundColor = 'var(--vscode-editor-background)';
    contentView.style.minHeight = '100%';

    const text = (rs.data && rs.data.length > 0 && rs.data[0] && rs.data[0].length > 0)
        ? String(rs.data[0][0] ?? '')
        : '';
    contentView.textContent = text;

    wrapper.appendChild(contentView);
    container.appendChild(wrapper);

    const mockGrid = {
        executionTimestamp: rs.executionTimestamp
    };
    addGrid(mockGrid);
}

export function createLogLineElement(row: LogRow): HTMLDivElement {
    const line = document.createElement('div');
    line.className = 'console-line';
    const timeText = String(row[0] ?? '');
    const messageText = String(row[1] ?? '');

    if (messageText === '') {
        line.classList.add('console-line--empty');
        line.innerHTML = '&nbsp;';
        return line;
    }
    if (messageText.startsWith('---')) {
        line.className += ' separator';
        const timeSpan = document.createElement('span');
        timeSpan.className = 'console-time';
        timeSpan.textContent = timeText;
        const msgSpan = document.createElement('span');
        msgSpan.className = 'console-msg';
        msgSpan.textContent = messageText;
        line.append(timeSpan, msgSpan);
        return line;
    }
    const parsed = parseRunMessage(messageText);
    if (parsed.status) {
        // Timeline copy of a statement row (grouped cards render the rich
        // header via logRunGroups; this keeps legacy/plain rows readable).
        const status = parsed.status;
        line.className += ` status-${status}`;
        const statusIcons: Record<string, string> = {
            running: '▶',
            success: '✓',
            error: '✗',
            cancelled: '⊘',
            retrying: '↻',
        };

        const timeSpan = document.createElement('span');
        timeSpan.className = 'console-time';
        timeSpan.textContent = timeText;

        const badge = document.createElement('span');
        badge.className = `log-status log-status--${status}`;
        const icon = document.createElement('span');
        icon.className = 'log-status-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = statusIcons[status] ?? '';
        const label = document.createElement('span');
        label.textContent = status.toUpperCase();
        badge.append(icon, label);

        const msgSpan = document.createElement('span');
        msgSpan.className = 'console-msg';
        if (parsed.sqlPreview) {
            const sql = document.createElement('span');
            sql.className = 'log-line-sql';
            sql.textContent = parsed.sqlPreview;
            msgSpan.appendChild(sql);
        }
        const meta = [parsed.connection, parsed.duration, parsed.rowCount].filter((part): part is string => !!part);
        if (meta.length > 0) {
            const metaSpan = document.createElement('span');
            metaSpan.className = 'log-meta-inline';
            metaSpan.textContent = meta.join(' · ');
            msgSpan.appendChild(metaSpan);
        }
        if (parsed.errorText) {
            const errorSpan = document.createElement('span');
            errorSpan.className = 'log-error-hint';
            errorSpan.textContent = parsed.errorText;
            msgSpan.appendChild(errorSpan);
        }

        line.append(timeSpan, badge, msgSpan);
        return line;
    }
    const timeSpan = document.createElement('span');
    timeSpan.className = 'console-time';
    timeSpan.textContent = timeText;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'console-msg';
    msgSpan.textContent = messageText;

    line.append(timeSpan, msgSpan);
    return line;
}

export function appendLogRows(rsIndex: number, rows: LogRow[]): void {
    const hadConsoleWrapper = !!document.querySelector(`.grid-wrapper[data-index="${rsIndex}"].console-wrapper`);
    if (!hadConsoleWrapper && !ensureLogConsoleRendered(rsIndex)) {
        return;
    }

    const wrapper = document.querySelector(`.grid-wrapper[data-index="${rsIndex}"].console-wrapper`);
    if (!wrapper) {
        return;
    }

    const consoleView = wrapper.querySelector('.console-view');
    if (!consoleView) return;

    // createLogConsole already rendered the full rs.data payload.
    if (!hadConsoleWrapper) {
        requestAnimationFrame(() => {
            const scrollState = resolveScrollStateForResultSet(rsIndex, getActiveSourceUri());
            const consoleTarget = asHtml(consoleView);
            if (!consoleTarget) return;
            if (scrollState && ((scrollState.scrollTop ?? 0) > 0 || (scrollState.scrollLeft ?? 0) > 0)) {
                applyScrollStateToTarget(consoleTarget, scrollState);
            } else {
                consoleView.scrollTop = consoleView.scrollHeight;
            }
        });
        return;
    }

    appendRunLogRows(consoleView as HTMLElement, rows, createLogLineElement);

    const shouldFollowLatest = rsIndex === getActiveGridIndex()
        && (getResultPanelWindow().executingSources?.has(getActiveSourceUri() ?? '') ?? false);
    if (shouldFollowLatest) {
        consoleView.scrollTop = consoleView.scrollHeight;
        requestAnimationFrame(() => {
            consoleView.scrollTop = consoleView.scrollHeight;
        });
    }
}

export function replaceLogRows(rsIndex: number, rows: LogRow[]): void {
    if (!ensureLogConsoleRendered(rsIndex)) {
        return;
    }
    const wrapper = document.querySelector(`.grid-wrapper[data-index="${rsIndex}"].console-wrapper`);
    const consoleView = wrapper?.querySelector('.console-view');
    if (!consoleView) {
        return;
    }
    consoleView.innerHTML = '';
    appendRunLogRows(consoleView as HTMLElement, rows, createLogLineElement);
    consoleView.scrollTop = consoleView.scrollHeight;
    requestAnimationFrame(() => {
        consoleView.scrollTop = consoleView.scrollHeight;
    });
}


export function extractKeyNetezzaErrorInfo(fullMessage: string): string {
    // Strip common wrapper prefixes added by the extension host.
    // Some errors may have nested prefixes (e.g. "Error: ERROR: ..." without "Netezza Error")
    // so we strip iteratively until no more known prefixes remain.
    const knownPrefixes = [
        /^Error:\s*Netezza\s+Error:\s*/i,
        /^Netezza\s+Error:\s*/i,
        /^ERROR:\s*/i,
    ];
    let msg = fullMessage.trim();
    let prev: string;
    do {
        prev = msg;
        for (const re of knownPrefixes) {
            msg = msg.replace(re, '');
        }
        msg = msg.trim();
    } while (msg !== prev);

    if (!msg) {
        return fullMessage;
    }

    // Pattern A: Syntax errors where the SQL is quoted after ERROR:
    //   ERROR: 'SQL TEXT...'
    //   error
    //   ^ found X (at char N) expecting Y
    // After stripping prefixes the message starts with 'SQL...'
    const firstQuoteIdx = msg.indexOf("'");
    if (firstQuoteIdx === 0) {
        const closingQuoteIdx = msg.indexOf("'", 1);
        if (closingQuoteIdx > firstQuoteIdx) {
            const afterQuote = msg.substring(closingQuoteIdx + 1).trim();
            // Remove trailing "error" and "^" marker lines
            const cleaned = afterQuote
                .replace(/^error\s*/i, '')
                .replace(/^\^+\s*/, '')
                .trim();
            if (cleaned) {
                return cleaned;
            }
        }
    }

    // Pattern B: Something like "relation does not exist ..." — already clean
    // after stripping prefixes. Return as-is.
    return msg;
}

export type ErrorKind = 'connection' | 'syntax' | 'backend' | 'unknown';

export function getErrorKind(message: string, errorDetails?: ResultSetWithExtras['errorDetails']): ErrorKind {
    if (errorDetails?.code) return 'backend';
    const normalized = message.toLowerCase();
    if (
        normalized.includes('econnrefused')
        || normalized.includes('enotfound')
        || normalized.includes('etimedout')
        || normalized.includes('econnaborted')
        || normalized.includes('econnreset')
        || normalized.includes('epipe')
        || normalized.includes('socket closed')
        || normalized.includes('socket ended')
        || normalized.includes('connection timeout')
        || normalized.includes('connection is closed')
        || normalized.includes('connection reset')
        || normalized.includes('broken pipe')
        || normalized.includes('connection was lost')
    ) {
        return 'connection';
    }
    if (
        normalized.includes('syntax error')
        || /found .*\(at char \d+\)/.test(normalized)
        || normalized.includes('expecting an identifier')
        || normalized.includes('unexpected token')
        || normalized.includes('parse error')
    ) {
        return 'syntax';
    }
    if (
        normalized.includes('does not exist')
        || normalized.includes('not found')
        || normalized.includes('permission denied')
        || normalized.includes('insufficient privilege')
        || normalized.includes('access denied')
        || normalized.includes('constraint')
    ) {
        return 'backend';
    }
    if (normalized.includes('error')) return 'backend';
    return 'unknown';
}

export function getErrorKindLabel(kind: ErrorKind): string {
    switch (kind) {
        case 'connection': return 'Network';
        case 'syntax': return 'Parser';
        case 'backend': return 'Database';
        default: return 'Error';
    }
}

function getErrorTitle(kind: ErrorKind): string {
    switch (kind) {
        case 'connection': return 'Connection failed';
        case 'syntax': return 'SQL syntax error';
        case 'backend': return 'Query failed';
        default: return 'Query failed';
    }
}

function getErrorNextSteps(kind: ErrorKind): string {
    switch (kind) {
        case 'connection':
            return 'Check that the server is running and reachable (host/port, VPN or SSH tunnel), then retry. Review Logs for details.';
        case 'syntax':
            return 'Review Logs for the full execution timeline, or fix the position in the message and retry.';
        case 'backend':
            return 'Use the diagnostics or Logs to identify the object or permission, then retry.';
        default:
            return 'Review Logs for the full execution timeline, then retry or adjust the query.';
    }
}

/**
 * Never render a bare "Unknown error occurred." card. When the host sends no
 * message (falsy/blank), explain what is known instead of hiding the failure:
 * SQLSTATE when present, otherwise a pointer to Logs. The driver message,
 * when present, is always preferred and returned unchanged.
 */
export function resolveErrorMessage(rs: ResultSetWithExtras): string {
    if (typeof rs.message === 'string' && rs.message.trim().length > 0) {
        return rs.message;
    }
    const code = rs.errorDetails?.code;
    const severity = rs.errorDetails?.severity;
    if (code) {
        return `Database error ${code}${severity ? ` (${severity})` : ''}: the database returned no message text. Check Logs for the execution timeline.`;
    }
    return 'Database returned an empty error response. Check Logs for the execution timeline and verify the connection.';
}

/** Copy through the clipboard API and tell the host when it is unavailable. */
function copyText(text: string): void {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
        void vscode.postMessage({ command: 'info', text: 'Clipboard is not available in this window.' });
        return;
    }
    clipboard.writeText(text).catch(() => {
        void vscode.postMessage({ command: 'info', text: 'Failed to copy to clipboard' });
    });
}

/**
 * Renders backend diagnostics (SQLSTATE, severity, detail, hint) below the
 * summary. Detail and hint stay collapsed because they are often long, and the
 * copy action emits the same text without ever including a raw driver payload.
 */
function appendErrorDiagnostics(errorDiv: HTMLElement, rs: ResultSetWithExtras): void {
    const details = rs.errorDetails;
    if (!details) return;

    const rows: Array<{ label: string; value: string }> = [];
    if (details.code) rows.push({ label: 'SQLSTATE', value: details.code });
    if (details.severity) rows.push({ label: 'Severity', value: details.severity });
    const collapsible: Array<{ label: string; value: string }> = [];
    if (details.detail) collapsible.push({ label: 'Detail', value: details.detail });
    if (details.hint) collapsible.push({ label: 'Hint', value: details.hint });
    for (const [key, value] of Object.entries(details.diagnostics ?? {})) {
        collapsible.push({ label: key, value });
    }
    if (rows.length === 0 && collapsible.length === 0) return;

    const block = document.createElement('div');
    block.className = 'error-diagnostics';

    for (const row of rows) {
        const line = document.createElement('div');
        line.className = 'error-diagnostic-line';
        const label = document.createElement('span');
        label.className = 'error-diagnostic-label';
        label.textContent = `${row.label}: `;
        const value = document.createElement('span');
        value.className = 'error-diagnostic-value';
        value.textContent = row.value;
        line.append(label, value);
        block.appendChild(line);
    }

    if (collapsible.length > 0) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'error-details-toggle';
        toggle.innerHTML = '<span class="arrow">▶</span> Show backend diagnostics';
        toggle.setAttribute('aria-expanded', 'false');
        const panel = document.createElement('div');
        panel.className = 'error-details';
        for (const row of collapsible) {
            const line = document.createElement('div');
            line.className = 'error-diagnostic-line';
            const label = document.createElement('span');
            label.className = 'error-diagnostic-label';
            label.textContent = `${row.label}: `;
            const value = document.createElement('span');
            value.className = 'error-diagnostic-value';
            value.textContent = row.value;
            line.append(label, value);
            panel.appendChild(line);
        }
        toggle.onclick = () => {
            const isVisible = panel.classList.toggle('visible');
            toggle.innerHTML = isVisible
                ? '<span class="arrow open">▶</span> Hide backend diagnostics'
                : '<span class="arrow">▶</span> Show backend diagnostics';
            toggle.setAttribute('aria-expanded', String(isVisible));
        };
        block.append(toggle, panel);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'error-secondary-btn error-copy-diagnostics';
    copyBtn.textContent = 'Copy diagnostics';
    copyBtn.title = 'Copy SQLSTATE, severity, detail and hint to the clipboard';
    copyBtn.onclick = () => {
        const lines = [...rows, ...collapsible].map(row => `${row.label}: ${row.value}`);
        copyText(lines.join('\n'));
    };
    block.appendChild(copyBtn);

    errorDiv.appendChild(block);
}

export function createErrorView(rs: ResultSetWithExtras, rsIndex: number, container: HTMLElement): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'grid-wrapper error-wrapper' + (rsIndex === getActiveGridIndex() ? ' active' : '');
    wrapper.style.display = rsIndex === getActiveGridIndex() ? 'block' : 'none';
    wrapper.dataset.index = String(rsIndex);
    container.appendChild(wrapper);

    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-view';
    errorDiv.setAttribute('role', 'group');
    errorDiv.setAttribute('aria-label', 'Query error');

    const fullMessage = resolveErrorMessage(rs);
    const simplifiedMessage = extractKeyNetezzaErrorInfo(fullMessage);
    const kind = getErrorKind(fullMessage, rs.errorDetails);

    const header = document.createElement('div');
    header.className = 'error-header';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'error-icon';
    iconSpan.textContent = '!';
    iconSpan.setAttribute('aria-hidden', 'true');
    header.appendChild(iconSpan);

    const heading = document.createElement('div');
    heading.className = 'error-heading';
    const title = document.createElement('div');
    title.className = 'error-title';
    title.textContent = getErrorTitle(kind);
    heading.appendChild(title);
    const kindLabel = document.createElement('div');
    kindLabel.className = `error-kind error-kind-${kind}`;
    kindLabel.textContent = getErrorKindLabel(kind);
    heading.appendChild(kindLabel);
    header.appendChild(heading);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'error-actions';

    const logResultIndex = Array.isArray(getResultSets())
        ? getResultSets().findIndex(resultSet => resultSet && resultSet.isLog)
        : -1;

    if (logResultIndex >= 0) {
        const logsBtn = document.createElement('button');
        logsBtn.type = 'button';
        logsBtn.className = 'error-secondary-btn';
        logsBtn.textContent = 'Open Logs';
        logsBtn.title = 'Jump to the Logs tab for execution details';
        logsBtn.onclick = () => {
            const tabs = document.querySelectorAll('.result-set-tab');
            const logsTab = tabs[logResultIndex] as HTMLElement | undefined;
            logsTab?.click();
        };
        actionsDiv.appendChild(logsBtn);
    }

    const copyErrorBtn = document.createElement('button');
    copyErrorBtn.type = 'button';
    copyErrorBtn.className = 'error-secondary-btn error-copy-error';
    copyErrorBtn.textContent = 'Copy';
    copyErrorBtn.title = 'Copy the error message and executed SQL to the clipboard';
    copyErrorBtn.onclick = () => {
        const parts = [fullMessage];
        if (rs.errorDetails?.code) parts.push(`SQLSTATE: ${rs.errorDetails.code}`);
        if (rs.sql) parts.push(`SQL: ${rs.sql}`);
        copyText(parts.join('\n'));
    };
    actionsDiv.appendChild(copyErrorBtn);

    const fixBtn = document.createElement('button');
    fixBtn.type = 'button';
    fixBtn.className = 'copilot-fix-btn';
    fixBtn.innerHTML = '<span class="icon">✨</span><span>Discuss with Copilot</span>';
    fixBtn.title = 'Preview and copy the error, SQL and referenced DDL for your own Copilot Chat thread';
    fixBtn.onclick = () => {
        fixBtn.classList.add('loading');
        fixBtn.innerHTML = '<span class="icon">⏳</span><span>Preparing prompt...</span>';
        vscode.postMessage({
            command: 'fixSqlError',
            errorMessage: fullMessage,
            sql: rs.sql || ''
        });
        setTimeout(() => {
            fixBtn.classList.remove('loading');
            fixBtn.innerHTML = '<span class="icon">✨</span><span>Discuss with Copilot</span>';
        }, 2000);
    };
    actionsDiv.appendChild(fixBtn);
    const toolbar = document.createElement('div');
    toolbar.className = 'error-toolbar';
    toolbar.appendChild(actionsDiv);
    errorDiv.appendChild(header);
    errorDiv.appendChild(toolbar);

    const body = document.createElement('div');
    body.className = 'error-body';

    // Key fragment — shown prominently at the top
    const summary = document.createElement('div');
    summary.className = 'error-summary';
    summary.setAttribute('role', 'alert');
    summary.textContent = simplifiedMessage;
    body.appendChild(summary);

    // Full details — collapsible, shown on demand
    const isDifferent = simplifiedMessage !== fullMessage;
    if (isDifferent) {
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'error-details-toggle';
        toggleBtn.type = 'button';
        toggleBtn.innerHTML = '<span class="arrow">▶</span> Show full error details';
        toggleBtn.onclick = () => {
            const details = errorDiv.querySelector('.error-details') as HTMLElement | null;
            if (!details) return;
            const isVisible = details.classList.toggle('visible');
            toggleBtn.innerHTML = isVisible
                ? '<span class="arrow open">▶</span> Hide full error details'
                : '<span class="arrow">▶</span> Show full error details';
            toggleBtn.setAttribute('aria-expanded', String(isVisible));
        };
        toggleBtn.setAttribute('aria-expanded', 'false');
        body.appendChild(toggleBtn);

        const details = document.createElement('div');
        details.className = 'error-details';
        details.textContent = fullMessage;
        body.appendChild(details);
    }

    appendErrorDiagnostics(body, rs);

    const recoveryHint = document.createElement('div');
    recoveryHint.className = 'error-recovery-hint';
    recoveryHint.textContent = getErrorNextSteps(kind);
    body.appendChild(recoveryHint);

    if (rs.sql) {
        const sqlDiv = document.createElement('div');
        sqlDiv.className = 'error-sql';
        const sqlHeader = document.createElement('div');
        sqlHeader.className = 'error-sql-header';
        const sqlLabel = document.createElement('span');
        sqlLabel.className = 'error-sql-label';
        sqlLabel.textContent = 'SQL';
        sqlHeader.appendChild(sqlLabel);
        const copySqlBtn = document.createElement('button');
        copySqlBtn.type = 'button';
        copySqlBtn.className = 'error-sql-copy';
        copySqlBtn.textContent = 'Copy SQL';
        copySqlBtn.title = 'Copy the executed SQL to the clipboard';
        copySqlBtn.onclick = () => copyText(rs.sql ?? '');
        sqlHeader.appendChild(copySqlBtn);
        sqlDiv.appendChild(sqlHeader);
        const sqlPre = document.createElement('pre');
        sqlPre.className = 'error-sql-code';
        sqlPre.textContent = rs.sql;
        sqlDiv.appendChild(sqlPre);
        body.appendChild(sqlDiv);
    }

    errorDiv.appendChild(body);

    wrapper.appendChild(errorDiv);
    addGrid(null);
}

export function hasPreviewableResultData(): boolean {
    const resultSets = Array.isArray(getResultSets()) ? getResultSets() : [];
    return resultSets.some((rs) =>
        rs
        && !rs.isLog
        && !rs.isError
        && !rs.isTextContent
        && Array.isArray(rs.data)
        && rs.data.length > 0
    );
}

function ensureLogConsoleRendered(rsIndex: number): boolean {
    const existingWrapper = document.querySelector(`.grid-wrapper[data-index="${rsIndex}"]`);
    if (existingWrapper?.classList.contains('console-wrapper')) {
        return true;
    }

    const rs = getResultSetAt(rsIndex);
    const container = document.getElementById('gridContainer');
    if (!rs?.isLog || !container) {
        return false;
    }

    if (!container.querySelector('.grid-wrapper')) {
        container.innerHTML = '';
    }

    createLogConsole(rs, rsIndex, container);
    return !!document.querySelector(`.grid-wrapper[data-index="${rsIndex}"].console-wrapper`);
}

/**
 * @deprecated The blocking "Generating data…" overlay was removed.
 * Running state is surfaced through the execution banner (with Cancel)
 * and the Logs tab (spinner + log rows). These helpers remain as no-ops
 * for backward compatibility and only hide a legacy overlay node if one
 * exists in an older webview template.
 */
export function dismissLoadingOverlay(): void {
    updateLoadingState();
}

/** @deprecated See {@link dismissLoadingOverlay}. */
export function resetLoadingOverlayDismissed(): void {
    updateLoadingState();
}

/** @deprecated The overlay no longer tracks per-source dismissal. */
export function isLoadingOverlayDismissed(): boolean {
    return false;
}

export function updateLoadingState(): void {
    const overlay = document.getElementById('loadingOverlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
    (overlay as HTMLElement).style.display = 'none';
}

export function updateControlsVisibility(index: number): void {
    const rs = getResultSetAt(index);
    const isLog = rs && rs.isLog;
    const isTextContent = rs && rs.isTextContent;
    // Error results are not a grid: Table/Analyze, filters, Export, Columns and
    // Row View all target data that does not exist. The error card already
    // offers Open Logs / Copy / Discuss with Copilot / Copy SQL, so the whole
    // toolbar row is collapsed instead of leaving a dead strip above the card.
    const isError = rs && rs.isError;
    const hideControls = Boolean(isLog || isTextContent || isError);
    const controls = document.querySelector<HTMLElement>('.controls');

    if (controls) {
        // Logs keep their single surviving action (Clear Logs); every other
        // non-grid view collapses the row entirely.
        controls.style.display = hideControls && !isLog ? 'none' : '';
        // Explicit allow-list: only the log clearer survives on Logs/Text views.
        // Every other toolbar group is hidden as a whole, so adding a new
        // group to `.controls` never leaks onto Logs/Text by accident.
        const groups = controls.querySelectorAll(':scope > .toolbar-group, :scope > .toolbar-separator, :scope > .layout-switcher, :scope > .split-btn, :scope > input, :scope > button, :scope > select, :scope > .column-search-group');
        groups.forEach((node) => {
            const child = node as HTMLElement;
            if (child.id === 'clearLogsBtn' || child.querySelector?.('#clearLogsBtn')) {
                child.style.display = isLog ? 'inline-flex' : 'none';
            } else {
                child.style.display = hideControls ? 'none' : '';
            }
        });
        const clearLogsBtn = document.getElementById('clearLogsBtn');
        if (clearLogsBtn && !controls.contains(clearLogsBtn)) {
            clearLogsBtn.style.display = isLog ? 'inline-flex' : 'none';
        }
    }

    const groupingPanel = document.getElementById('groupingPanel');
    if (groupingPanel) groupingPanel.style.display = hideControls ? 'none' : '';
}

export function syncGlobalFilterInput(index = getActiveGridIndex()) {
    const filterInput = document.getElementById('globalFilter') as HTMLInputElement | null;
    if (!filterInput) return;

    const rs = getResultSetAt(index) ?? null;
    if (!rs || rs.isLog || rs.isError || rs.isTextContent) {
        filterInput.value = '';
        return;
    }

    filterInput.value = getGlobalFilterState(index, rs.executionTimestamp, getActiveSourceUri());
}
