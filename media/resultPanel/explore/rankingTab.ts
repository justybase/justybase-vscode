import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ExploreFilterModel, ExploreRankingConfig, ExploreResponse, ExploreValue } from '@justybase/contracts';
import type { ExploreColumnMeta } from './types.js';
import type { ExploreSelection } from './selectionActions.js';
import { requestExploreOperation, openExploreSqlInEditor, cancelExploreRequests } from './hostBridge.js';
import { button, element, field, select, valueLabel } from './ui.js';

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);
let chart: echarts.EChartsType | undefined;
let resizeObserver: ResizeObserver | undefined;
let viewEvents: AbortController | undefined;
export function disposeRankingChart(): void {
    resizeObserver?.disconnect(); resizeObserver = undefined;
    chart?.dispose(); chart = undefined;
}

export function disposeRankingView(): void {
    viewEvents?.abort(); viewEvents = undefined;
    disposeRankingChart();
}

export interface RankingViewState {
    result?: ExploreResponse;
    executedConfig?: ExploreRankingConfig;
}

export function renderRankingTab(root: HTMLElement, columns: readonly ExploreColumnMeta[], getFilters: () => ExploreFilterModel,
    config: ExploreRankingConfig | undefined, state: RankingViewState, save: (config: ExploreRankingConfig) => void,
    onSelect: (selection: ExploreSelection) => void): void {
    disposeRankingView();
    viewEvents = new AbortController();
    const defaults: ExploreRankingConfig = config ?? { categoryColumnIndex: columns.find(item => item.role === 'dimension')?.index ?? columns[0]?.index ?? 0,
        aggregate: 'count', direction: 'top', count: 10, showShare: false, includeOther: false };
    const category = select(columns.map(item => [String(item.index), item.name]), String(defaults.categoryColumnIndex));
    const measure = select([['', '— none —'], ...columns.map(item => [String(item.index), item.name] as [string, string])], String(defaults.measureColumnIndex ?? ''));
    const aggregate = select([['count', 'Count rows'], ['sum', 'Sum'], ['avg', 'Average'], ['min', 'Minimum'], ['max', 'Maximum'], ['countDistinct', 'Count distinct']], defaults.aggregate);
    const direction = select([['top', 'Top'], ['bottom', 'Bottom']], defaults.direction);
    const count = element('input'); count.type = 'number'; count.min = '1'; count.max = '100'; count.value = String(defaults.count);
    const share = element('input'); share.type = 'checkbox'; share.checked = defaults.showShare;
    const other = element('input'); other.type = 'checkbox'; other.checked = defaults.includeOther;
    const controls = element('div', undefined, 'explore-tab-config');
    controls.append(field('Category', category), field('Aggregate', aggregate), field('Measure', measure), field('Rank', direction), field('N', count), field('Show share', share), field('Include Other', other));
    const error = element('div', undefined, 'explore-error'); error.setAttribute('role', 'alert');
    const status = element('div', undefined, 'explore-note explore-database-status');
    const output = element('div');
    const read = (): ExploreRankingConfig => ({ categoryColumnIndex: Number(category.value), measureColumnIndex: measure.value === '' ? undefined : Number(measure.value),
        aggregate: aggregate.value as ExploreRankingConfig['aggregate'], direction: direction.value as 'top' | 'bottom', count: Number(count.value),
        showShare: share.checked && !share.disabled, includeOther: other.checked && !other.disabled, filters: getFilters() });
    const mark = () => {
        const additive = aggregate.value === 'count' || aggregate.value === 'sum';
        share.disabled = other.disabled = !additive;
        share.title = other.title = additive ? '' : 'Available for Count rows and Sum only.';
        measure.disabled = aggregate.value === 'count';
        const next = read(); save(next);
        if (state.result) status.textContent = JSON.stringify(next) === JSON.stringify(state.executedConfig)
            ? `Database · ${new Date(state.result.computedAt).toLocaleTimeString()} · Original SQL limits preserved`
            : 'Out of date · Press Run to apply current filters and settings';
    };
    const selection = (row: unknown[]) => {
        const executed = state.executedConfig;
        if (!executed || !state.result) return;
        const filters = structuredClone(state.result.filters);
        filters.dimensions = filters.dimensions.filter(item => item.columnIndex !== executed.categoryColumnIndex);
        const isOther = Number(row[3]) === 1;
        if (isOther) {
            const existing = state.result.filters.dimensions.find(item => item.columnIndex === executed.categoryColumnIndex);
            // Keep the original category restriction as well as the exclusion by using a separate predicate.
            if (existing) filters.dimensions.push(existing);
            const ranked = state.result.rows.filter(item => Number(item[3]) !== 1);
            filters.dimensions.push({ columnIndex: executed.categoryColumnIndex, mode: 'exclude',
                values: ranked.filter(item => item[0] != null && item[0] !== '').map(item => item[0] as ExploreValue),
                includeNull: ranked.some(item => item[0] == null), includeEmpty: ranked.some(item => item[0] === '') });
        } else filters.dimensions.push({ columnIndex: executed.categoryColumnIndex, values: row[0] == null || row[0] === '' ? [] : [row[0] as ExploreValue], includeNull: row[0] == null, includeEmpty: row[0] === '' });
        onSelect({ label: isOther ? 'Other (remaining categories)' : valueLabel(row[0]), scope: 'database', filters });
    };
    const draw = () => {
        disposeRankingChart(); output.replaceChildren();
        const result = state.result;
        if (!result) return;
        if (!result.rows.length) { output.append(element('p', 'No matching categories.')); return; }
        const context = element('details');
        context.append(element('summary', 'Applied filters'), element('pre', JSON.stringify(result.filters, null, 2))); output.append(context);
        if (state.executedConfig?.showShare && result.rows.every(row => row[2] == null)) output.append(element('p', 'Share unavailable: the total must be positive and category totals must be non-negative.'));
        const canvas = element('div', undefined, 'explore-ranking-chart');
        canvas.style.height = `${Math.min(900, Math.max(240, result.rows.length * 30 + 60))}px`; output.append(canvas);
        chart = echarts.init(canvas);
        const ink = getComputedStyle(document.body).getPropertyValue('--vscode-foreground').trim() || '#cccccc';
        chart.setOption({ animation: false, tooltip: { trigger: 'axis' }, grid: { left: '30%', right: 24, top: 16, bottom: 30 },
            xAxis: { type: 'value', axisLabel: { color: ink } }, yAxis: { type: 'category', inverse: true, data: result.rows.map(row => Number(row[3]) ? 'Other (remaining categories)' : valueLabel(row[0])), axisLabel: { color: ink, width: 160, overflow: 'truncate' } },
            series: [{ type: 'bar', data: result.rows.map(row => row[1] == null ? null : Number(row[1])), itemStyle: { color: getComputedStyle(document.body).getPropertyValue('--vscode-charts-blue').trim() || '#519aba' } }] });
        chart.on('click', event => { const row = result.rows[event.dataIndex]; if (row) selection(row); });
        if (typeof ResizeObserver !== 'undefined') { resizeObserver = new ResizeObserver(() => chart?.resize()); resizeObserver.observe(canvas); }
        const table = element('table', undefined, 'explore-table');
        const header = element('tr'); ['Category', 'Value', ...(state.executedConfig?.showShare ? ['Share'] : []), 'Actions'].forEach(name => header.append(element('th', name)));
        const head = element('thead'); head.append(header); table.append(head);
        const body = element('tbody');
        for (const row of result.rows) {
            const tr = element('tr'); tr.append(element('td', Number(row[3]) ? 'Other (remaining categories)' : valueLabel(row[0])), element('td', valueLabel(row[1])));
            if (state.executedConfig?.showShare) tr.append(element('td', row[2] == null ? '—' : `${Number(row[2]).toFixed(2)}%`));
            const action = element('td'); action.append(button('Explore selection', () => selection(row))); tr.append(action); body.append(tr);
        }
        table.append(body); const wrapper = element('div', undefined, 'explore-table-wrapper'); wrapper.append(table); output.append(wrapper);
    };
    const run = button('Run', () => {
        error.textContent = '';
        const next = read();
        if (!count.checkValidity() || !Number.isInteger(next.count) || next.count < 1 || next.count > 100) { error.textContent = 'N must be a whole number between 1 and 100.'; return; }
        if (next.aggregate !== 'count' && next.measureColumnIndex === undefined) { error.textContent = 'Select a measure.'; return; }
        run.disabled = true; status.textContent = 'Running ranking…';
        void requestExploreOperation({ kind: 'ranking', config: next }).then(result => {
            if (!root.isConnected) return;
            state.result = result; state.executedConfig = next; draw(); mark();
        }).catch(reason => { if (root.isConnected) { error.textContent = reason instanceof Error ? reason.message : String(reason); status.textContent = state.result ? 'Out of date · Previous result retained' : 'No database result'; } })
            .finally(() => { run.disabled = false; });
    });
    controls.append(run, button('Cancel', cancelExploreRequests), button('Open SQL', () => {
        void requestExploreOperation({ kind: 'ranking', config: read() }, true).then(result => { if (root.isConnected) openExploreSqlInEditor(result.sql, 'Explore category ranking'); })
            .catch(reason => { error.textContent = reason instanceof Error ? reason.message : String(reason); });
    }));
    controls.addEventListener('change', mark);
    // Filter changes never execute database queries.
    root.addEventListener('exploreFiltersChanged', mark, { signal: viewEvents.signal });
    root.replaceChildren(controls, error, status, output);
    mark(); draw();
}
