import { getActiveGridIndex } from './state.js';
import { formatCellValue } from './utils.js';
import { getHostState, setHostState } from './protocol.js';
import { getElementById } from './dom.js';
import { closeRowView } from './rowView.js';
import {
    callPanelMethod,
    getActiveSourceUri,
    getResultSetAt,
    getResultSets,
} from './types.js';
import type { ResultSet, ResultSetColumn } from './types.js';

type ResultViewMode = 'table' | 'chart' | 'diff';

interface AnalysisField {
    id: string;
    index: number;
    accessorKey: string | number;
    name: string;
    type: string;
}

interface DiffCell {
    before: string;
    after: string;
    changed: boolean;
}

interface DiffRow {
    rowIndex: number;
    type: 'added' | 'removed' | 'changed';
    cells: DiffCell[];
}

interface DiffBuildResult {
    columns: AnalysisField[];
    rows: DiffRow[];
    summary: {
        added: number;
        removed: number;
        changed: number;
        totalDiffs: number;
    };
    truncated: boolean;
    compatibilityNote: string | null;
}

interface HostViewModesState {
    _viewModes?: Record<string, ResultViewMode>;
    [key: string]: unknown;
}

const DEFAULT_VIEW_MODE: ResultViewMode = 'table';
const MAX_DIFF_ROWS = 500;
let activeDiffTruncated = false;

export function getAnalysisLimitWarning(): string {
    const mode = getActiveResultViewMode();
    if (mode === 'diff' && activeDiffTruncated) {
        return `Diff view shows only the first ${MAX_DIFF_ROWS.toLocaleString()} differences.`;
    }
    return '';
}
const MINI_CHART_SAMPLE = 120;

const viewModesByResult: Record<string, ResultViewMode> = {};
const diffBaselineByResult: Record<string, number> = {};

function getResultSet(rsIndex: number = getActiveGridIndex()): ResultSet | null {
    if (rsIndex < 0) {
        return null;
    }
    return getResultSetAt(rsIndex) ?? null;
}

function getResultKey(rsIndex: number = getActiveGridIndex()): string {
    const source = getActiveSourceUri() || '';
    return `${source}:${rsIndex}`;
}

function normalizeMode(mode: string | undefined | null): ResultViewMode {
    const normalized = (mode || '').toLowerCase();
    if (normalized === 'chart' || normalized === 'diff' || normalized === 'table') {
        return normalized;
    }
    return DEFAULT_VIEW_MODE;
}

function normalizeHeaderName(name: string | undefined | null): string {
    return String(name || '')
        .trim()
        .toLowerCase();
}

function getResultFields(resultSet: ResultSet | null): AnalysisField[] {
    if (!resultSet || !Array.isArray(resultSet.columns)) {
        return [];
    }

    return resultSet.columns.map((col: ResultSetColumn, index: number) => ({
        id: String(index),
        index,
        accessorKey: col.accessorKey ?? col.index ?? String(index),
        name: col.name || col.header || `Col ${index + 1}`,
        type: col.type || ''
    }));
}

function getRawCellValue(row: unknown, field: AnalysisField | null): unknown {
    if (!row || !field) {
        return null;
    }

    if (Array.isArray(row)) {
        return row[field.index];
    }

    if (typeof row === 'object' && row !== null) {
        const record = row as Record<string | number, unknown>;
        if (field.accessorKey !== undefined && field.accessorKey !== null && field.accessorKey !== '') {
            return record[field.accessorKey];
        }
        return record[field.id];
    }

    return null;
}

function parseNumeric(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    const parsed = parseFloat(String(value).replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : null;
}

function toDisplayValue(value: unknown, type: string, scale?: number): string {
    const formatted = formatCellValue(value, type, scale);
    if (formatted === null || formatted === undefined) {
        return 'NULL';
    }
    return String(formatted);
}

function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatNumber(value: unknown): string {
    if (value === null || value === undefined || value === '') {
        return '';
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return String(value);
    }

    return value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4
    });
}

function isNumericField(resultSet: ResultSet, field: AnalysisField): boolean {
    const rows = Array.isArray(resultSet?.data) ? resultSet.data : [];
    if (rows.length === 0) {
        return false;
    }

    let nonNullCount = 0;
    let numericCount = 0;
    const sampleSize = Math.min(rows.length, MINI_CHART_SAMPLE);

    for (let i = 0; i < sampleSize; i++) {
        const rawValue = getRawCellValue(rows[i], field);
        if (rawValue === null || rawValue === undefined || rawValue === '') {
            continue;
        }

        nonNullCount++;
        if (parseNumeric(rawValue) !== null) {
            numericCount++;
        }
    }

    if (nonNullCount === 0) {
        return false;
    }

    return numericCount / nonNullCount >= 0.7;
}

function updateDiffBaselineOptions(activeIndex: number = getActiveGridIndex()): void {
    const baselineSelect = getElementById<HTMLSelectElement>('diffBaselineSelect');
    if (!baselineSelect) {
        return;
    }

    const activeResult = getResultSet(activeIndex);
    const key = getResultKey(activeIndex);
    baselineSelect.innerHTML = '';

    if (!activeResult || activeResult.isLog || activeResult.isError) {
        baselineSelect.disabled = true;
        baselineSelect.style.display = 'none';
        baselineSelect.innerHTML = '<option value="">No baseline</option>';
        return;
    }

    const baselineOptions: Array<{ index: number; label: string; rowCount: number }> = [];
    getResultSets().forEach((candidate, index) => {
        if (!candidate || candidate.isLog || candidate.isError || index === activeIndex) {
            return;
        }

        const rowCount = Array.isArray(candidate.data) ? candidate.data.length : 0;
        baselineOptions.push({
            index,
            label: `${candidate.name || `Result ${index}`}`,
            rowCount
        });
    });

    if (baselineOptions.length === 0) {
        baselineSelect.disabled = true;
        baselineSelect.innerHTML = '<option value="">No comparable result sets</option>';
        return;
    }

    baselineOptions.sort((a, b) => a.index - b.index);
    let selectedIndex = diffBaselineByResult[key];
    if (!baselineOptions.some(option => option.index === selectedIndex)) {
        const nearestPrevious = [...baselineOptions].reverse().find(option => option.index < activeIndex);
        selectedIndex = nearestPrevious ? nearestPrevious.index : baselineOptions[baselineOptions.length - 1].index;
        diffBaselineByResult[key] = selectedIndex;
    }

    baselineOptions.forEach(option => {
        const element = document.createElement('option');
        element.value = String(option.index);
        element.textContent = `${option.label} (${option.rowCount.toLocaleString()} rows)`;
        if (option.index === selectedIndex) {
            element.selected = true;
        }
        baselineSelect.appendChild(element);
    });

    baselineSelect.disabled = false;
}


function applyViewMode(mode: string, rsIndex: number = getActiveGridIndex()): void {
    const normalizedMode = normalizeMode(mode);
    const resultSet = getResultSet(rsIndex);
    const gridContainer = getElementById('gridContainer');
    const analysisContainer = getElementById('analysisContainer');
    const groupingPanel = getElementById('groupingPanel');
    const baselineSelect = getElementById<HTMLSelectElement>('diffBaselineSelect');

    if (!gridContainer || !analysisContainer) {
        return;
    }

    const forcedTableMode = !resultSet || resultSet.isLog || resultSet.isError;
    const effectiveMode = forcedTableMode ? 'table' : normalizedMode;

    if (effectiveMode === 'table') {
        activeDiffTruncated = false;
        gridContainer.style.display = '';
        analysisContainer.style.display = 'none';
        analysisContainer.innerHTML = '';
        if (groupingPanel) {
            groupingPanel.style.display = forcedTableMode ? 'none' : '';
        }
        if (baselineSelect) {
            baselineSelect.style.display = 'none';
        }
        return;
    }

    gridContainer.style.display = 'none';
    analysisContainer.style.display = 'block';
    if (groupingPanel) {
        groupingPanel.style.display = 'none';
    }
    closeRowView();

    if (baselineSelect) {
        baselineSelect.style.display = effectiveMode === 'diff' ? '' : 'none';
    }

    if (effectiveMode === 'chart') {
        activeDiffTruncated = false;
        renderMiniChartsView(rsIndex);
    } else if (effectiveMode === 'diff') {
        renderDiffView(rsIndex);
    }
}

export function getActiveResultViewMode(rsIndex: number = getActiveGridIndex()): ResultViewMode {
    const key = getResultKey(rsIndex);
    let mode = viewModesByResult[key];
    if (!mode) {
        const state = getHostState() as HostViewModesState | null;
        if (state?._viewModes?.[key]) {
            mode = state._viewModes[key];
            viewModesByResult[key] = mode;
        }
    }
    return normalizeMode(mode || DEFAULT_VIEW_MODE);
}

export function setResultViewModeForIndex(rsIndex: number, mode: string): void {
    const normalizedMode = normalizeMode(mode);
    const key = getResultKey(rsIndex);
    viewModesByResult[key] = normalizedMode;
    const state = (getHostState() as HostViewModesState | null) || {};
    if (!state._viewModes) state._viewModes = {};
    state._viewModes[key] = normalizedMode;
    setHostState(state);

    if (rsIndex === getActiveGridIndex()) {
        const modeSelect = getElementById<HTMLSelectElement>('viewModeSelect');
        if (modeSelect) {
            modeSelect.value = normalizedMode;
        }
        callPanelMethod('syncViewModeBar', normalizedMode);
        syncAnalysisView();
    }
}

export function setActiveResultViewMode(mode: string): void {
    setResultViewModeForIndex(getActiveGridIndex(), mode);
}

export function initializeAnalysisModeControls(): void {
    const modeSelect = getElementById<HTMLSelectElement>('viewModeSelect');
    const baselineSelect = getElementById<HTMLSelectElement>('diffBaselineSelect');

    if (modeSelect && !modeSelect.dataset.initialized) {
        modeSelect.dataset.initialized = 'true';
        modeSelect.addEventListener('change', () => {
            setActiveResultViewMode(modeSelect.value);
        });
    }

    if (baselineSelect && !baselineSelect.dataset.initialized) {
        baselineSelect.dataset.initialized = 'true';
        baselineSelect.addEventListener('change', () => {
            const key = getResultKey();
            const parsed = parseInt(baselineSelect.value, 10);
            if (!Number.isNaN(parsed)) {
                diffBaselineByResult[key] = parsed;
            }
            if (getActiveResultViewMode() === 'diff') {
                renderDiffView(getActiveGridIndex());
            }
        });
    }

    syncAnalysisView();
}

export function syncAnalysisView(): void {
    const activeIndex = getActiveGridIndex();
    const modeSelect = getElementById<HTMLSelectElement>('viewModeSelect');
    const activeResult = getResultSet(activeIndex);

    if (!modeSelect) {
        return;
    }

    if (!activeResult || activeResult.isLog || activeResult.isError) {
        modeSelect.value = 'table';
        modeSelect.disabled = true;
        callPanelMethod('setLayoutSwitcherDisabled', true);
        callPanelMethod('syncViewModeBar', 'table');
        applyViewMode('table', activeIndex);
        return;
    }

    modeSelect.disabled = false;
    callPanelMethod('setLayoutSwitcherDisabled', false);
    const mode = getActiveResultViewMode(activeIndex);
    modeSelect.value = mode;
    callPanelMethod('syncViewModeBar', mode);
    updateDiffBaselineOptions(activeIndex);
    applyViewMode(mode, activeIndex);
    callPanelMethod('updateResultLimitBanner');
}

function createSparklinePath(values: number[], width: number, height: number, padding: number): string {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const innerWidth = width - padding * 2;
    const innerHeight = height - padding * 2;

    return values.map((value, index) => {
        const x = padding + (index / Math.max(values.length - 1, 1)) * innerWidth;
        const y = padding + (1 - ((value - min) / range)) * innerHeight;
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ');
}

function buildMiniChartCard(field: AnalysisField, values: number[]): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'mini-chart-card';

    const title = document.createElement('div');
    title.className = 'mini-chart-title';
    title.textContent = field.name;
    card.appendChild(title);

    if (!values.length) {
        const empty = document.createElement('div');
        empty.className = 'mini-chart-empty';
        empty.textContent = 'Not enough numeric values';
        card.appendChild(empty);
        return card;
    }

    const width = 170;
    const height = 42;
    const path = createSparklinePath(values, width, height, 4);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;

    const svg = document.createElement('div');
    svg.className = 'mini-chart-sparkline';
    svg.innerHTML = `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
            <path d="${path}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"></path>
        </svg>
    `;
    card.appendChild(svg);

    const meta = document.createElement('div');
    meta.className = 'mini-chart-meta';
    meta.textContent = `min ${formatNumber(min)} • avg ${formatNumber(avg)} • max ${formatNumber(max)}`;
    card.appendChild(meta);

    return card;
}

function renderMiniChartsView(rsIndex: number): void {
    const analysisContainer = getElementById('analysisContainer');
    const resultSet = getResultSet(rsIndex);
    if (!analysisContainer || !resultSet) {
        return;
    }

    const fields = getResultFields(resultSet);
    const numericFields = fields.filter(field => isNumericField(resultSet, field));

    analysisContainer.innerHTML = `
        <div class="analysis-view">
            <div class="analysis-header">
                <div class="analysis-title">Mini Charts</div>
                <div class="analysis-subtitle">Inline numeric trends for the active result set.</div>
            </div>
            <div id="miniChartsGrid" class="mini-charts-grid"></div>
        </div>
    `;

    const chartsGrid = getElementById('miniChartsGrid');
    if (!chartsGrid) {
        return;
    }
    if (!numericFields.length) {
        chartsGrid.innerHTML = '<div class="analysis-empty">No numeric columns available for mini charts.</div>';
        return;
    }

    numericFields.slice(0, 16).forEach(field => {
        const values: number[] = [];
        const rows = Array.isArray(resultSet.data) ? resultSet.data : [];

        for (let i = 0; i < rows.length && values.length < MINI_CHART_SAMPLE; i++) {
            const numeric = parseNumeric(getRawCellValue(rows[i], field));
            if (numeric !== null) {
                values.push(numeric);
            }
        }

        chartsGrid.appendChild(buildMiniChartCard(field, values));
    });
}

function buildColumnMappings(
    baseResult: ResultSet,
    targetResult: ResultSet,
): { mappings: Array<{ target: AnalysisField; base: AnalysisField }>; compatibilityNote: string | null } {
    const baseFields = getResultFields(baseResult);
    const targetFields = getResultFields(targetResult);
    const baseByName = new Map(baseFields.map(field => [normalizeHeaderName(field.name), field]));

    const mappings = targetFields.map((targetField, targetIndex) => {
        const byName = baseByName.get(normalizeHeaderName(targetField.name));
        const byIndex = baseFields[targetIndex];
        return {
            target: targetField,
            base: byName || byIndex || null
        };
    }).filter((mapping): mapping is { target: AnalysisField; base: AnalysisField } => !!mapping.base);

    const sameHeaderLayout = baseFields.length === targetFields.length &&
        targetFields.every((targetField, index) =>
            normalizeHeaderName(targetField.name) === normalizeHeaderName(baseFields[index]?.name)
        );

    const compatibilityNote = sameHeaderLayout
        ? null
        : 'Column layouts differ. Diff mapping used matching names and fallback by position.';

    return {
        mappings,
        compatibilityNote
    };
}

function buildDiffRows(baseResult: ResultSet, targetResult: ResultSet): DiffBuildResult {
    const { mappings, compatibilityNote } = buildColumnMappings(baseResult, targetResult);
    const baseRows = Array.isArray(baseResult.data) ? baseResult.data : [];
    const targetRows = Array.isArray(targetResult.data) ? targetResult.data : [];
    const maxRows = Math.max(baseRows.length, targetRows.length);

    const diffRows: DiffRow[] = [];
    let added = 0;
    let removed = 0;
    let changed = 0;

    for (let rowIndex = 0; rowIndex < maxRows; rowIndex++) {
        const baseRow = baseRows[rowIndex];
        const targetRow = targetRows[rowIndex];

        if (!baseRow && !targetRow) {
            continue;
        }

        if (!baseRow && targetRow) {
            added += 1;
            diffRows.push({
                rowIndex,
                type: 'added',
                cells: mappings.map(mapping => ({
                    before: '',
                    after: toDisplayValue(getRawCellValue(targetRow, mapping.target), mapping.target.type),
                    changed: true
                }))
            });
            continue;
        }

        if (baseRow && !targetRow) {
            removed += 1;
            diffRows.push({
                rowIndex,
                type: 'removed',
                cells: mappings.map(mapping => ({
                    before: toDisplayValue(getRawCellValue(baseRow, mapping.base), mapping.base.type),
                    after: '',
                    changed: true
                }))
            });
            continue;
        }

        const cells = mappings.map(mapping => {
            const baseField = mapping.base;
            const before = toDisplayValue(getRawCellValue(baseRow, baseField), baseField.type);
            const after = toDisplayValue(getRawCellValue(targetRow, mapping.target), mapping.target.type);
            return {
                before,
                after,
                changed: before !== after
            };
        });

        const hasChanges = cells.some(cell => cell.changed);
        if (hasChanges) {
            changed += 1;
            diffRows.push({
                rowIndex,
                type: 'changed',
                cells
            });
        }
    }

    const truncated = diffRows.length > MAX_DIFF_ROWS;
    return {
        columns: mappings.map(mapping => mapping.target),
        rows: truncated ? diffRows.slice(0, MAX_DIFF_ROWS) : diffRows,
        summary: {
            added,
            removed,
            changed,
            totalDiffs: diffRows.length
        },
        truncated,
        compatibilityNote
    };
}

function renderDiffView(rsIndex: number): void {
    const analysisContainer = getElementById('analysisContainer');
    const baselineSelect = getElementById<HTMLSelectElement>('diffBaselineSelect');
    const targetResult = getResultSet(rsIndex);

    if (!analysisContainer || !targetResult) {
        return;
    }

    const key = getResultKey(rsIndex);
    if (baselineSelect) {
        const parsed = parseInt(baselineSelect.value, 10);
        if (!Number.isNaN(parsed)) {
            diffBaselineByResult[key] = parsed;
        }
    }

    const baselineIndex = diffBaselineByResult[key];
    const baselineResult = getResultSet(baselineIndex);

    if (!baselineResult || baselineResult.isLog || baselineResult.isError) {
        analysisContainer.innerHTML = `
            <div class="analysis-view">
                <div class="analysis-header">
                    <div class="analysis-title">Diff Results</div>
                    <div class="analysis-subtitle">Choose a baseline result set to compare against the active result.</div>
                </div>
                <div class="analysis-empty">No baseline result set selected.</div>
            </div>
        `;
        return;
    }

    const diff = buildDiffRows(baselineResult, targetResult);
    activeDiffTruncated = !!diff.truncated;
    const baselineLabel = baselineResult.name || `Result ${baselineIndex}`;
    const targetLabel = targetResult.name || `Result ${rsIndex}`;

    const headerHtml = `
        <div class="analysis-header">
            <div class="analysis-title">Diff Results</div>
            <div class="analysis-subtitle">${escapeHtml(baselineLabel)} → ${escapeHtml(targetLabel)}</div>
        </div>
    `;

    if (!diff.rows.length) {
        analysisContainer.innerHTML = `
            <div class="analysis-view">
                ${headerHtml}
                <div class="analysis-summary">No differences detected.</div>
            </div>
        `;
        return;
    }

    const summary = `
        <div class="analysis-summary">
            Added: ${diff.summary.added.toLocaleString()} • Removed: ${diff.summary.removed.toLocaleString()} • Changed: ${diff.summary.changed.toLocaleString()}
        </div>
    `;
    const note = diff.compatibilityNote
        ? `<div class="analysis-note">${escapeHtml(diff.compatibilityNote)}</div>`
        : '';
    const truncatedNote = diff.truncated
        ? `<div class="analysis-note">Showing first ${MAX_DIFF_ROWS.toLocaleString()} differences.</div>`
        : '';

    const tableHead = `
        <tr>
            <th>#</th>
            <th>Type</th>
            ${diff.columns.map(column => `<th>${escapeHtml(column.name)}</th>`).join('')}
        </tr>
    `;

    const tableRows = diff.rows.map(row => {
        const typeClass = row.type === 'added'
            ? 'diff-row-added'
            : row.type === 'removed'
                ? 'diff-row-removed'
                : 'diff-row-changed';
        const typeLabel = row.type.toUpperCase();

        const cells = row.cells.map(cell => {
            if (row.type === 'added') {
                return `<td class="diff-cell-added">${escapeHtml(cell.after)}</td>`;
            }
            if (row.type === 'removed') {
                return `<td class="diff-cell-removed">${escapeHtml(cell.before)}</td>`;
            }
            if (!cell.changed) {
                return `<td>${escapeHtml(cell.after)}</td>`;
            }
            return `<td class="diff-cell-changed"><div class="diff-cell-before">${escapeHtml(cell.before)}</div><div class="diff-cell-after">${escapeHtml(cell.after)}</div></td>`;
        }).join('');

        return `<tr class="${typeClass}"><td>${(row.rowIndex + 1).toLocaleString()}</td><td>${typeLabel}</td>${cells}</tr>`;
    }).join('');

    analysisContainer.innerHTML = `
        <div class="analysis-view">
            ${headerHtml}
            ${summary}
            ${note}
            ${truncatedNote}
            <div class="analysis-table-wrapper">
                <table class="analysis-table diff-analysis-table">
                    <thead>${tableHead}</thead>
                    <tbody>${tableRows}</tbody>
                </table>
            </div>
        </div>
    `;
}

