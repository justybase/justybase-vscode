import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { DataGridColumn } from './dataGridTypes';
import {
  formatDataGridCellValue,
  isDataGridNumericColumn,
  isDataGridTemporalColumn,
} from './resultGridFormatting';

export interface RowViewPanelProps {
  readonly columns: readonly DataGridColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly onClose: () => void;
  /** Shown instead of values when the selection cannot be compared. */
  readonly placeholder?: string;
  readonly title?: string;
  /** Host command that opens the current comparison in Excel. */
  readonly onExportXlsb?: () => void;
  /** Host notification (legacy info toast). */
  readonly onNotify?: (message: string) => void;
}

const ROW_VIEW_KEY_WIDTH_STORAGE = 'justybase.row-view.key-column-width.v1';
const ROW_VIEW_KEY_DEFAULT_PERCENT = 42;
const ROW_VIEW_KEY_MIN_PERCENT = 12;
const ROW_VIEW_KEY_MAX_PERCENT = 72;
const ROW_VIEW_KEY_MIN_WIDTH_PX = 110;
const ROW_VIEW_KEY_GAP_PX = 6;
/** Section horizontal padding plus the inter-column gap. */
const ROW_VIEW_KEY_COLUMN_CHROME_PX = 26;

function clampRowViewKeyWidth(percent: number, tableWidth: number): number {
  const minPercent = tableWidth > 0
    ? Math.min(ROW_VIEW_KEY_MAX_PERCENT, Math.max(ROW_VIEW_KEY_MIN_PERCENT, (ROW_VIEW_KEY_MIN_WIDTH_PX / tableWidth) * 100))
    : ROW_VIEW_KEY_MIN_PERCENT;
  if (!Number.isFinite(percent)) return ROW_VIEW_KEY_DEFAULT_PERCENT;
  return Math.min(ROW_VIEW_KEY_MAX_PERCENT, Math.max(minPercent, percent));
}

function readStoredRowViewKeyWidth(): number | undefined {
  try {
    const stored = window.localStorage?.getItem(ROW_VIEW_KEY_WIDTH_STORAGE);
    if (stored === null || stored === undefined) return undefined;
    const parsed = Number.parseFloat(stored);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function storeRowViewKeyWidth(percent: number): void {
  try {
    window.localStorage?.setItem(ROW_VIEW_KEY_WIDTH_STORAGE, String(Math.round(percent * 10) / 10));
  } catch {
    // Sandboxed webviews can deny storage access; the current width still applies.
  }
}

function binaryBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}

function stableValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) {
    return JSON.stringify(['date', Number.isNaN(value.getTime()) ? 'invalid' : value.getTime()]);
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return JSON.stringify(['number', 'NaN']);
    if (value === Number.POSITIVE_INFINITY) return JSON.stringify(['number', 'Infinity']);
    if (value === Number.NEGATIVE_INFINITY) return JSON.stringify(['number', '-Infinity']);
    if (Object.is(value, -0)) return JSON.stringify(['number', 0]);
    return JSON.stringify(['number', value]);
  }
  if (typeof value === 'bigint') return JSON.stringify(['bigint', value.toString()]);
  if (typeof value === 'string') return JSON.stringify(['string', value]);
  if (typeof value === 'boolean') return JSON.stringify(['boolean', value]);
  if (typeof value === 'symbol') return JSON.stringify(['symbol', String(value.description ?? '')]);
  if (typeof value === 'function') return JSON.stringify(['function', String(value)]);

  const bytes = binaryBytes(value);
  if (bytes) return JSON.stringify(['binary', Array.from(bytes)]);

  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
  if (seen.has(value)) return JSON.stringify(['object', '[circular]']);
  seen.add(value);

  let serialized: unknown;
  if (Array.isArray(value)) {
    serialized = ['array', value.map(item => stableValue(item, seen))];
  } else {
    const record = value as Record<string, unknown>;
    serialized = ['object', Object.keys(record).sort().map(key => [key, stableValue(record[key], seen)])];
  }
  seen.delete(value);
  return JSON.stringify(serialized);
}

/** Keeps SQL NULL, empty text, and typed values distinct when comparing rows. */
export function areRowViewValuesEqual(values: readonly unknown[]): boolean {
  if (values.length < 2) return true;
  const first = stableValue(values[0], new WeakSet<object>());
  return values.slice(1).every(value => stableValue(value, new WeakSet<object>()) === first);
}

function typeLabel(column: DataGridColumn): string {
  if (isDataGridNumericColumn(column)) return 'num';
  if (isDataGridTemporalColumn(column)) return 'dt';
  if (/bool/iu.test(column.type ?? '')) return 'bool';
  if (/char|text|clob|string/iu.test(column.type ?? '')) return 'txt';
  return 'oth';
}

function valueClassName(value: unknown, column: DataGridColumn): string {
  if (value === null || value === undefined) return 'null';
  if (/bool/iu.test(column.type ?? '')) return 'boolean';
  if (isDataGridNumericColumn(column)) return 'number';
  if (isDataGridTemporalColumn(column)) return 'date';
  return '';
}

function rowViewMarkdown(columns: readonly DataGridColumn[], rows: readonly (readonly unknown[])[]): string {
  const escape = (value: string): string => value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>');
  const lines = [
    `| ${columns.map(column => escape(column.name)).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${columns.map((_column, index) => {
      const value = row[index];
      return value === null || value === undefined ? 'NULL' : escape(String(value));
    }).join(' | ')} |`),
  ];
  return lines.join('\n');
}

function readCssColor(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value || fallback;
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

async function copyRowViewAsImage(
  columns: readonly DataGridColumn[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  const bodyStyle = getComputedStyle(document.body);
  const fontFamily = getComputedStyle(document.body).fontFamily || 'monospace';
  const background = readCssColor(bodyStyle, '--justybase-grid-bg', readCssColor(bodyStyle, '--vscode-editor-background', '#1e1e1e'));
  const foreground = readCssColor(bodyStyle, '--justybase-grid-text', readCssColor(bodyStyle, '--vscode-editor-foreground', '#cccccc'));
  const border = readCssColor(bodyStyle, '--justybase-grid-border', readCssColor(bodyStyle, '--vscode-panel-border', '#333333'));
  const muted = readCssColor(bodyStyle, '--justybase-grid-muted', readCssColor(bodyStyle, '--vscode-descriptionForeground', '#888888'));
  const blue = readCssColor(bodyStyle, '--vscode-charts-blue', '#519aba');
  const green = readCssColor(bodyStyle, '--vscode-charts-green', '#89d185');
  const purple = readCssColor(bodyStyle, '--vscode-charts-purple', '#d8b4fe');

  const pad = 12;
  const keyWidth = 170;
  const gap = 8;
  const width = 560;
  const lineHeight = 16;
  const sectionHeights = columns.map(() => Math.max(34, rows.length * lineHeight + 10));
  const height = pad * 2 + sectionHeights.reduce((sum, value) => sum + value, 0);

  const dpr = window.devicePixelRatio || 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * dpr);
  canvas.height = Math.ceil(height * dpr);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is not available');
  context.scale(dpr, dpr);
  context.textBaseline = 'middle';

  const valueColor = (value: unknown, column: DataGridColumn): string => {
    if (value === null || value === undefined) return muted;
    if (/bool/iu.test(column.type ?? '')) return value === false || value === 0 || value === 'false' ? muted : green;
    if (isDataGridNumericColumn(column)) return blue;
    if (isDataGridTemporalColumn(column)) return purple;
    return foreground;
  };
  const formatted = (value: unknown, column: DataGridColumn): string => value === null || value === undefined
    ? 'NULL'
    : formatDataGridCellValue(value, column.type, column);

  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  let y = pad;
  columns.forEach((column, columnIndex) => {
    const sectionHeight = sectionHeights[columnIndex]!;
    if (columnIndex % 2 === 1) {
      context.fillStyle = 'rgba(255,255,255,0.04)';
      context.fillRect(0, y, width, sectionHeight);
    }
    context.strokeStyle = border;
    context.lineWidth = 0.5;
    context.beginPath();
    context.moveTo(0, y + sectionHeight);
    context.lineTo(width, y + sectionHeight);
    context.stroke();

    context.fillStyle = foreground;
    context.font = `600 12px ${fontFamily}`;
    context.textAlign = 'left';
    context.fillText(column.name, pad, y + 16, keyWidth - 44);

    const badge = typeLabel(column);
    if (badge) {
      context.font = `9px ${fontFamily}`;
      const badgeWidth = 32;
      const badgeHeight = 15;
      const badgeX = pad + keyWidth - badgeWidth - 4;
      context.fillStyle = 'rgba(128,128,128,0.24)';
      roundRect(context, badgeX, y + 8, badgeWidth, badgeHeight, 3);
      context.fill();
      context.fillStyle = muted;
      context.textAlign = 'center';
      context.fillText(badge, badgeX + badgeWidth / 2, y + 16);
      context.textAlign = 'left';
    }

    const valueX = pad + keyWidth + gap;
    if (rows.length <= 1) {
      const value = rows[0]?.[columnIndex];
      context.fillStyle = valueColor(value, column);
      context.font = `${value === null || value === undefined ? 'italic ' : ''}12px ${fontFamily}`;
      context.fillText(formatted(value, column), valueX, y + sectionHeight / 2, width - valueX - pad);
    } else {
      const startY = y + (sectionHeight - rows.length * lineHeight) / 2 + lineHeight / 2;
      rows.forEach((row, rowIndex) => {
        const value = row[columnIndex];
        const lineY = startY + rowIndex * lineHeight;
        context.fillStyle = muted;
        context.font = `10px ${fontFamily}`;
        const label = `Row ${rowIndex + 1}:`;
        context.fillText(label, valueX, lineY);
        const labelWidth = context.measureText(label).width + 4;
        context.fillStyle = valueColor(value, column);
        context.font = `${value === null || value === undefined ? 'italic ' : ''}12px ${fontFamily}`;
        context.fillText(formatted(value, column), valueX + labelWidth, lineY, width - valueX - labelWidth - pad);
      });
    }
    y += sectionHeight;
  });

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Failed to create image');
  const item = new ClipboardItem({ 'image/png': blob });
  await navigator.clipboard.write([item]);
}

/**
 * Vertical row comparison: each result column becomes a section, and every
 * selected row contributes one value. Sections whose values differ are
 * highlighted so several records can be compared without horizontal scanning.
 */
export function RowViewPanel({
  columns,
  rows,
  onClose,
  placeholder,
  title = 'Row Details & Comparison',
  onExportXlsb,
  onNotify,
}: RowViewPanelProps): ReactNode {
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [keyWidth, setKeyWidth] = useState<number>(() => readStoredRowViewKeyWidth() ?? ROW_VIEW_KEY_DEFAULT_PERCENT);
  const keyWidthRef = useRef<number>(keyWidth);
  const [resizing, setResizing] = useState(false);
  const draggingRef = useRef(false);
  const canExport = !placeholder && columns.length > 0 && rows.length > 0;

  useEffect(() => {
    if (!exportOpen) return undefined;
    const close = (event: MouseEvent): void => {
      if (exportRef.current?.contains(event.target as Node)) return;
      setExportOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExportOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [exportOpen]);

  const applyKeyWidth = (percent: number): number => {
    const width = tableRef.current?.getBoundingClientRect().width ?? 0;
    const next = clampRowViewKeyWidth(percent, width);
    keyWidthRef.current = next;
    setKeyWidth(next);
    return next;
  };
  const commitKeyWidth = (percent: number): void => {
    storeRowViewKeyWidth(applyKeyWidth(percent));
  };

  const copyMarkdown = async (): Promise<void> => {
    if (!canExport) return;
    setExportOpen(false);
    try {
      await navigator.clipboard.writeText(rowViewMarkdown(columns, rows));
      onNotify?.('Row view copied as Markdown');
    } catch {
      onNotify?.('Failed to copy to clipboard');
    }
  };

  const copyImage = async (): Promise<void> => {
    if (!canExport) return;
    setExportOpen(false);
    try {
      await copyRowViewAsImage(columns, rows);
      onNotify?.('Row view copied as image');
    } catch (error) {
      onNotify?.(`Failed to copy image: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportXlsb = (): void => {
    if (!canExport || !onExportXlsb) return;
    setExportOpen(false);
    onExportXlsb();
  };

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setResizing(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in some test harnesses.
    }
    storeRowViewKeyWidth(keyWidthRef.current);
  };

  const fitKeyColumn = (): void => {
    const table = tableRef.current;
    if (!table) return;
    const width = table.getBoundingClientRect().width;
    if (width <= 0) return;
    let widest = 0;
    table.querySelectorAll<HTMLElement>('.row-view-key').forEach(key => {
      const name = key.querySelector<HTMLElement>('.row-view-key-name');
      const type = key.querySelector<HTMLElement>('.row-view-key-type');
      const nameWidth = name ? Math.max(name.scrollWidth, name.offsetWidth) : 0;
      const typeWidth = type ? type.offsetWidth : 0;
      widest = Math.max(widest, nameWidth + (typeWidth > 0 ? typeWidth + ROW_VIEW_KEY_GAP_PX : 0));
    });
    if (widest <= 0) return;
    commitKeyWidth(((widest + ROW_VIEW_KEY_COLUMN_CHROME_PX) / width) * 100);
  };

  return <aside className="ui-row-view-panel" aria-label="Row details and comparison">
    <div className="row-view-header">
      <span>{title}</span>
      <div className="row-view-header-actions">
        <div className="ui-row-view-export" ref={exportRef}>
          <button
            type="button"
            className="ui-row-view-export-btn"
            aria-label="Export row view"
            aria-haspopup="menu"
            aria-expanded={exportOpen}
            title="Export row view"
            disabled={!canExport}
            onClick={() => setExportOpen(open => !open)}
          >⬇</button>
          {exportOpen && canExport && <div className="ui-row-view-export-menu" role="menu" aria-label="Export row view">
            <button type="button" role="menuitem" onClick={() => void copyImage()}>Copy as Image</button>
            <button type="button" role="menuitem" disabled={!onExportXlsb} onClick={exportXlsb}>Download as XLSB</button>
            <button type="button" role="menuitem" onClick={() => void copyMarkdown()}>Copy as Markdown</button>
          </div>}
        </div>
        <button type="button" className="ui-row-view-close" aria-label="Close row view" title="Close row view" onClick={onClose}>×</button>
      </div>
    </div>
    <div className="row-view-content">
      {placeholder
        ? <div className="row-view-placeholder">{placeholder}</div>
        : <div
          className={`row-view-table${resizing ? ' row-view-resizing' : ''}`}
          ref={tableRef}
          style={{ '--rv-key-width': `${keyWidth}%` } as CSSProperties}
        >
          {columns.map((column, columnIndex) => {
            const values = rows.map(row => row[columnIndex]);
            const isDiff = !areRowViewValuesEqual(values);
            return <div className={`row-view-section${isDiff ? ' diff' : ''}`} key={`${column.name}:${columnIndex}`}>
              <div className="row-view-key" title={[column.name, column.type].filter(Boolean).join(' · ')}>
                <span className="row-view-key-name">{column.name}</span>
                <span className="row-view-key-type">{typeLabel(column)}</span>
              </div>
              <div className="row-view-vals">
                {values.map((value, rowIndex) => {
                  const className = valueClassName(value, column);
                  return <div className="row-view-val-group" key={rowIndex}>
                    {rows.length > 1 && <span className="row-view-val label">Row {rowIndex + 1}</span>}
                    <span className={`row-view-val${className ? ` ${className}` : ''}`}>
                      {value === null || value === undefined ? 'NULL' : formatDataGridCellValue(value, column.type, column)}
                    </span>
                  </div>;
                })}
              </div>
            </div>;
          })}
          <div
            className="row-view-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the column-name column"
            aria-valuemin={ROW_VIEW_KEY_MIN_PERCENT}
            aria-valuemax={ROW_VIEW_KEY_MAX_PERCENT}
            aria-valuenow={Math.round(keyWidth)}
            tabIndex={0}
            title="Drag to resize the column-name column. Double-click to fit the longest name."
            onPointerDown={event => {
              if (event.pointerType === 'mouse' && event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                // Pointer capture is unavailable in some test harnesses.
              }
              draggingRef.current = true;
              setResizing(true);
            }}
            onPointerMove={event => {
              if (!draggingRef.current) return;
              const rect = tableRef.current?.getBoundingClientRect();
              if (!rect || rect.width <= 0) return;
              applyKeyWidth(((event.clientX - rect.left) / rect.width) * 100);
            }}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onMouseDown={event => event.stopPropagation()}
            onDoubleClick={event => { event.preventDefault(); fitKeyColumn(); }}
            onKeyDown={event => {
              const step = event.shiftKey ? 8 : 2;
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                commitKeyWidth(keyWidthRef.current - step);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                commitKeyWidth(keyWidthRef.current + step);
              }
            }}
          />
        </div>}
    </div>
  </aside>;
}
