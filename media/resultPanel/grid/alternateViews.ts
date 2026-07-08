import { postHostMessage, getHostState, setHostState } from '../protocol.js';
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

const LOADING_OVERLAY_DISMISSED_STATE_KEY = 'loadingOverlayDismissedSources';

function loadLoadingOverlayDismissedSources(): Set<string> {
    const state = getHostState();
    if (state && typeof state === 'object') {
        const record = state as Record<string, unknown>;
        const dismissed = record[LOADING_OVERLAY_DISMISSED_STATE_KEY];
        if (Array.isArray(dismissed)) {
            return new Set(dismissed.map(String));
        }
    }
    return new Set();
}

function persistLoadingOverlayDismissedSources(): void {
    const priorState = getHostState();
    const state = priorState && typeof priorState === 'object'
        ? priorState as Record<string, unknown>
        : {};
    setHostState({
        ...state,
        [LOADING_OVERLAY_DISMISSED_STATE_KEY]: Array.from(loadingOverlayDismissedSources)
    });
}

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

    // Check if auto-scroll should happen BEFORE appending
    const isHidden = consoleView.clientHeight === 0;
    const distanceToBottom = consoleView.scrollHeight - consoleView.scrollTop - consoleView.clientHeight;
    const shouldScroll = isHidden || distanceToBottom <= 50;

    rows.forEach(row => {
        const line = createLogLineElement(row);
        consoleView.appendChild(line);
    });

    if (shouldScroll) {
        requestAnimationFrame(() => {
            consoleView.scrollTop = consoleView.scrollHeight;
        });
    }
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
    title.textContent = 'SQL Execution Error';
    errorDiv.appendChild(title);

    const msg = document.createElement('div');
    msg.textContent = rs.message || 'Unknown error occurred.';
    errorDiv.appendChild(msg);

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

let loadingOverlayDismissedSources = loadLoadingOverlayDismissedSources();

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

export function dismissLoadingOverlay() {
    const source = getActiveSourceUri();
    if (source) {
        loadingOverlayDismissedSources.add(source);
        persistLoadingOverlayDismissedSources();
    }
    updateLoadingState();
}

export function resetLoadingOverlayDismissed() {
    loadingOverlayDismissedSources = new Set();
    persistLoadingOverlayDismissedSources();
}

export function isLoadingOverlayDismissed() {
    const source = getActiveSourceUri();
    return !!source && loadingOverlayDismissedSources.has(source);
}

export function updateLoadingState() {
    const overlay = document.getElementById('loadingOverlay');
    if (!overlay) return;

    const source = getActiveSourceUri();
    const isActiveExecuting =
        !!source && (getResultPanelWindow().executingSources?.has(source) ?? false);
    if (!isActiveExecuting) {
        if (source && loadingOverlayDismissedSources.delete(source)) {
            persistLoadingOverlayDismissedSources();
        }
        overlay.classList.remove('visible');
        return;
    }

    // Keep the yellow execution banner while streaming, but reveal the grid
    // as soon as the first tabular rows are available. Users can also hide the
    // blocking overlay early to keep reading execution logs.
    if (
        hasPreviewableResultData()
        || (source && loadingOverlayDismissedSources.has(source))
    ) {
        overlay.classList.remove('visible');
        return;
    }

    overlay.classList.add('visible');
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
