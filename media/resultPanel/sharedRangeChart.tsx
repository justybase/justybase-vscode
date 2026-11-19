import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as echarts from 'echarts/core';
import type { EChartsType } from 'echarts/core';
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
    DataZoomComponent,
    GridComponent,
    LegendComponent,
    TitleComponent,
    TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import {
    MAX_RANGE_CHART_COLUMNS,
    MAX_RANGE_CHART_ROWS,
    extractRangeChartData,
    rebuildRangeChartData,
} from '../../src/core/rangeChart/rangeChartData';
import type {
    ExtractRangeChartInput,
    RangeChartColumnMeta,
    RangeChartDataset,
} from '../../src/core/rangeChart/rangeChartData';
import { postHostMessage } from './protocol.js';

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
    CanvasRenderer,
]);

export interface SharedRangeChartColumn {
    readonly name: string;
    readonly type?: string;
}

export interface SharedRangeChartProps {
    readonly columns: readonly SharedRangeChartColumn[];
    readonly rows: readonly (readonly unknown[])[];
}

type ChartFamily = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'scatter';
type ChartVariant = 'grouped' | 'stacked' | 'stacked100' | 'default';

interface ChartTypeOption {
    readonly id: string;
    readonly label: string;
    readonly family: ChartFamily;
    readonly variant: ChartVariant;
}

const CHART_TYPES: readonly ChartTypeOption[] = [
    { id: 'column-grouped', label: 'Grouped Column', family: 'column', variant: 'grouped' },
    { id: 'column-stacked', label: 'Stacked Column', family: 'column', variant: 'stacked' },
    { id: 'column-stacked100', label: '100% Stacked', family: 'column', variant: 'stacked100' },
    { id: 'bar-grouped', label: 'Grouped Bar', family: 'bar', variant: 'grouped' },
    { id: 'bar-stacked', label: 'Stacked Bar', family: 'bar', variant: 'stacked' },
    { id: 'line', label: 'Line', family: 'line', variant: 'default' },
    { id: 'area-stacked', label: 'Stacked Area', family: 'area', variant: 'stacked' },
    { id: 'pie', label: 'Pie', family: 'pie', variant: 'default' },
    { id: 'scatter', label: 'Scatter', family: 'scatter', variant: 'default' },
];

const CHART_COLORS = [
    '#4e9af5', '#f5a623', '#7ed957', '#e06c75', '#c678dd', '#56b6c2',
    '#d19a66', '#98c379', '#61afef', '#e5c07b', '#be5046', '#abb2bf',
];

function textColor(): string {
    return getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground').trim() || '#cccccc';
}

function buildInput(columns: readonly SharedRangeChartColumn[], rows: readonly (readonly unknown[])[]): ExtractRangeChartInput {
    const selectedColumns = columns.slice(0, MAX_RANGE_CHART_COLUMNS);
    const meta: RangeChartColumnMeta[] = selectedColumns.map((column, index) => ({
        id: String(index),
        header: column.name,
        dataType: column.type,
    }));
    const rowCount = Math.min(rows.length, MAX_RANGE_CHART_ROWS);
    const chartRows = Array.from({ length: rowCount }, (_value, rowIndex) => ({
        values: Object.fromEntries(selectedColumns.map((_column, columnIndex) => [String(columnIndex), rows[rowIndex]?.[columnIndex]])),
    }));
    const selectedCells = [];
    for (let row = 0; row < rowCount; row += 1) {
        for (let col = 0; col < selectedColumns.length; col += 1) {
            selectedCells.push({ row, col });
        }
    }
    return { selectedCells, columns: meta, rows: chartRows };
}

function buildOption(
    dataset: RangeChartDataset,
    type: ChartTypeOption,
    title: string,
    legend: 'bottom' | 'top' | 'none',
): Record<string, unknown> {
    const color = textColor();
    const base: Record<string, unknown> = {
        backgroundColor: 'transparent',
        color: CHART_COLORS,
        title: { text: title || 'Range Chart', left: 'center', textStyle: { color, fontSize: 14 } },
        tooltip: {
            trigger: type.family === 'pie' ? 'item' : 'axis',
            axisPointer: { type: type.family === 'line' || type.family === 'area' ? 'cross' : 'shadow' },
        },
        legend: legend === 'none'
            ? { show: false }
            : {
                show: true,
                bottom: legend === 'bottom' ? 0 : undefined,
                top: legend === 'top' ? 0 : undefined,
                textStyle: { color },
            },
        grid: {
            left: 48,
            right: 24,
            top: 48,
            bottom: legend === 'bottom' ? 56 : 32,
            containLabel: true,
        },
        dataZoom: type.family === 'pie'
            ? []
            : type.family === 'bar'
                ? [{ type: 'inside', yAxisIndex: 0 }, { type: 'slider', yAxisIndex: 0, width: 18, right: 8, top: 48, bottom: legend === 'bottom' ? 48 : 28 }]
                : [{ type: 'inside', xAxisIndex: 0 }, { type: 'slider', xAxisIndex: 0, height: 18, bottom: legend === 'bottom' ? 28 : 8 }],
    };

    if (type.family === 'pie') {
        const first = dataset.series[0];
        if (!first) return { ...base, series: [] };
        return {
            ...base,
            series: [{
                type: 'pie',
                radius: ['30%', '65%'],
                data: dataset.categories.map((category, index) => ({ name: category, value: first.values[index] ?? 0 })),
            }],
        };
    }

    if (type.family === 'scatter') {
        const xSeries = dataset.series[0];
        const ySeries = dataset.series[1] ?? dataset.series[0];
        return {
            ...base,
            xAxis: { type: 'value', name: xSeries?.name, axisLabel: { color } },
            yAxis: { type: 'value', name: ySeries?.name, axisLabel: { color } },
            series: [{
                type: 'scatter',
                name: `${xSeries?.name ?? 'X'} vs ${ySeries?.name ?? 'Y'}`,
                data: dataset.categories.map((_category, index) => [xSeries?.values[index] ?? 0, ySeries?.values[index] ?? 0]),
            }],
        };
    }

    const isBar = type.family === 'bar';
    const isArea = type.family === 'area';
    const stacked = type.variant === 'stacked' || type.variant === 'stacked100';
    const percent = type.variant === 'stacked100';
    const categoryAxis = {
        type: 'category',
        data: dataset.categories,
        axisLabel: { color, rotate: dataset.categories.length > 8 ? 30 : 0 },
    };
    const valueAxis = { type: 'value', axisLabel: { color }, max: percent ? 100 : undefined };
    const series = dataset.series.map(item => ({
        name: item.name,
        type: type.family === 'line' || isArea ? 'line' : 'bar',
        stack: stacked ? 'total' : undefined,
        areaStyle: isArea ? {} : undefined,
        emphasis: { focus: 'series' },
        data: percent
            ? item.values.map((value, index) => {
                const total = dataset.series.reduce((sum, current) => sum + (current.values[index] ?? 0), 0);
                return total > 0 ? (value / total) * 100 : 0;
            })
            : item.values,
    }));
    return {
        ...base,
        xAxis: isBar ? valueAxis : categoryAxis,
        yAxis: isBar ? categoryAxis : valueAxis,
        series,
    };
}

function isDarkTheme(): boolean {
    const background = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
    if (!background.startsWith('#') || (background.length !== 7 && background.length !== 4)) {
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
    }
    const hex = background.slice(1);
    const expand = (value: string): number => Number.parseInt(value.length === 1 ? value + value : value, 16);
    const r = expand(hex.slice(0, hex.length === 3 ? 1 : 2)) / 255;
    const g = expand(hex.slice(hex.length === 3 ? 1 : 2, hex.length === 3 ? 2 : 4)) / 255;
    const b = expand(hex.slice(hex.length === 3 ? 2 : 4, hex.length === 3 ? 3 : 6)) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.179;
}

/** Full range-chart surface: chart type, category/series fields, title, legend, image copy/download. */
export function SharedRangeChart({ columns, rows }: SharedRangeChartProps): ReactNode {
  const input = useMemo(() => buildInput(columns, rows), [columns, rows]);
  const baseDataset = useMemo(() => extractRangeChartData(input), [input]);
  const [chartTypeId, setChartTypeId] = useState(CHART_TYPES[0]!.id);
  const [categoryColumnId, setCategoryColumnId] = useState<string | undefined>();
  const [seriesColumnIds, setSeriesColumnIds] = useState<string[] | undefined>();
  const [title, setTitle] = useState('Range Chart');
  const [legend, setLegend] = useState<'bottom' | 'top' | 'none'>('bottom');
  const [maximized, setMaximized] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<EChartsType | undefined>(undefined);
  const type = CHART_TYPES.find(item => item.id === chartTypeId) ?? CHART_TYPES[0]!;
  const dataset = useMemo(
    () => rebuildRangeChartData(input, {
      categoryColumnId: categoryColumnId === undefined ? undefined : categoryColumnId,
      seriesColumnIds,
    }),
    [categoryColumnId, input, seriesColumnIds],
  );
  const option = useMemo(() => buildOption(dataset, type, title, legend), [dataset, legend, title, type]);
  const activeSeries = new Set(dataset.series.map(item => item.columnId));

  useEffect(() => {
    const element = chartRef.current;
    if (!element) return undefined;
    const chart = echarts.init(element, isDarkTheme() ? 'dark' : undefined, { renderer: 'canvas' });
    chartInstance.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartInstance.current = undefined;
    };
  }, []);

  useEffect(() => {
    chartInstance.current?.setOption(option, true);
  }, [option]);

  const toggleSeries = (columnId: string, checked: boolean): void => {
    const current = seriesColumnIds ?? dataset.series.map(item => item.columnId);
    setSeriesColumnIds(checked ? [...new Set([...current, columnId])] : current.filter(id => id !== columnId));
  };

  const copyImage = async (): Promise<void> => {
    const chart = chartInstance.current;
    if (!chart) return;
    try {
      const dataUrl = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: 'transparent' });
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      postHostMessage({ command: 'info', text: 'Chart copied as image' });
    } catch (error) {
      postHostMessage({ command: 'info', text: `Failed to copy chart image: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const downloadImage = (): void => {
    const chart = chartInstance.current;
    if (!chart) return;
    const dataUrl = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: 'transparent' });
    postHostMessage({ command: 'saveChartImage', dataUrl, fileName: `range-chart-${Date.now()}.png` });
  };

  const resetZoom = (): void => {
    chartInstance.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
  };
  const swapAxes = (): void => {
    const swaps: Record<string, string> = {
      'column-grouped': 'bar-grouped',
      'bar-grouped': 'column-grouped',
      'column-stacked': 'bar-stacked',
      'bar-stacked': 'column-stacked',
    };
    setChartTypeId(current => swaps[current] ?? current);
  };

  return <section className={`ui-range-chart${maximized ? ' ui-range-chart-maximized' : ''}`} aria-label="Charts">
    <header className="ui-range-chart-header">
      <div className="ui-range-chart-title">
        <h2>Charts</h2>
        <span>{dataset.error ?? `${dataset.categories.length.toLocaleString()} categories · ${dataset.series.length.toLocaleString()} series`}</span>
      </div>
      <div className="ui-range-chart-actions">
        <button type="button" onClick={swapAxes} disabled={Boolean(dataset.error)}>Swap X ↔ Y</button>
        <button type="button" onClick={resetZoom} disabled={Boolean(dataset.error)}>Reset Zoom</button>
        <button type="button" onClick={() => setMaximized(value => !value)}>{maximized ? 'Restore' : 'Maximize'}</button>
        <button type="button" onClick={() => void copyImage()} disabled={Boolean(dataset.error)}>Copy as Image</button>
        <button type="button" onClick={downloadImage} disabled={Boolean(dataset.error)}>Download PNG</button>
      </div>
    </header>
    <div className="ui-range-chart-body">
      <div className="ui-range-chart-canvas" ref={chartRef} />
      <aside className="ui-range-chart-sidebar">
        <label>Chart type
          <select aria-label="Chart type" value={chartTypeId} onChange={event => setChartTypeId(event.target.value)}>
            {CHART_TYPES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label>Category
          <select aria-label="Chart category" value={categoryColumnId ?? dataset.categoryColumnId ?? ''} onChange={event => setCategoryColumnId(event.target.value)}>
            <option value="">Row labels</option>
            {baseDataset.availableCategoryColumns.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <fieldset>
          <legend>Series</legend>
          {baseDataset.availableSeriesColumns.length === 0
            ? <span className="ui-range-chart-empty">No numeric columns.</span>
            : baseDataset.availableSeriesColumns.map(item => <label key={item.id} className="ui-range-chart-check">
              <input
                type="checkbox"
                checked={activeSeries.has(item.id)}
                onChange={event => toggleSeries(item.id, event.target.checked)}
              /> {item.name}
            </label>)}
        </fieldset>
        <label>Title
          <input aria-label="Chart title" value={title} onChange={event => setTitle(event.target.value)} />
        </label>
        <label>Legend
          <select aria-label="Chart legend" value={legend} onChange={event => setLegend(event.target.value as 'bottom' | 'top' | 'none')}>
            <option value="bottom">Bottom</option>
            <option value="top">Top</option>
            <option value="none">Hidden</option>
          </select>
        </label>
        {dataset.error && <div className="ui-range-chart-empty" role="status">{dataset.error}</div>}
        {dataset.warnings.map((warning, index) => <div className="ui-range-chart-warning" key={`${warning}:${index}`}>{warning}</div>)}
      </aside>
    </div>
  </section>;
}
