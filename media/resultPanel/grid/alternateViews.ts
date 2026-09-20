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
        rs.data.forEach((row: unknown) => {
            const line = createLogLineElement(row as LogRow);
            consoleView.appendChild(line);
        });
    }

    wrapper.appendChild(consoleView);
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
        line.innerHTML = '&nbsp;';
    } else if (messageText.startsWith('---')) {
        line.className += ' separator';
        line.textContent = `${timeText} ${messageText}`;
    } else if (/^[▶✓✗⊘]\s/.test(messageText)) {
        // Enhanced log entry with status indicator
        const timeSpan = document.createElement('span');
        timeSpan.className = 'console-time';
        timeSpan.textContent = `[${timeText}] `;

        const msgSpan = document.createElement('span');
        msgSpan.className = 'console-msg';

        // Parse status from message
        const statusMatch = messageText.match(/^([▶✓✗⊘])\s+(\w+):/);
        if (statusMatch) {
            const statusIcon = statusMatch[1];
            const status = statusMatch[2].toLowerCase();

            // Add status class
            line.className += ` status-${status}`;

            // Create status indicator span
            const statusSpan = document.createElement('span');
            statusSpan.className = `console-status status-${status}`;
            statusSpan.textContent = statusIcon + ' ' + status + ':';

            msgSpan.appendChild(statusSpan);

            // Add the rest of the message after the status
            const restOfMessage = messageText.substring(statusMatch[0].length);
            const restText = document.createTextNode(' ' + restOfMessage);
            msgSpan.appendChild(restText);
        } else {
            msgSpan.textContent = messageText;
        }

        line.appendChild(timeSpan);
        line.appendChild(msgSpan);
    } else {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'console-time';
        timeSpan.textContent = `[${timeText}] `;

        const msgSpan = document.createElement('span');
        msgSpan.className = 'console-msg';
        msgSpan.textContent = messageText;

        line.appendChild(timeSpan);
        line.appendChild(msgSpan);
    }
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

    rows.forEach(row => {
        const line = createLogLineElement(row);
        consoleView.appendChild(line);
    });

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
    rows.forEach(row => consoleView.appendChild(createLogLineElement(row)));
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
        void navigator.clipboard?.writeText(lines.join('\n')).catch(() => undefined);
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

    const title = document.createElement('div');
    title.className = 'error-title';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'error-icon';
    iconSpan.textContent = '!';
    iconSpan.setAttribute('aria-hidden', 'true');
    title.appendChild(iconSpan);
    title.append('SQL Execution Error');
    errorDiv.appendChild(title);

    const fullMessage = rs.message || 'Unknown error occurred.';
    const simplifiedMessage = extractKeyNetezzaErrorInfo(fullMessage);

    // Key fragment — shown prominently at the top
    const summary = document.createElement('div');
    summary.className = 'error-summary';
    summary.textContent = simplifiedMessage;
    errorDiv.appendChild(summary);

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
        errorDiv.appendChild(toggleBtn);

        const details = document.createElement('div');
        details.className = 'error-details';
        details.textContent = fullMessage;
        errorDiv.appendChild(details);
    }

    appendErrorDiagnostics(errorDiv, rs);

    const recoveryHint = document.createElement('div');
    recoveryHint.className = 'error-recovery-hint';
    recoveryHint.textContent = 'Review Logs for the full execution timeline, then retry or adjust the query.';
    errorDiv.appendChild(recoveryHint);

    if (rs.sql) {
        const sqlDiv = document.createElement('div');
        sqlDiv.className = 'error-sql';
        sqlDiv.innerHTML = `<strong>Executed SQL:</strong><br><pre style="margin-top: 5px;">${rs.sql}</pre>`;
        errorDiv.appendChild(sqlDiv);
    }

    // Add Fix with Copilot button
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'error-actions';

    const logResultIndex = Array.isArray(getResultSets())
        ? getResultSets().findIndex(resultSet => resultSet && resultSet.isLog)
        : -1;

    if (logResultIndex >= 0) {
        const logsBtn = document.createElement('button');
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

    const fixBtn = document.createElement('button');
    fixBtn.className = 'copilot-fix-btn';
    fixBtn.innerHTML = '<span class="icon">✨</span><span>Fix with Copilot</span>';
    fixBtn.title = 'Send error and SQL to Copilot Chat for fixing (includes table DDL for context)';
    fixBtn.onclick = () => {
        fixBtn.classList.add('loading');
        fixBtn.innerHTML = '<span class="icon">⏳</span><span>Sending to Copilot...</span>';
        vscode.postMessage({
            command: 'fixSqlError',
            errorMessage: rs.message || 'Unknown error',
            sql: rs.sql || ''
        });
        setTimeout(() => {
            fixBtn.classList.remove('loading');
            fixBtn.innerHTML = '<span class="icon">✨</span><span>Fix with Copilot</span>';
        }, 2000);
    };
    actionsDiv.appendChild(fixBtn);
    errorDiv.appendChild(actionsDiv);

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
    const hideControls = isLog || isTextContent;
    const controls = document.querySelector('.controls');

    if (controls) {
        const children = controls.children;
        for (let i = 0; i < children.length; i++) {
            const child = children[i] as HTMLElement;
            if (child.id === 'clearLogsBtn') {
                child.style.display = isLog ? 'inline-flex' : 'none';
            } else {
                child.style.display = hideControls ? 'none' : '';
            }
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
