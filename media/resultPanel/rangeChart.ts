// Range chart modal powered by Apache ECharts
import * as echarts from 'echarts/core';
import type { EChartsType } from 'echarts/core';
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
    GridComponent,
    TooltipComponent,
    LegendComponent,
    DataZoomComponent,
    TitleComponent,
    ToolboxComponent
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import {
    extractRangeChartData,
    rebuildRangeChartData,
    MIN_RANGE_CHART_CELLS,
    MAX_RANGE_CHART_ROWS,
    MAX_RANGE_CHART_COLUMNS
} from '../../src/core/rangeChart/rangeChartData';
import type {
    ExtractRangeChartInput,
    RangeChartColumnMeta,
    RangeChartDataset,
    RangeChartRowData,
} from '../../src/core/rangeChart/rangeChartData';
import { postHostMessage } from './protocol.js';
import { getActiveGridIndex, getGrid } from './state.js';
import { asHtml, getElementById } from './dom.js';
import { callPanelMethod } from './types.js';
import type { TanStackColumn, TanStackTable } from './types.js';

echarts.use([
    BarChart,
    LineChart,
    PieChart,
    ScatterChart,
    GridComponent,
    TooltipComponent,
    LegendComponent,
    DataZoomComponent,
    TitleComponent,
    ToolboxComponent,
    CanvasRenderer
]);

const vscode = { postMessage: postHostMessage };

interface ChartSpec {
    family: string;
    category: string;
    variant: string;
}

interface ChartTypeOption extends ChartSpec {
    id: string;
    label: string;
}

interface ChartConfig {
    title: string;
    legendPosition: string;
}

interface RangeChartSetup {
    categoryColumnId: string;
    seriesColumnIds: string[];
}

interface RangeChartActiveState {
    baseInput: ExtractRangeChartInput;
    dataset: RangeChartDataset;
    chartSpec: ChartSpec;
    setup: RangeChartSetup;
    config: ChartConfig;
}

interface AxisDragState {
    columnId: string;
    sourceZone: string;
}

interface RangeChartMenuItem {
    label: string;
    spec: ChartSpec;
}

interface RangeChartMenuGroup {
    label: string;
    items: RangeChartMenuItem[];
}

const CHART_TYPE_OPTIONS: ChartTypeOption[] = [
    { id: 'column-grouped', label: 'Grouped Column', family: 'column', category: 'column', variant: 'grouped' },
    { id: 'column-stacked', label: 'Stacked Column', family: 'column', category: 'column', variant: 'stacked' },
    { id: 'column-stacked100', label: '100% Stacked', family: 'column', category: 'column', variant: 'stacked100' },
    { id: 'bar-grouped', label: 'Grouped Bar', family: 'bar', category: 'bar', variant: 'grouped' },
    { id: 'bar-stacked', label: 'Stacked Bar', family: 'bar', category: 'bar', variant: 'stacked' },
    { id: 'line', label: 'Line', family: 'line', category: 'line', variant: 'default' },
    { id: 'area-stacked', label: 'Stacked Area', family: 'area', category: 'area', variant: 'stacked' },
    { id: 'pie', label: 'Pie', family: 'pie', category: 'pie', variant: 'default' },
    { id: 'scatter', label: 'Scatter', family: 'scatter', category: 'scatter', variant: 'default' }
];

let activeChart: EChartsType | null = null;
let activeState: RangeChartActiveState | null = null;
let resizeObserver: ResizeObserver | null = null;
let axisDragState: AxisDragState | null = null;

const ROW_LABELS_FIELD_ID = '__row_labels__';

const CHART_COLORS = [
    '#4e9af5', '#f5a623', '#7ed957', '#e06c75', '#c678dd', '#56b6c2',
    '#d19a66', '#98c379', '#61afef', '#e5c07b', '#be5046', '#abb2bf'
];

function parseHexColor(hex: string): [number, number, number] | null {
    if (hex.length === 3) {
        return [
            parseInt(hex[0] + hex[0], 16),
            parseInt(hex[1] + hex[1], 16),
            parseInt(hex[2] + hex[2], 16)
        ];
    }

    if (hex.length === 6) {
        return [
            parseInt(hex.slice(0, 2), 16),
            parseInt(hex.slice(2, 4), 16),
            parseInt(hex.slice(4, 6), 16)
        ];
    }

    return null;
}

function isDarkTheme(): boolean {
    const bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
    if (!bg || !bg.startsWith('#')) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    const rgb = parseHexColor(bg.replace('#', ''));
    if (!rgb) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    const [r, g, b] = rgb.map((channel) => channel / 255);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance < 0.179;
}

function getVisibleDataColumns(table: TanStackTable): TanStackColumn[] {
    return table.getVisibleLeafColumns().filter((col) => !col.columnDef?.isRowNumber);
}

function buildExtractInput(table: TanStackTable, selectedCells: Set<string>): ExtractRangeChartInput {
    const columns: RangeChartColumnMeta[] = getVisibleDataColumns(table).map((col) => ({
        id: col.id,
        header: String(col.columnDef.header ?? col.id),
        dataType: col.columnDef.dataType,
        inferredNumericKind: col.columnDef.inferredNumericKind
    }));

    const selectedCellArray = Array.from(selectedCells).map((cellId) => {
        const [row, col] = cellId.split('-').map(Number);
        return { row, col };
    });

    if (selectedCellArray.length === 0) {
        return { selectedCells: selectedCellArray, columns, rows: [] };
    }

    const minRow = Math.min(...selectedCellArray.map((cell) => cell.row));
    const maxRow = Math.max(...selectedCellArray.map((cell) => cell.row));
    const tableRows = table.getRowModel().rows;
    const rows: RangeChartRowData[] = [];

    for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex += 1) {
        const row = tableRows[rowIndex];
        if (!row) {
            continue;
        }

        const values: Record<string, unknown> = {};
        columns.forEach((column) => {
            values[column.id] = row.getValue(column.id);
        });
        rows[rowIndex] = { values };
    }

    return { selectedCells: selectedCellArray, columns, rows };
}

function normalizeChartSpec(chartSpec: ChartSpec | null | undefined): ChartTypeOption {
    if (chartSpec == null || typeof chartSpec !== 'object') {
        return CHART_TYPE_OPTIONS[0];
    }

    const match = CHART_TYPE_OPTIONS.find((option) =>
        option.family === chartSpec.family
        && option.variant === chartSpec.variant
        && option.category === chartSpec.category
    );
    return match || CHART_TYPE_OPTIONS[0];
}

function buildDataZoomOptions(spec: ChartSpec, legendPosition: string): Array<Record<string, unknown>> {
    if (spec.family === 'pie') {
        return [];
    }

    const sliderBottom = legendPosition === 'bottom' ? 28 : 8;
    if (spec.family === 'bar') {
        return [
            { type: 'inside', yAxisIndex: 0 },
            { type: 'slider', yAxisIndex: 0, width: 18, right: 8, top: 48, bottom: sliderBottom + 20 }
        ];
    }

    return [
        { type: 'inside', xAxisIndex: 0 },
        { type: 'slider', xAxisIndex: 0, height: 18, bottom: sliderBottom }
    ];
}

function buildEchartsOption(
    dataset: RangeChartDataset,
    chartSpec: ChartSpec,
    config: ChartConfig,
): Record<string, unknown> {
    const spec = normalizeChartSpec(chartSpec);
    const title = config.title || 'Range Chart';
    const legendPosition = config.legendPosition || 'bottom';
    const textColor = getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground').trim() || '#cccccc';

    const base = {
        backgroundColor: 'transparent',
        color: CHART_COLORS,
        title: {
            text: title,
            left: 'center',
            textStyle: { color: textColor, fontSize: 14 }
        },
        tooltip: {
            trigger: spec.family === 'pie' ? 'item' : 'axis',
            axisPointer: { type: spec.family === 'line' || spec.family === 'area' ? 'cross' : 'shadow' }
        },
        legend: legendPosition === 'none'
            ? { show: false }
            : {
                show: true,
                bottom: legendPosition === 'bottom' ? 0 : undefined,
                top: legendPosition === 'top' ? 0 : undefined,
                textStyle: { color: textColor }
            },
        grid: {
            left: 48,
            right: 24,
            top: 48,
            bottom: legendPosition === 'bottom' ? 56 : 32,
            containLabel: true
        },
        dataZoom: buildDataZoomOptions(spec, legendPosition)
    };

    if (spec.family === 'pie') {
        const firstSeries = dataset.series[0];
        if (!firstSeries) {
            return {
                ...base,
                title: {
                    ...base.title,
                    subtext: 'No numeric series available',
                    subtextStyle: { color: textColor, fontSize: 12 }
                },
                series: []
            };
        }

        return {
            ...base,
            series: [{
                type: 'pie',
                radius: ['30%', '65%'],
                data: dataset.categories.map((category, index) => ({
                    name: category,
                    value: firstSeries.values[index] ?? 0
                }))
            }]
        };
    }

    if (spec.family === 'scatter') {
        const xSeries = dataset.series[0];
        const ySeries = dataset.series[1] || dataset.series[0];
        return {
            ...base,
            xAxis: { type: 'value', name: xSeries?.name, axisLabel: { color: textColor } },
            yAxis: { type: 'value', name: ySeries?.name, axisLabel: { color: textColor } },
            series: [{
                type: 'scatter',
                name: `${xSeries?.name || 'X'} vs ${ySeries?.name || 'Y'}`,
                data: dataset.categories.map((_category, index) => [
                    xSeries?.values[index] ?? 0,
                    ySeries?.values[index] ?? 0
                ])
            }]
        };
    }

    const isBar = spec.family === 'bar';
    const isArea = spec.family === 'area';
    const isStacked = spec.variant === 'stacked' || spec.variant === 'stacked100';
    const isPercent = spec.variant === 'stacked100';

    const categoryAxis = {
        type: 'category',
        data: dataset.categories,
        axisLabel: { color: textColor, rotate: dataset.categories.length > 8 ? 30 : 0 }
    };
    const valueAxis = {
        type: 'value',
        axisLabel: { color: textColor },
        max: isPercent ? 100 : undefined
    };

    const series = dataset.series.map((item) => ({
        name: item.name,
        type: isArea ? 'line' : 'bar',
        stack: isStacked ? 'total' : undefined,
        areaStyle: isArea ? {} : undefined,
        emphasis: { focus: 'series' },
        data: isPercent
            ? item.values.map((value, index) => {
                const total = dataset.series.reduce((sum, current) => sum + (current.values[index] ?? 0), 0);
                return total > 0 ? (value / total) * 100 : 0;
            })
            : item.values
    }));

    return {
        ...base,
        xAxis: isBar ? valueAxis : categoryAxis,
        yAxis: isBar ? categoryAxis : valueAxis,
        series
    };
}

function ensureOverlay(): HTMLElement {
    let overlay = getElementById('rangeChartOverlay');
    if (overlay && overlay.querySelector('.range-chart-modal')) {
        return overlay;
    }

    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'rangeChartOverlay';
        overlay.className = 'range-chart-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
        <div class="range-chart-modal">
            <div class="range-chart-header">
                <div class="range-chart-title">Range Chart</div>
                <div class="range-chart-header-actions">
                    <button type="button" data-action="maximize" title="Maximize">⛶</button>
                    <button type="button" data-action="close" title="Close">✕</button>
                </div>
            </div>
            <div class="range-chart-body">
                <div class="range-chart-canvas-wrap">
                    <div class="range-chart-toolbar">
                        <button type="button" data-action="copy-image">Copy as Image</button>
                        <button type="button" data-action="download">Download PNG</button>
                        <button type="button" data-action="reset-zoom">Reset Zoom</button>
                    </div>
                    <div id="rangeChartCanvas" class="range-chart-canvas"></div>
                </div>
                <aside class="range-chart-sidebar">
                    <div class="range-chart-tabs">
                        <button type="button" class="range-chart-tab active" data-tab="chart">Chart</button>
                        <button type="button" class="range-chart-tab" data-tab="setup">Set Up</button>
                        <button type="button" class="range-chart-tab" data-tab="customize">Customize</button>
                    </div>
                    <div class="range-chart-tab-panel active" data-panel="chart">
                        <div class="range-chart-type-grid" id="rangeChartTypeGrid"></div>
                    </div>
                    <div class="range-chart-tab-panel" data-panel="setup">
                        <div class="range-chart-axis-setup">
                            <div class="range-chart-field">
                                <label>Available fields</label>
                                <div id="rangeChartFieldsPool" class="range-chart-axis-dropzone range-chart-fields-pool" data-axis-zone="pool"></div>
                                <div class="range-chart-axis-hint">Drag fields to the axes below</div>
                            </div>
                            <div class="range-chart-field">
                                <label>Category (X axis)</label>
                                <div id="rangeChartCategoryZone" class="range-chart-axis-dropzone" data-axis-zone="category"></div>
                            </div>
                            <div class="range-chart-field">
                                <label>Series (Y axis)</label>
                                <div id="rangeChartSeriesZone" class="range-chart-axis-dropzone range-chart-axis-dropzone-series" data-axis-zone="series"></div>
                            </div>
                            <button type="button" class="range-chart-swap-axes-btn" id="rangeChartSwapAxesBtn">Swap X ↔ Y</button>
                        </div>
                    </div>
                    <div class="range-chart-tab-panel" data-panel="customize">
                        <div class="range-chart-field">
                            <label for="rangeChartTitleInput">Chart title</label>
                            <input id="rangeChartTitleInput" type="text" value="Range Chart" />
                        </div>
                        <div class="range-chart-field">
                            <label for="rangeChartLegendSelect">Legend</label>
                            <select id="rangeChartLegendSelect">
                                <option value="bottom">Bottom</option>
                                <option value="top">Top</option>
                                <option value="none">Hidden</option>
                            </select>
                        </div>
                    </div>
                    <div class="range-chart-warning" id="rangeChartWarnings"></div>
                </aside>
            </div>
        </div>
    `;

    if (!overlay.dataset.wired) {
        overlay.dataset.wired = '1';
        wireOverlayEvents(overlay);
    }

    return overlay;
}

function wireOverlayEvents(overlay: HTMLElement): void {
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeRangeChartModal();
        }
    });

    overlay.querySelector('[data-action="close"]')?.addEventListener('click', closeRangeChartModal);
    overlay.querySelector('[data-action="maximize"]')?.addEventListener('click', () => {
        overlay.classList.toggle('maximized');
        resizeActiveChart();
    });
    overlay.querySelector('[data-action="copy-image"]')?.addEventListener('click', () => {
        copyRangeChartToClipboard();
    });
    overlay.querySelector('[data-action="download"]')?.addEventListener('click', downloadRangeChart);
    overlay.querySelector('[data-action="reset-zoom"]')?.addEventListener('click', () => {
        if (!activeChart || !activeState) {
            return;
        }
        renderActiveChart();
    });

    overlay.querySelectorAll('.range-chart-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            const tabName = (tab as HTMLElement).dataset.tab;
            overlay.querySelectorAll('.range-chart-tab').forEach((item) => {
                item.classList.toggle('active', (item as HTMLElement).dataset.tab === tabName);
            });
            overlay.querySelectorAll('.range-chart-tab-panel').forEach((panel) => {
                panel.classList.toggle('active', (panel as HTMLElement).dataset.panel === tabName);
            });
        });
    });

    const titleInput = overlay.querySelector('#rangeChartTitleInput') as HTMLInputElement | null;
    const legendSelect = overlay.querySelector('#rangeChartLegendSelect') as HTMLSelectElement | null;
    if (!titleInput || !legendSelect) {
        return;
    }
    titleInput.addEventListener('input', () => {
        if (!activeState) {
            return;
        }
        activeState.config.title = titleInput.value;
        renderActiveChart();
    });
    legendSelect.addEventListener('change', () => {
        if (!activeState) {
            return;
        }
        activeState.config.legendPosition = legendSelect.value;
        renderActiveChart();
    });
}

function renderChartTypeGrid(): void {
    const grid = getElementById('rangeChartTypeGrid');
    if (!grid || !activeState) {
        return;
    }

    const chartState = activeState;
    grid.innerHTML = '';
    CHART_TYPE_OPTIONS.forEach((option) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'range-chart-type-btn';
        button.dataset.chartId = option.id;
        button.textContent = option.label;
        if (
            chartState.chartSpec.family === option.family
            && chartState.chartSpec.variant === option.variant
            && chartState.chartSpec.category === option.category
        ) {
            button.classList.add('active');
        }
        button.addEventListener('click', () => {
            if (!activeState) {
                return;
            }
            activeState.chartSpec = {
                family: option.family,
                category: option.category,
                variant: option.variant
            };
            renderChartTypeGrid();
            renderActiveChart();
        });
        grid.appendChild(button);
    });
}

function getAllSetupFields(): Array<{ id: string; name: string }> {
    if (!activeState) {
        return [];
    }

    const fieldMap = new Map();
    activeState.dataset.availableCategoryColumns.forEach((column) => {
        fieldMap.set(column.id, column);
    });
    activeState.dataset.availableSeriesColumns.forEach((column) => {
        fieldMap.set(column.id, column);
    });
    return Array.from(fieldMap.values());
}

function getFieldLabel(columnId: string): string {
    if (columnId === ROW_LABELS_FIELD_ID) {
        return 'Row labels';
    }

    const field = getAllSetupFields().find((column) => column.id === columnId);
    return field?.name || columnId;
}

function getPoolFieldIds(): string[] {
    if (!activeState) {
        return [];
    }
    const assigned = new Set(activeState.setup.seriesColumnIds);
    const categoryId = activeState.setup.categoryColumnId;
    if (categoryId && categoryId !== '') {
        assigned.add(categoryId);
    }

    return getAllSetupFields()
        .map((column) => column.id)
        .filter((columnId) => !assigned.has(columnId));
}

function createFieldChip(columnId: string, axisZone: string): HTMLDivElement {
    const chip = document.createElement('div');
    chip.className = 'range-chart-field-chip';
    if (columnId === ROW_LABELS_FIELD_ID) {
        chip.classList.add('range-chart-field-chip--synthetic');
    }
    chip.textContent = getFieldLabel(columnId);
    chip.draggable = true;
    chip.dataset.columnId = columnId;
    chip.dataset.axisZone = axisZone;

    chip.addEventListener('dragstart', (event) => {
        axisDragState = {
            columnId,
            sourceZone: axisZone
        };
        chip.classList.add('dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', columnId);
        }
    });

    chip.addEventListener('dragend', () => {
        chip.classList.remove('dragging');
        axisDragState = null;
        document.querySelectorAll('.range-chart-axis-dropzone.drag-over').forEach((zone) => {
            zone.classList.remove('drag-over');
        });
    });

    return chip;
}

function wireAxisDropZone(zone: HTMLElement, zoneName: string): void {
    zone.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
        zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave', (event) => {
        if (event.relatedTarget instanceof Node && !zone.contains(event.relatedTarget)) {
            zone.classList.remove('drag-over');
        }
    });

    zone.addEventListener('drop', (event) => {
        event.preventDefault();
        zone.classList.remove('drag-over');
        if (!activeState || !axisDragState) {
            return;
        }

        const columnId = axisDragState.columnId;
        const sourceZone = axisDragState.sourceZone;
        const insertBeforeChip = asHtml(asHtml(event.target)?.closest('.range-chart-field-chip'));

        if (zoneName === 'category') {
            assignCategoryField(columnId, sourceZone);
        } else if (zoneName === 'series') {
            const insertIndex = insertBeforeChip && zone.contains(insertBeforeChip)
                ? Array.from(zone.querySelectorAll('.range-chart-field-chip')).indexOf(insertBeforeChip)
                : -1;
            assignSeriesField(columnId, sourceZone, insertIndex);
        } else if (zoneName === 'pool') {
            unassignField(columnId, sourceZone);
        }

        refreshDatasetFromSetup();
    });
}

function assignCategoryField(columnId: string, sourceZone: string): void {
    if (!activeState) {
        return;
    }
    if (columnId === ROW_LABELS_FIELD_ID) {
        activeState.setup.categoryColumnId = '';
        return;
    }

    const previousCategory = activeState.setup.categoryColumnId;
    activeState.setup.categoryColumnId = columnId;

    activeState.setup.seriesColumnIds = activeState.setup.seriesColumnIds.filter((id) => id !== columnId);

    if (sourceZone === 'category' && previousCategory && previousCategory !== '' && previousCategory !== columnId) {
        if (!activeState.setup.seriesColumnIds.includes(previousCategory)) {
            activeState.setup.seriesColumnIds.unshift(previousCategory);
        }
    }
}

function assignSeriesField(columnId: string, sourceZone: string, insertIndex: number): void {
    if (!activeState) {
        return;
    }
    if (columnId === ROW_LABELS_FIELD_ID) {
        return;
    }

    let seriesIds = activeState.setup.seriesColumnIds.filter((id) => id !== columnId);

    if (sourceZone === 'category' && activeState.setup.categoryColumnId === columnId) {
        activeState.setup.categoryColumnId = '';
    } else if (activeState.setup.categoryColumnId === columnId) {
        activeState.setup.categoryColumnId = '';
    }

    if (insertIndex >= 0 && insertIndex <= seriesIds.length) {
        seriesIds.splice(insertIndex, 0, columnId);
    } else {
        seriesIds.push(columnId);
    }

    activeState.setup.seriesColumnIds = seriesIds;
}

function unassignField(columnId: string, sourceZone: string): void {
    if (!activeState) {
        return;
    }
    if (sourceZone === 'category') {
        activeState.setup.categoryColumnId = '';
        return;
    }

    if (sourceZone === 'series') {
        activeState.setup.seriesColumnIds = activeState.setup.seriesColumnIds.filter((id) => id !== columnId);
    }
}

function swapChartAxes(): void {
    if (!activeState) {
        return;
    }

    const categoryId = activeState.setup.categoryColumnId;
    const seriesIds = [...activeState.setup.seriesColumnIds];
    if (seriesIds.length === 0) {
        return;
    }

    const firstSeriesId = seriesIds[0];
    const numericSeries = new Set(activeState.dataset.availableSeriesColumns.map((column) => column.id));
    const textCategory = new Set(activeState.dataset.availableCategoryColumns.map((column) => column.id));

    if (categoryId && categoryId !== '' && numericSeries.has(categoryId)) {
        seriesIds[0] = categoryId;
        activeState.setup.categoryColumnId = textCategory.has(firstSeriesId) ? firstSeriesId : '';
        activeState.setup.seriesColumnIds = seriesIds;
    } else if (textCategory.has(firstSeriesId)) {
        activeState.setup.categoryColumnId = firstSeriesId;
        activeState.setup.seriesColumnIds = categoryId && categoryId !== '' && numericSeries.has(categoryId)
            ? [categoryId, ...seriesIds.slice(1)]
            : seriesIds.slice(1);
    } else if (seriesIds.length >= 2) {
        activeState.setup.seriesColumnIds = [seriesIds[1], seriesIds[0], ...seriesIds.slice(2)];
    }

    refreshDatasetFromSetup();
}

function renderSetupPanel(): void {
    if (!activeState) {
        return;
    }

    const pool = getElementById('rangeChartFieldsPool');
    const categoryZone = getElementById('rangeChartCategoryZone');
    const seriesZone = getElementById('rangeChartSeriesZone');
    const swapBtn = getElementById('rangeChartSwapAxesBtn');
    const warnings = getElementById('rangeChartWarnings');
    if (!pool || !categoryZone || !seriesZone || !warnings) {
        return;
    }

    pool.innerHTML = '';
    categoryZone.innerHTML = '';
    seriesZone.innerHTML = '';

    getPoolFieldIds().forEach((columnId) => {
        pool.appendChild(createFieldChip(columnId, 'pool'));
    });

    const categoryId = activeState.setup.categoryColumnId;
    if (!categoryId || categoryId === '') {
        categoryZone.appendChild(createFieldChip(ROW_LABELS_FIELD_ID, 'category'));
    } else {
        categoryZone.appendChild(createFieldChip(categoryId, 'category'));
    }

    activeState.setup.seriesColumnIds.forEach((columnId) => {
        seriesZone.appendChild(createFieldChip(columnId, 'series'));
    });

    if (!pool.dataset.wired) {
        pool.dataset.wired = '1';
        wireAxisDropZone(pool, 'pool');
        wireAxisDropZone(categoryZone, 'category');
        wireAxisDropZone(seriesZone, 'series');
        if (swapBtn) {
            swapBtn.addEventListener('click', swapChartAxes);
        }
    }

    warnings.textContent = activeState.dataset.warnings.join(' ');
}

function refreshDatasetFromSetup(): void {
    if (!activeState) {
        return;
    }

    if (activeState.setup.seriesColumnIds.length === 0) {
        renderSetupPanel();
        return;
    }

    activeState.dataset = rebuildRangeChartData(activeState.baseInput, {
        categoryColumnId: activeState.setup.categoryColumnId,
        seriesColumnIds: activeState.setup.seriesColumnIds
    });
    renderActiveChart();
    renderSetupPanel();
}

function renderActiveChart(): void {
    if (!activeState) {
        return;
    }

    const canvas = getElementById('rangeChartCanvas');
    if (!canvas) {
        return;
    }

    if (activeChart) {
        activeChart.dispose();
    }

    activeChart = echarts.init(canvas, isDarkTheme() ? 'dark' : undefined, { renderer: 'canvas' });
    activeChart.setOption(buildEchartsOption(activeState.dataset, activeState.chartSpec, activeState.config), true);

    if (!resizeObserver) {
        resizeObserver = new ResizeObserver(() => resizeActiveChart());
    }
    resizeObserver.disconnect();
    resizeObserver.observe(canvas);
}

function resizeActiveChart(): void {
    if (activeChart) {
        activeChart.resize();
    }
}

function getRangeChartImageDataUrl(): string | null {
    if (!activeChart) {
        return null;
    }

    return activeChart.getDataURL({
        type: 'png',
        pixelRatio: 2,
        backgroundColor: getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e'
    });
}

function dataUrlToPngBlob(dataUrl: string): Blob {
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex < 0) {
        throw new Error('Invalid chart image data');
    }

    const base64 = dataUrl.slice(commaIndex + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }

    return new Blob([bytes], { type: 'image/png' });
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error('Failed to create image'));
            }
        }, 'image/png');
    });
}

async function getRangeChartPngBlob(): Promise<Blob | null> {
    if (!activeChart) {
        return null;
    }

    const chartCanvas = activeChart.getDom()?.querySelector('canvas');
    if (chartCanvas) {
        return canvasToPngBlob(chartCanvas);
    }

    const dataUrl = getRangeChartImageDataUrl();
    return dataUrl ? dataUrlToPngBlob(dataUrl) : null;
}

async function copyRangeChartToClipboard(): Promise<void> {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        vscode.postMessage({
            command: 'info',
            text: 'Image clipboard is not supported in this environment. Use Download PNG instead.'
        });
        return;
    }

    try {
        const blob = await getRangeChartPngBlob();
        if (!blob) {
            throw new Error('No chart image available');
        }

        await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
        ]);
        vscode.postMessage({
            command: 'info',
            text: 'Chart copied as image — you can paste it into email or documents.'
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.postMessage({
            command: 'info',
            text: `Failed to copy chart image: ${message}`
        });
    }
}

function downloadRangeChart(): void {
    const dataUrl = getRangeChartImageDataUrl();
    if (!dataUrl) {
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    vscode.postMessage({
        command: 'saveChartImage',
        dataUrl,
        fileName: `range-chart-${timestamp}.png`
    });
}

export function closeRangeChartModal(): void {
    const overlay = getElementById('rangeChartOverlay');
    if (overlay) {
        overlay.classList.remove('visible', 'maximized');
        overlay.setAttribute('aria-hidden', 'true');
    }

    if (resizeObserver) {
        resizeObserver.disconnect();
    }

    if (activeChart) {
        activeChart.dispose();
        activeChart = null;
    }

    activeState = null;

    const modeSelect = getElementById<HTMLSelectElement>('viewModeSelect');
    const viewMode = modeSelect?.value || 'table';
    callPanelMethod('syncLayoutSwitcher', viewMode === 'chart' || viewMode === 'diff' ? viewMode : 'table');
}

export function buildDefaultRangeChartSelection(table: TanStackTable): Set<string> | null {
    const columns = getVisibleDataColumns(table);
    const rowCount = table.getRowModel().rows.length;
    if (columns.length === 0 || rowCount === 0) {
        return null;
    }

    const maxCol = Math.min(columns.length - 1, MAX_RANGE_CHART_COLUMNS - 1);
    const maxRow = Math.min(rowCount - 1, MAX_RANGE_CHART_ROWS - 1);
    if (maxCol < 1 || maxRow < 1) {
        return null;
    }

    const selectedCells = new Set<string>();
    for (let row = 0; row <= maxRow; row += 1) {
        for (let col = 0; col <= maxCol; col += 1) {
            selectedCells.add(`${row}-${col}`);
        }
    }

    return selectedCells;
}

export function openRangeChartModal(
    table: TanStackTable,
    selectedCells: Set<string>,
    chartSpec?: ChartSpec,
): void {
    if (!selectedCells || selectedCells.size < MIN_RANGE_CHART_CELLS) {
        vscode.postMessage({ command: 'info', text: 'Select at least a 2x2 range to create a chart.' });
        return;
    }

    const baseInput = buildExtractInput(table, selectedCells);
    const dataset = extractRangeChartData(baseInput);
    if (dataset.error) {
        vscode.postMessage({ command: 'info', text: dataset.error });
        return;
    }

    const normalizedSpec = normalizeChartSpec(chartSpec);
    activeState = {
        baseInput,
        dataset,
        chartSpec: {
            family: normalizedSpec.family,
            category: normalizedSpec.category,
            variant: normalizedSpec.variant
        },
        setup: {
            categoryColumnId: dataset.categoryColumnId ?? '',
            seriesColumnIds: dataset.series.map((series) => series.columnId)
        },
        config: {
            title: 'Range Chart',
            legendPosition: 'bottom'
        }
    };

    const overlay = ensureOverlay();
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');

    const titleInput = overlay.querySelector('#rangeChartTitleInput') as HTMLInputElement | null;
    const legendSelect = overlay.querySelector('#rangeChartLegendSelect') as HTMLSelectElement | null;
    if (titleInput) {
        titleInput.value = activeState.config.title;
    }
    if (legendSelect) {
        legendSelect.value = activeState.config.legendPosition;
    }

    renderChartTypeGrid();
    renderSetupPanel();
    renderActiveChart();
}

export const RANGE_CHART_MENU: RangeChartMenuGroup[] = [
    {
        label: 'Column',
        items: [
            { label: 'Grouped', spec: { family: 'column', category: 'column', variant: 'grouped' } },
            { label: 'Stacked', spec: { family: 'column', category: 'column', variant: 'stacked' } },
            { label: '100% Stacked', spec: { family: 'column', category: 'column', variant: 'stacked100' } }
        ]
    },
    {
        label: 'Bar',
        items: [
            { label: 'Grouped', spec: { family: 'bar', category: 'bar', variant: 'grouped' } },
            { label: 'Stacked', spec: { family: 'bar', category: 'bar', variant: 'stacked' } }
        ]
    },
    { label: 'Line', items: [{ label: 'Line', spec: { family: 'line', category: 'line', variant: 'default' } }] },
    { label: 'Area', items: [{ label: 'Stacked', spec: { family: 'area', category: 'area', variant: 'stacked' } }] },
    { label: 'Pie', items: [{ label: 'Pie', spec: { family: 'pie', category: 'pie', variant: 'default' } }] },
    { label: 'Scatter', items: [{ label: 'Scatter', spec: { family: 'scatter', category: 'scatter', variant: 'default' } }] }
];

export function canCreateRangeChart(table: TanStackTable, selectedCells: Set<string>): boolean {
    if (!selectedCells || selectedCells.size < MIN_RANGE_CHART_CELLS) {
        return false;
    }

    const baseInput = buildExtractInput(table, selectedCells);
    const dataset = extractRangeChartData(baseInput);
    return !dataset.error && dataset.series.length > 0;
}

export function getSelectedCellsFromDom(): Set<string> {
    const selectedCells = new Set<string>();
    const activeWrapper = document.querySelector('.grid-wrapper.active');
    if (!activeWrapper) {
        return selectedCells;
    }

    activeWrapper.querySelectorAll('.selected-cell[data-cell-id]').forEach((cell) => {
        const cellId = cell.getAttribute('data-cell-id');
        if (cellId) {
            selectedCells.add(cellId);
        }
    });

    return selectedCells;
}

export function openRangeChartFromToolbar(chartSpec?: ChartSpec): boolean {
    const grid = getGrid(getActiveGridIndex());
    const table = grid?.tanTable;
    if (!table) {
        vscode.postMessage({ command: 'info', text: 'No active result grid.' });
        return false;
    }

    const selectedCells = getSelectedCellsFromDom();
    if (!canCreateRangeChart(table, selectedCells)) {
        vscode.postMessage({
            command: 'info',
            text: 'Select a data range (at least 2×2 cells with numeric values), then open Charts.'
        });
        return false;
    }

    openRangeChartModal(table, selectedCells, chartSpec);
    return true;
}

function resolveRangeChartSelection(table: TanStackTable): Set<string> | null {
    const domSelection = getSelectedCellsFromDom();
    if (canCreateRangeChart(table, domSelection)) {
        return domSelection;
    }

    return buildDefaultRangeChartSelection(table);
}

export function openRangeChartForActiveResult(chartSpec?: ChartSpec): boolean {
    const grid = getGrid(getActiveGridIndex());
    const table = grid?.tanTable;
    if (!table) {
        vscode.postMessage({ command: 'info', text: 'No active result grid.' });
        return false;
    }

    const selectedCells = resolveRangeChartSelection(table);
    if (!selectedCells || !canCreateRangeChart(table, selectedCells)) {
        vscode.postMessage({
            command: 'info',
            text: 'Select a 2×2+ numeric range, or use a result set with at least two rows and one numeric column.'
        });
        return false;
    }

    openRangeChartModal(table, selectedCells, chartSpec);
    const overlay = getElementById('rangeChartOverlay');
    if (overlay) {
        overlay.classList.add('maximized');
    }
    callPanelMethod('syncLayoutSwitcher', 'range-chart');
    return true;
}
