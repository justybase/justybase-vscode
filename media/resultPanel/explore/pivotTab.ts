// Explore pivot tab: configuration (rows / columns / values) + results grid
// with row and column totals.

import { getElementById } from '../dom.js';
import { postHostMessage } from '../protocol.js';
import { requestExplorePivot, previewExplorePivot, openExploreSqlInEditor } from './hostBridge.js';
import { showSqlPreviewModal } from './previewModal.js';
import type {
    ExploreColumnMeta,
    ExploreFilterModel,
    ExplorePivotAggregate,
    ExplorePivotConfig,
} from './types.js';

const AGG_LABELS: Record<ExplorePivotAggregate, string> = {
    sum: 'Sum',
    avg: 'Avg',
    min: 'Min',
    max: 'Max',
    count: 'Count',
    countDistinct: 'Distinct',
};

export interface PivotTabState {
    config: ExplorePivotConfig;
    pivotValues: string[];
}

export interface PivotTabOptions {
    columns: readonly ExploreColumnMeta[];
    filters: ExploreFilterModel;
    state?: PivotTabState;
    onStateChange: (state: PivotTabState) => void;
}

function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function renderPivotTab(
    root: HTMLElement,
    options: PivotTabOptions,
): void {
    const { columns, filters, state, onStateChange } = options;
    const dimensions = columns.filter(column => column.role === 'dimension' || column.role === 'date');
    const measures = columns.filter(column => column.role === 'measure');

    const current = state?.config;
    const rowIndexes = current?.rowColumnIndexes ?? (dimensions[0] ? [dimensions[0].index] : []);
    const columnIndex = current?.columnColumnIndex ?? (dimensions[1]?.index ?? dimensions[0]?.index ?? -1);
    const valueIndex = current?.valueColumnIndex ?? (measures[0]?.index ?? -1);
    const aggFn: ExplorePivotAggregate = current?.aggFn ?? 'sum';

    root.innerHTML = `
        <div class="explore-tab-config">
            <label class="explore-config-field">
                <span>Rows</span>
                <select id="explorePivotRows" multiple size="4">
                    ${dimensions.map(column => `<option value="${column.index}" ${rowIndexes.includes(column.index) ? 'selected' : ''}>${escapeHtml(column.name)}</option>`).join('')}
                </select>
            </label>
            <label class="explore-config-field">
                <span>Columns</span>
                <select id="explorePivotCol">
                    <option value="-1" ${columnIndex < 0 ? 'selected' : ''}>— none —</option>
                    ${dimensions.map(column => `<option value="${column.index}" ${column.index === columnIndex ? 'selected' : ''}>${escapeHtml(column.name)}</option>`).join('')}
                </select>
            </label>
            <label class="explore-config-field">
                <span>Values</span>
                <select id="explorePivotValue">
                    <option value="-1" ${valueIndex < 0 ? 'selected' : ''}>— none —</option>
                    ${measures.map(column => `<option value="${column.index}" ${column.index === valueIndex ? 'selected' : ''}>${escapeHtml(column.name)}</option>`).join('')}
                </select>
            </label>
            <label class="explore-config-field">
                <span>Aggregate</span>
                <select id="explorePivotAgg">
                    ${(Object.keys(AGG_LABELS) as ExplorePivotAggregate[]).map(key => `<option value="${key}" ${key === aggFn ? 'selected' : ''}>${AGG_LABELS[key]}</option>`).join('')}
                </select>
            </label>
            <div class="explore-config-actions">
                <button id="explorePivotRun" class="explore-primary-btn">Run Pivot</button>
                <button id="explorePivotPreview" class="explore-secondary-btn">SQL…</button>
            </div>
        </div>
        <div id="explorePivotResults" class="explore-tab-results">
            <div class="explore-empty">Configure rows/columns/values and run the pivot.</div>
        </div>
    `;

    const rowsSelect = getElementById<HTMLSelectElement>('explorePivotRows');
    const colSelect = getElementById<HTMLSelectElement>('explorePivotCol');
    const valueSelect = getElementById<HTMLSelectElement>('explorePivotValue');
    const aggSelect = getElementById<HTMLSelectElement>('explorePivotAgg');

    const readConfig = (): { config: ExplorePivotConfig; error?: string } => {
        const rowIndexes = Array.from(rowsSelect?.selectedOptions ?? []).map(option => Number(option.value));
        const columnIndex = Number(colSelect?.value ?? -1);
        const valueIndex = Number(valueSelect?.value ?? -1);
        if (rowIndexes.length === 0) {
            return { config: { rowColumnIndexes: [], columnColumnIndex: columnIndex, valueColumnIndex: valueIndex, aggFn }, error: 'Select at least one row dimension.' };
        }
        if (columnIndex < 0) {
            return { config: { rowColumnIndexes: rowIndexes, columnColumnIndex: columnIndex, valueColumnIndex: valueIndex, aggFn }, error: 'Select a pivot column.' };
        }
        if (valueIndex < 0) {
            return { config: { rowColumnIndexes: rowIndexes, columnColumnIndex: columnIndex, valueColumnIndex: valueIndex, aggFn }, error: 'Select a value column.' };
        }
        return {
            config: {
                rowColumnIndexes: rowIndexes,
                columnColumnIndex: columnIndex,
                valueColumnIndex: valueIndex,
                aggFn: (aggSelect?.value as ExplorePivotAggregate) ?? 'sum',
                filters,
            },
        };
    };

    const persist = (config: ExplorePivotConfig, pivotValues: string[]) => {
        onStateChange({ config, pivotValues });
    };

    const run = async () => {
        const { config, error } = readConfig();
        const results = getElementById('explorePivotResults');
        if (!results) return;
        if (error) {
            results.innerHTML = `<div class="explore-error">${escapeHtml(error)}</div>`;
            return;
        }
        const pivotColumn = columns[config.columnColumnIndex];
        const values = pivotColumn ? (pivotColumnValues(pivotColumn) ?? []) : [];
        results.innerHTML = '<div class="explore-loading">Running pivot…</div>';
        try {
            const result = await requestExplorePivot(config);
            persist(config, result.pivotValues ?? values);
            renderPivotResults(results, result.rows, result.columns, result.sql, result.truncated);
        } catch (err) {
            results.innerHTML = `<div class="explore-error">${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
        }
    };

    const preview = async () => {
        const { config, error } = readConfig();
        if (error) {
            postHostMessage({ command: 'info', text: error });
            return;
        }
        const pivotColumn = columns[config.columnColumnIndex];
        const values = pivotColumn ? (pivotColumnValues(pivotColumn) ?? []) : [];
        try {
            const sql = await previewExplorePivot(config, values);
            showSqlPreviewModal({
                title: 'Pivot SQL',
                sql,
                onOpenInEditor: sqlText => openExploreSqlInEditor(sqlText, 'Explore pivot query'),
            });
        } catch (err) {
            postHostMessage({ command: 'error', text: err instanceof Error ? err.message : String(err) });
        }
    };

    getElementById('explorePivotRun')?.addEventListener('click', () => void run());
    getElementById('explorePivotPreview')?.addEventListener('click', () => void preview());
}

/**
 * Best-effort pivot column values from the column overview top values.
 * Attached by the explore orchestrator while computing the overview.
 */
function pivotColumnValues(column: ExploreColumnMeta): string[] | undefined {
    return column.exploreTopValues?.length ? column.exploreTopValues : undefined;
}

interface PivotResultColumn {
    name: string;
    type?: string;
    kind: 'row' | 'value';
}

function renderPivotResults(
    root: HTMLElement,
    rows: unknown[][],
    resultColumns: PivotResultColumn[],
    sql: string,
    truncated?: boolean,
): void {
    if (!rows || rows.length === 0) {
        root.innerHTML = '<div class="explore-empty">Pivot returned no rows.</div>';
        return;
    }

    const rowColumnCount = resultColumns.filter(column => column.kind === 'row').length;
    const valueColumns = resultColumns.filter(column => column.kind === 'value');
    const columnTotals = valueColumns.map(() => 0);

    for (const row of rows) {
        valueColumns.forEach((_, index) => {
            const raw = row[rowColumnCount + index];
            const parsed = typeof raw === 'number' ? raw : Number(String(raw ?? ''));
            if (Number.isFinite(parsed)) {
                columnTotals[index] += parsed;
            }
        });
    }

    const headerCells = resultColumns.map(column => `<th>${escapeHtml(column.name)}</th>`).join('');
    const bodyRows = rows.map(row => {
        const rowTotal = valueColumns.reduce((sum, _, index) => {
            const raw = row[rowColumnCount + index];
            const parsed = typeof raw === 'number' ? raw : Number(String(raw ?? ''));
            return sum + (Number.isFinite(parsed) ? parsed : 0);
        }, 0);
        const cells = resultColumns.map((column, index) => {
            if (column.kind === 'row') {
                return `<td class="explore-pivot-row-name">${escapeHtml(row[index] ?? '')}</td>`;
            }
            const raw = row[index];
            if (raw === null || raw === undefined || raw === '') {
                return '<td class="explore-pivot-cell is-null">NULL</td>';
            }
            return `<td class="explore-pivot-cell">${escapeHtml(typeof raw === 'number' ? raw.toLocaleString() : String(raw))}</td>`;
        });
        return `<tr>${cells.join('')}<td class="explore-pivot-total">${rowTotal.toLocaleString()}</td></tr>`;
    }).join('');

    const truncatedNote = truncated
        ? '<div class="explore-note">Results truncated — showing the first 5,000 rows.</div>'
        : '';

    const footerCells = resultColumns.map((column, index) => {
        if (column.kind === 'row') {
            return '<td class="explore-pivot-total">Σ</td>';
        }
        const total = columnTotals[index - rowColumnCount];
        return `<td class="explore-pivot-total">${(total ?? 0).toLocaleString()}</td>`;
    }).join('');

    root.innerHTML = `
        <div class="explore-pivot-summary">
            <span>${rows.length.toLocaleString()} rows</span>
            <button class="explore-sql-link" id="explorePivotOpenSql" title="Open pivot SQL in the editor">SQL</button>
        </div>
        ${truncatedNote}
        <div class="explore-table-wrapper">
            <table class="explore-table explore-pivot-table">
                <thead><tr>${headerCells}<th class="explore-pivot-total">Σ</th></tr></thead>
                <tbody>${bodyRows}</tbody>
                <tfoot><tr>${footerCells}<td class="explore-pivot-total">${columnTotals.reduce((a, b) => a + b, 0).toLocaleString()}</td></tr></tfoot>
            </table>
        </div>
    `;

    getElementById('explorePivotOpenSql')?.addEventListener('click', () => {
        openExploreSqlInEditor(sql, 'Explore pivot query');
    });
}
