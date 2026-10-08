import type { ExecutionLogDetails } from '../../src/contracts/webviews/executionLogContracts';
import type { LogRow } from './types.js';

const disclosures = new Map<string, boolean>();
/** Statement context remembered from the start row (end rows carry no sql/connection). */
const runContext = new Map<string, { sql?: string; connectionName?: string }>();

function rememberContext(key: string, value: { sql?: string; connectionName?: string }): void {
    runContext.set(key, { ...runContext.get(key), ...value });
    if (runContext.size > 500) runContext.delete(runContext.keys().next().value!);
}

export type RunStatus = 'running' | 'success' | 'error' | 'cancelled' | 'retrying';

const STATUS_ICON: Record<RunStatus, string> = {
    running: '▶',
    success: '✓',
    error: '✗',
    cancelled: '⊘',
    retrying: '↻',
};

const STATUS_LABEL: Record<RunStatus, string> = {
    running: 'RUNNING',
    success: 'SUCCESS',
    error: 'ERROR',
    cancelled: 'CANCELLED',
    retrying: 'RETRYING',
};

export interface ParsedRunMessage {
    status?: RunStatus;
    sqlPreview?: string;
    connection?: string;
    duration?: string;
    rowCount?: string;
    errorText?: string;
}

const STATUS_PREFIX_RE = /^[▶✓✗⊘↻]\s+(\w+):\s*/;
const DURATION_RE = /^(\d+\s*ms|\d+(\.\d+)?\s*s|\d+\s*m\s*\d+\s*s)$/i;
const ROW_COUNT_RE = /^\d[\d\s,]*\s+rows?$/i;
const LABEL_TO_STATUS: Record<string, RunStatus> = {
    running: 'running',
    success: 'success',
    error: 'error',
    cancelled: 'cancelled',
    retrying: 'retrying',
};

/**
 * Splits the legacy pipe-joined log string (`STATUS: sql | conn | duration | rows | error…`)
 * into display parts. The structured `ExecutionLogDetails` fields win whenever present;
 * this parser is the fallback for persisted/archived rows. Segments are classified by
 * shape (duration / row count / connection) so shortened rows without a connection
 * still land in the right chip.
 */
export function parseRunMessage(message: string): ParsedRunMessage {
    const match = message.match(STATUS_PREFIX_RE);
    if (!match) return {};
    const status = LABEL_TO_STATUS[match[1].toLowerCase()];
    if (!status) return {};
    const rest = message.slice(match[0].length);
    const parts = rest.split(' | ');
    const parsed: ParsedRunMessage = { status, sqlPreview: parts[0]?.trim() || undefined };
    const leftovers: string[] = [];
    for (const part of parts.slice(1)) {
        const text = part.trim();
        if (!text) continue;
        if (!parsed.duration && DURATION_RE.test(text)) { parsed.duration = text; continue; }
        if (!parsed.rowCount && ROW_COUNT_RE.test(text)) { parsed.rowCount = text; continue; }
        if (!parsed.connection) { parsed.connection = text; continue; }
        leftovers.push(text);
    }
    if (leftovers.length > 0) parsed.errorText = leftovers.join(' | ');
    return parsed;
}

/** Mirrors the host-side formatting so structured metadata renders like legacy rows. */
export function formatRunDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}

export function formatRunRowCount(rowCount: number): string {
    if (!Number.isFinite(rowCount)) return '';
    const value = Math.max(0, Math.round(rowCount));
    return `${value.toLocaleString('en-US')} ${value === 1 ? 'row' : 'rows'}`;
}

export function collapseSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

function appendChip(parent: HTMLElement, text: string | undefined, extraClass?: string): void {
    if (!text) return;
    const chip = document.createElement('span');
    chip.className = extraClass ? `log-chip ${extraClass}` : 'log-chip';
    chip.textContent = text;
    parent.appendChild(chip);
}

/**
 * Renders the card header: status badge + time/meta row + truncated SQL preview.
 * Everything is set via textContent so statement text can never inject markup.
 */
function renderRunSummary(
    summary: HTMLElement,
    row: LogRow,
    metadata: ExecutionLogDetails,
    parsed: ParsedRunMessage,
    context: { sql?: string; connectionName?: string },
): void {
    summary.textContent = '';
    summary.className = 'log-run-summary';

    const status: RunStatus = metadata.status ?? parsed.status ?? 'running';

    const badge = document.createElement('span');
    badge.className = `log-status log-status--${status}`;
    const icon = document.createElement('span');
    icon.className = 'log-status-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = STATUS_ICON[status];
    const label = document.createElement('span');
    label.className = 'log-status-label';
    label.textContent = STATUS_LABEL[status];
    badge.append(icon, label);
    summary.appendChild(badge);

    const main = document.createElement('span');
    main.className = 'log-summary-main';
    summary.appendChild(main);

    const meta = document.createElement('span');
    meta.className = 'log-meta';
    main.appendChild(meta);

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = String(row[0] ?? '');
    meta.appendChild(time);

    appendChip(meta, metadata.connectionName ?? context.connectionName ?? parsed.connection);
    appendChip(meta, metadata.durationMs !== undefined ? formatRunDuration(metadata.durationMs) : parsed.duration);
    const rowCount = metadata.rowCount !== undefined ? formatRunRowCount(metadata.rowCount) : parsed.rowCount;
    appendChip(meta, rowCount, metadata.rowCount === 0 ? 'log-chip--empty' : undefined);

    const sql = metadata.sql ?? context.sql ?? parsed.sqlPreview;
    if (sql) {
        const preview = document.createElement('code');
        preview.className = 'log-sql-preview';
        const collapsed = collapseSql(sql);
        preview.title = collapsed.slice(0, 1000);
        preview.textContent = collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
        main.appendChild(preview);
    }
    if (status === 'error' && parsed.errorText) {
        const hint = document.createElement('span');
        hint.className = 'log-error-hint';
        hint.textContent = parsed.errorText.length > 200 ? `${parsed.errorText.slice(0, 200)}…` : parsed.errorText;
        main.appendChild(hint);
    }
}

/** Empty-state seed row: never grouped, hidden once real runs exist. */
const SEED_MESSAGE = 'No results yet';

function isSeedRow(row: LogRow): boolean {
    const metadata = row[2] as ExecutionLogDetails | undefined;
    return String(row[1] ?? '') === SEED_MESSAGE && !metadata?.executionId;
}

function isSeedLine(element: Element): boolean {
    return element.textContent?.includes(SEED_MESSAGE) ?? false;
}

/**
 * Moves loose timeline lines rendered before this card into its body.
 * Covers legacy/persisted transcripts where lead-in rows (Preparing,
 * Connected, ...) were stored without an executionId: they belong to the
 * next statement card, not above the first SUCCESS card.
 */
function adoptPrecedingLooseLines(container: HTMLElement, body: HTMLElement): void {
    const loose = Array.from(container.children).filter(
        el => el instanceof HTMLElement && el.classList.contains('console-line'),
    );
    for (const line of loose) {
        if (isSeedLine(line)) {
            line.remove();
            continue;
        }
        body.append(line);
    }
}

/** Renders a compact error line inside the card body (the header already shows the SQL). */
function createErrorLine(errorText: string): HTMLElement {
    const line = document.createElement('div');
    line.className = 'console-line status-error log-error-line';
    const label = document.createElement('span');
    label.className = 'log-status log-status--error';
    const icon = document.createElement('span');
    icon.className = 'log-status-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = STATUS_ICON.error;
    const labelText = document.createElement('span');
    labelText.textContent = 'ERROR';
    label.append(icon, labelText);
    const message = document.createElement('span');
    message.className = 'console-msg';
    message.textContent = errorText;
    line.append(label, message);
    return line;
}

/** Groups by execution identity, including incremental messages and terminal updates. */
export function appendRunLogRows(container: HTMLElement, rows: LogRow[], createLine: (row: LogRow) => HTMLElement): void {
    const batchHasRuns =
        rows.some(row => (row[2] as ExecutionLogDetails | undefined)?.executionId !== undefined) ||
        container.querySelector('details.log-run') !== null;
    for (const row of rows) {
        const metadata = row[2] as ExecutionLogDetails | undefined;
        if (!metadata?.executionId) {
            // Empty-state seed is hidden once real statement cards exist.
            if (isSeedRow(row) && batchHasRuns) continue;
            container.append(createLine(row));
            continue;
        }
        let run = [...container.querySelectorAll<HTMLDetailsElement>('details.log-run')].find(item => item.dataset.executionId === metadata.executionId);
        if (!run) {
            run = document.createElement('details');
            run.className = 'log-run';
            run.dataset.executionId = metadata.executionId;
            run.open = disclosures.get(metadata.executionId) ?? false;
            const summary = document.createElement('summary');
            summary.className = 'log-run-summary';
            const body = document.createElement('div');
            body.className = 'log-run-body';
            run.append(summary, body);
            run.addEventListener('toggle', () => {
                disclosures.set(metadata.executionId, run!.open);
                if (disclosures.size > 500) disclosures.delete(disclosures.keys().next().value!);
            });
            container.append(run);
            adoptPrecedingLooseLines(container, body);
        }
        if (metadata.sql || metadata.connectionName) {
            rememberContext(metadata.executionId, { sql: metadata.sql, connectionName: metadata.connectionName });
        }
        const parsed = parseRunMessage(String(row[1] ?? ''));
        if (metadata.event === 'start' || metadata.event === 'end') {
            renderRunSummary(run.querySelector('summary')!, row, metadata, parsed, runContext.get(metadata.executionId) ?? {});
            run.dataset.status = metadata.status ?? parsed.status ?? run.dataset.status ?? 'running';
        }
        const body = run.querySelector<HTMLElement>('.log-run-body')!;
        const fullSql = metadata.sql ?? runContext.get(metadata.executionId)?.sql;
        if (fullSql && !body.querySelector('.log-run-sql')) {
            const sql = document.createElement('pre');
            sql.className = 'log-run-sql';
            sql.textContent = fullSql;
            // Prepend so buffered lead-in rows (flushed before the start row
            // in the same batch) still render below the statement text.
            body.prepend(sql);
        }
        // The header already represents start/end rows; the body keeps the timeline
        // (progress messages) plus a compact error line so the message is not lost
        // (end rows carry no structured errorMessage field).
        if (metadata.event === 'message' || !metadata.event) {
            body.append(createLine(row));
        } else if (metadata.event === 'end' && (metadata.status === 'error' || metadata.status === 'retrying') && parsed.errorText) {
            body.append(createErrorLine(parsed.errorText));
        }
    }
}
