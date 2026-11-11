/**
 * Virtualized, keyboard-driven data grid for the Edit Data panel.
 *
 * Cells render as text (not permanent inputs). An inline editor opens on
 * double-click, Enter/F2 or typing, mirroring DataGrip/DBeaver: Enter commits
 * and moves down, Tab moves right, Escape cancels.
 */
import {
    Virtualizer,
    elementScroll,
    observeElementOffset,
    observeElementRect,
} from '@tanstack/virtual-core';
import {
    type EditorState,
    type GridColumn,
    type WorkingRow,
    cycleSort,
    duplicateRow,
    formatDisplayValue,
    insertRow,
    revertCell,
    revertRow,
    setCellValue,
    toggleDelete,
    typeBadge,
} from './state.js';
import { escapeHtml, formatCount } from './utils.js';
import { createMenuIcon, type MenuIconName } from '../shared/menuIcons.js';

export const ROW_HEIGHT = 22;
const MIN_COL_WIDTH = 56;
const MAX_AUTO_COL_WIDTH = 340;
const SAMPLE_ROWS = 200;

export interface GridCallbacks {
    /** Pending change set changed. */
    onChange(): void;
    /** Active cell or row selection changed. */
    onSelectionChange(): void;
    onFilterByValue(column: GridColumn, value: unknown): void;
    onOpenValueEditor(column: GridColumn, value: unknown): Promise<string | null | undefined>;
    copyText(text: string): void;
    /** Views and procedures are inspected, never edited. */
    readOnly?: boolean;
}

interface CellPosition {
    row: number;
    col: number;
}

interface MenuItem {
    label: string;
    icon?: MenuIconName;
    shortcut?: string;
    disabled?: boolean;
    danger?: boolean;
    action: () => void;
}

const BADGE_CLASS: Record<string, string> = { number: 'tn', text: 'tt', date: 'td', bool: 'tb2', other: 'to' };

export class DataGrid {
    private state: EditorState | null = null;
    private columns: GridColumn[] = [];
    private widths = new Map<string, number>();
    private virtualizer: Virtualizer<HTMLElement, Element> | null = null;
    private cleanupVirtualizer: (() => void) | null = null;
    private table: HTMLTableElement | null = null;
    private colgroup: HTMLTableColElement | null = null;
    private tbody: HTMLTableSectionElement | null = null;
    private active: CellPosition | null = null;
    private anchorRow: number | null = null;
    private selectedKeys = new Set<string>();
    private editor: { input: HTMLInputElement; key: string; column: string; original: string } | null = null;
    private reattaching = false;
    private measureCtx: CanvasRenderingContext2D | null = null;
    private emptyMessage = 'No rows. Use Add row (Alt+Insert) to insert one.';

    constructor(private readonly container: HTMLElement, private readonly callbacks: GridCallbacks) {
        container.addEventListener('mousedown', e => this.onMouseDown(e));
        container.addEventListener('contextmenu', e => this.onContextMenu(e));
        container.addEventListener('keydown', e => this.onKeyDown(e));
        document.addEventListener('mousedown', e => {
            const menu = document.getElementById('contextMenu');
            if (menu && !menu.hidden && !menu.contains(e.target as Node)) this.hideMenu();
        });
        window.addEventListener('blur', () => this.hideMenu());
    }

    setState(state: EditorState, emptyMessage?: string): void {
        this.commitEdit();
        this.state = state;
        this.columns = state.columns.filter(c => c.name.toUpperCase() !== 'ROWID');
        if (emptyMessage) this.emptyMessage = emptyMessage;
        this.selectedKeys.clear();
        this.active = state.order.length > 0 && this.columns.length > 0 ? { row: 0, col: 0 } : null;
        this.anchorRow = this.active ? 0 : null;
        if (this.active) this.selectedKeys.add(state.order[0]);
        this.autoSizeColumns();
        this.build();
    }

    // ---- Public commands -------------------------------------------------

    private get readOnly(): boolean {
        return this.callbacks.readOnly === true;
    }

    getActive(): { row: WorkingRow; column: GridColumn; index: number } | null {
        if (!this.state || !this.active) return null;
        const key = this.state.order[this.active.row];
        const row = key ? this.state.rows.get(key) : undefined;
        const column = this.columns[this.active.col];
        return row && column ? { row, column, index: this.active.row } : null;
    }

    getSelectedKeys(): string[] {
        if (!this.state) return [];
        return this.state.order.filter(k => this.selectedKeys.has(k));
    }

    rowCount(): number {
        return this.state?.order.length ?? 0;
    }

    focus(): void {
        if (!this.editor) this.container.focus({ preventScroll: true });
    }

    addRow(): void {
        if (!this.state || this.readOnly) return;
        this.commitEdit();
        const at = this.active ? this.active.row : -1;
        const key = insertRow(this.state, at);
        this.afterStructuralChange(key, 0);
        this.beginEdit();
    }

    duplicateSelected(): void {
        if (!this.state || this.readOnly) return;
        this.commitEdit();
        const keys = this.getSelectedKeys();
        let last: string | null = null;
        keys.forEach(k => { last = duplicateRow(this.state!, k) ?? last; });
        if (last) this.afterStructuralChange(last, this.active?.col ?? 0);
    }

    deleteSelected(): void {
        if (!this.state || this.readOnly) return;
        this.commitEdit();
        const keys = this.getSelectedKeys();
        if (keys.length === 0) return;
        const index = this.active?.row ?? 0;
        toggleDelete(this.state, keys);
        const nextKey = this.state.order[Math.min(index, this.state.order.length - 1)];
        this.afterStructuralChange(nextKey ?? null, this.active?.col ?? 0, keys.filter(k => this.state!.rows.has(k)));
    }

    revertSelected(): void {
        if (!this.state || this.readOnly) return;
        this.commitEdit();
        this.getSelectedKeys().forEach(k => revertRow(this.state!, k));
        const key = this.state.order[Math.min(this.active?.row ?? 0, this.state.order.length - 1)];
        this.afterStructuralChange(key ?? null, this.active?.col ?? 0);
    }

    setActiveNull(): void {
        const cell = this.getActive();
        if (!cell || !this.state || this.readOnly || cell.column.readonly) return;
        if (setCellValue(this.state, cell.row.key, cell.column.name, null)) this.changed();
    }

    commitEdit(): void {
        if (!this.editor || !this.state) return;
        const { input, key, column, original } = this.editor;
        this.editor = null;
        if (input.value !== original) {
            setCellValue(this.state, key, column, input.value);
            this.changed();
        } else {
            this.renderRows();
        }
    }

    cancelEdit(): void {
        if (!this.editor) return;
        this.editor = null;
        this.renderRows();
        this.focus();
    }

    // ---- Layout ----------------------------------------------------------

    private measure(text: string, bold = false): number {
        if (!this.measureCtx) {
            this.measureCtx = document.createElement('canvas').getContext('2d');
        }
        const ctx = this.measureCtx;
        if (!ctx) return text.length * 7.5;
        const style = getComputedStyle(this.container);
        const family = style.getPropertyValue('--grid-font').trim() || 'monospace';
        const size = style.getPropertyValue('--grid-font-size').trim() || '12px';
        ctx.font = `${bold ? 600 : 400} ${size} ${family}`;
        return ctx.measureText(text).width;
    }

    private autoSizeColumns(): void {
        if (!this.state) return;
        const sample = this.state.order.slice(0, SAMPLE_ROWS).map(k => this.state!.rows.get(k));
        this.columns.forEach(column => {
            if (this.widths.has(column.name)) return;
            const badge = typeBadge(column.type) ? 30 : 0;
            const keys = (column.isPk ? 22 : 0) + (column.isFk ? 22 : 0);
            let width = this.measure(column.name, true) + badge + keys + 34;
            sample.forEach(row => {
                if (!row) return;
                const text = formatDisplayValue(row.values[column.name]);
                width = Math.max(width, this.measure(text.length > 60 ? text.slice(0, 60) : text) + 24);
            });
            this.widths.set(column.name, Math.round(Math.max(MIN_COL_WIDTH, Math.min(MAX_AUTO_COL_WIDTH, width))));
        });
    }

    private gutterWidth(): number {
        const digits = String(Math.max(1, this.rowCount())).length;
        return Math.max(44, Math.round(this.measure('9'.repeat(digits)) + 26));
    }

    private totalWidth(): number {
        return this.gutterWidth() + this.columns.reduce((sum, c) => sum + (this.widths.get(c.name) ?? 120), 0);
    }

    private build(): void {
        this.cleanupVirtualizer?.();
        this.cleanupVirtualizer = null;
        this.container.innerHTML = '';
        if (!this.state) return;

        if (this.columns.length === 0) {
            this.container.innerHTML = '<div class="empty-state">No columns to display</div>';
            return;
        }

        const table = document.createElement('table');
        table.className = 'data-grid';
        table.setAttribute('role', 'grid');
        const colgroup = document.createElement('colgroup');
        const thead = document.createElement('thead');
        const tbody = document.createElement('tbody');
        table.append(colgroup, thead, tbody);
        this.table = table;
        this.colgroup = colgroup;
        this.tbody = tbody;
        this.renderColgroup();
        this.renderHeader(thead);
        this.container.appendChild(table);

        if (this.state.order.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'grid-empty';
            empty.textContent = this.emptyMessage;
            this.container.appendChild(empty);
        }

        const virtualizer = new Virtualizer<HTMLElement, Element>({
            count: this.state.order.length,
            getScrollElement: () => this.container,
            estimateSize: () => ROW_HEIGHT,
            overscan: 12,
            scrollToFn: elementScroll,
            observeElementRect,
            observeElementOffset,
            onChange: () => this.renderRows(),
        });
        this.virtualizer = virtualizer;
        this.cleanupVirtualizer = virtualizer._didMount();
        virtualizer._willUpdate();
        this.renderRows();
    }

    private renderColgroup(): void {
        if (!this.colgroup || !this.table) return;
        const cols = [`<col style="width:${this.gutterWidth()}px">`];
        this.columns.forEach(c => cols.push(`<col style="width:${this.widths.get(c.name) ?? 120}px">`));
        this.colgroup.innerHTML = cols.join('');
        this.table.style.width = `${this.totalWidth()}px`;
    }

    private renderHeader(thead: HTMLTableSectionElement): void {
        const sort = this.state?.sort;
        const cells = this.columns.map((column, index) => {
            const badge = typeBadge(column.type);
            const badgeHtml = badge ? `<span class="tb ${BADGE_CLASS[column.family]}">${escapeHtml(badge)}</span>` : '';
            const keys = `${column.isPk ? '<span class="key-mark pk" title="Primary key">PK</span>' : ''}${column.isFk ? '<span class="key-mark fk" title="Foreign key">FK</span>' : ''}`;
            const sortMark = sort && sort.column === column.name
                ? `<span class="sort-mark" aria-label="sorted ${sort.direction}">${sort.direction === 'asc' ? '▲' : '▼'}</span>`
                : '';
            const tooltip = [
                column.name,
                column.type && `Type: ${column.type}`,
                column.notNull ? 'NOT NULL' : 'Nullable',
                column.comment && `\n${column.comment}`,
                '\nClick to sort loaded rows',
            ].filter(Boolean).join('\n');
            return `<th data-col="${index}" class="${column.family === 'number' ? 'align-right' : ''}" title="${escapeHtml(tooltip)}">
                <div class="th-inner">${badgeHtml}<span class="th-name">${escapeHtml(column.name)}</span>${column.notNull ? '<span class="nn-dot" title="NOT NULL"></span>' : ''}${keys}${sortMark}</div>
                <span class="col-resizer" data-resize="${index}"></span>
            </th>`;
        }).join('');
        thead.innerHTML = `<tr><th class="gutter-head" title="Row number">#</th>${cells}</tr>`;
    }

    renderRows(): void {
        const tbody = this.tbody;
        const state = this.state;
        const virtualizer = this.virtualizer;
        if (!tbody || !state || !virtualizer) return;

        const editor = this.editor;
        if (editor) this.reattaching = true;

        const items = virtualizer.getVirtualItems();
        const fragment = document.createDocumentFragment();
        const colSpan = this.columns.length + 1;
        if (items.length > 0 && items[0].start > 0) {
            fragment.appendChild(spacer(items[0].start, colSpan));
        }

        let editorCell: HTMLTableCellElement | null = null;
        items.forEach(item => {
            const key = state.order[item.index];
            const row = key ? state.rows.get(key) : undefined;
            if (!row) return;
            const tr = document.createElement('tr');
            tr.dataset.key = key;
            tr.dataset.index = String(item.index);
            const classes: string[] = [];
            if (row.status === 'new') classes.push('row-new');
            else if (row.status === 'deleted') classes.push('row-deleted');
            else if (row.modified.size > 0) classes.push('row-modified');
            if (this.selectedKeys.has(key)) classes.push('row-selected');
            if (this.active?.row === item.index) classes.push('row-active');
            tr.className = classes.join(' ');

            const gutter = document.createElement('td');
            gutter.className = 'gutter';
            gutter.textContent = row.status === 'new' ? '+' : String(item.index + 1);
            gutter.title = row.rowId !== null ? `ROWID ${row.rowId}` : 'New row (not saved yet)';
            tr.appendChild(gutter);

            this.columns.forEach((column, colIndex) => {
                const td = document.createElement('td');
                const value = row.values[column.name];
                const cls = ['cell'];
                if (column.family === 'number') cls.push('align-right');
                if (row.modified.has(column.name)) cls.push('cell-modified');
                if (this.active && this.active.row === item.index && this.active.col === colIndex) cls.push('cell-active');
                td.dataset.col = String(colIndex);

                if (editor && editor.key === key && editor.column === column.name) {
                    cls.push('cell-editing');
                    editorCell = td;
                } else if (value === null || value === undefined) {
                    td.innerHTML = '<span class="val-null">NULL</span>';
                } else {
                    const text = formatDisplayValue(value);
                    td.innerHTML = renderValue(text, column, value);
                    if (text.length > 40) td.title = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
                }
                td.className = cls.join(' ');
                tr.appendChild(td);
            });
            fragment.appendChild(tr);
        });

        if (items.length > 0) {
            const rest = virtualizer.getTotalSize() - items[items.length - 1].end;
            if (rest > 0) fragment.appendChild(spacer(rest, colSpan));
        }

        tbody.replaceChildren(fragment);
        if (editor && editorCell) {
            (editorCell as HTMLTableCellElement).appendChild(editor.input);
            if (document.activeElement !== editor.input) editor.input.focus({ preventScroll: true });
        }
        this.reattaching = false;
    }

    // ---- Selection & navigation -----------------------------------------

    private cellFromEvent(event: Event): { row: number; col: number | null; key: string } | null {
        const target = event.target as HTMLElement | null;
        const td = target?.closest('td');
        const tr = td?.closest('tr');
        if (!td || !tr || !tr.dataset.key || tr.dataset.index === undefined) return null;
        const col = td.dataset.col !== undefined ? Number(td.dataset.col) : null;
        return { row: Number(tr.dataset.index), col, key: tr.dataset.key };
    }

    private setActive(row: number, col: number, options: { extend?: boolean; toggle?: boolean } = {}): void {
        if (!this.state) return;
        const rowCount = this.state.order.length;
        if (rowCount === 0) return;
        const r = Math.max(0, Math.min(rowCount - 1, row));
        const c = Math.max(0, Math.min(this.columns.length - 1, col));
        const key = this.state.order[r];

        if (options.extend && this.anchorRow !== null) {
            this.selectedKeys.clear();
            const [from, to] = this.anchorRow < r ? [this.anchorRow, r] : [r, this.anchorRow];
            for (let i = from; i <= to; i++) this.selectedKeys.add(this.state.order[i]);
        } else if (options.toggle) {
            if (this.selectedKeys.has(key)) this.selectedKeys.delete(key);
            else this.selectedKeys.add(key);
            this.anchorRow = r;
        } else {
            this.selectedKeys.clear();
            this.selectedKeys.add(key);
            this.anchorRow = r;
        }

        this.active = { row: r, col: c };
        this.scrollIntoView(r, c);
        this.refreshSelection();
        this.callbacks.onSelectionChange();
    }

    /** Updates selection classes in place so pointer targets stay stable. */
    private refreshSelection(): void {
        if (!this.tbody || !this.state) return;
        this.tbody.querySelectorAll<HTMLTableRowElement>('tr[data-key]').forEach(tr => {
            const index = Number(tr.dataset.index);
            const isActiveRow = this.active?.row === index;
            tr.classList.toggle('row-selected', this.selectedKeys.has(tr.dataset.key ?? ''));
            tr.classList.toggle('row-active', isActiveRow);
            tr.querySelectorAll<HTMLTableCellElement>('td[data-col]').forEach(td => {
                td.classList.toggle('cell-active', isActiveRow && Number(td.dataset.col) === this.active?.col);
            });
        });
    }

    private scrollIntoView(row: number, col: number): void {
        const virtualizer = this.virtualizer;
        if (!virtualizer) return;
        const headerHeight = this.table?.tHead?.offsetHeight ?? ROW_HEIGHT;
        const top = row * ROW_HEIGHT;
        const viewTop = this.container.scrollTop;
        const viewHeight = this.container.clientHeight - headerHeight;
        if (top < viewTop) this.container.scrollTop = top;
        else if (top + ROW_HEIGHT > viewTop + viewHeight) this.container.scrollTop = top + ROW_HEIGHT - viewHeight;

        const gutter = this.gutterWidth();
        let left = gutter;
        for (let i = 0; i < col; i++) left += this.widths.get(this.columns[i].name) ?? 120;
        const width = this.widths.get(this.columns[col]?.name) ?? 120;
        const viewLeft = this.container.scrollLeft;
        const viewWidth = this.container.clientWidth;
        if (left - gutter < viewLeft) this.container.scrollLeft = Math.max(0, left - gutter);
        else if (left + width > viewLeft + viewWidth) this.container.scrollLeft = left + width - viewWidth;
    }

    private onMouseDown(event: MouseEvent): void {
        const target = event.target as HTMLElement;
        const resize = target.closest<HTMLElement>('[data-resize]');
        if (resize) {
            event.preventDefault();
            this.startResize(Number(resize.dataset.resize), event);
            return;
        }
        const th = target.closest<HTMLElement>('th[data-col]');
        if (th && event.button === 0) {
            this.commitEdit();
            const column = this.columns[Number(th.dataset.col)];
            if (column && this.state) {
                cycleSort(this.state, column.name);
                this.rebuildKeepingActive();
            }
            return;
        }
        if (target.closest('input.cell-editor')) return;
        const cell = this.cellFromEvent(event);
        if (!cell) return;
        if (event.button === 2 && this.selectedKeys.has(cell.key)) {
            // Keep a multi-row selection for the context menu.
            this.active = { row: cell.row, col: cell.col ?? this.active?.col ?? 0 };
            this.refreshSelection();
            return;
        }
        this.commitEdit();
        event.preventDefault();
        this.container.focus({ preventScroll: true });
        const col = cell.col ?? this.active?.col ?? 0;
        // Double-click is detected on the second mousedown: selection updates
        // happen in place, but a commit above may have re-rendered the row.
        if (event.detail >= 2 && cell.col !== null && this.active?.row === cell.row && this.active.col === col) {
            this.beginEdit();
            return;
        }
        this.setActive(cell.row, col, { extend: event.shiftKey, toggle: event.ctrlKey || event.metaKey });
    }

    private rebuildKeepingActive(): void {
        const activeKey = this.active && this.state ? this.state.order[this.active.row] : null;
        const col = this.active?.col ?? 0;
        this.build();
        if (activeKey && this.state) {
            const index = this.state.order.indexOf(activeKey);
            if (index >= 0) this.active = { row: index, col };
        }
        this.renderRows();
        this.callbacks.onSelectionChange();
    }

    private afterStructuralChange(focusKey: string | null, col: number, keepSelected?: string[]): void {
        if (!this.state) return;
        this.build();
        this.selectedKeys = new Set(keepSelected ?? []);
        if (focusKey) {
            const index = this.state.order.indexOf(focusKey);
            if (index >= 0) {
                this.active = { row: index, col: Math.min(col, this.columns.length - 1) };
                if (!keepSelected) this.selectedKeys.add(focusKey);
                this.anchorRow = index;
                this.scrollIntoView(index, this.active.col);
            }
        } else {
            this.active = null;
        }
        this.renderRows();
        this.changed();
    }

    private changed(): void {
        this.renderRows();
        this.callbacks.onChange();
        this.callbacks.onSelectionChange();
    }

    private pageSize(): number {
        return Math.max(1, Math.floor((this.container.clientHeight - ROW_HEIGHT) / ROW_HEIGHT) - 1);
    }

    private onKeyDown(event: KeyboardEvent): void {
        if (!this.state) return;
        if (this.editor) {
            this.onEditorKey(event);
            return;
        }
        const active = this.active;
        const ctrl = event.ctrlKey || event.metaKey;
        const move = (row: number, col: number) => {
            event.preventDefault();
            this.setActive(row, col, { extend: event.shiftKey && row !== active?.row });
        };
        if (!active) {
            if (this.state.order.length > 0 && /^Arrow|^Page|^Home|^End/.test(event.key)) move(0, 0);
            return;
        }

        switch (event.key) {
            case 'ArrowDown': return move(ctrl ? this.state.order.length - 1 : active.row + 1, active.col);
            case 'ArrowUp': return move(ctrl ? 0 : active.row - 1, active.col);
            case 'ArrowRight': return move(active.row, ctrl ? this.columns.length - 1 : active.col + 1);
            case 'ArrowLeft': return move(active.row, ctrl ? 0 : active.col - 1);
            case 'PageDown': return move(active.row + this.pageSize(), active.col);
            case 'PageUp': return move(active.row - this.pageSize(), active.col);
            case 'Home': return move(ctrl ? 0 : active.row, 0);
            case 'End': return move(ctrl ? this.state.order.length - 1 : active.row, this.columns.length - 1);
            case 'Tab':
                event.preventDefault();
                this.setActive(active.row, active.col + (event.shiftKey ? -1 : 1));
                return;
            case 'Enter':
                event.preventDefault();
                if (event.shiftKey) void this.openValueEditor();
                else this.beginEdit();
                return;
            case 'F2':
                event.preventDefault();
                this.beginEdit();
                return;
            case 'Delete':
                event.preventDefault();
                this.deleteSelected();
                return;
            case 'Backspace':
                event.preventDefault();
                this.beginEdit('');
                return;
            case 'Escape':
                this.hideMenu();
                return;
        }

        if (ctrl && !event.altKey && (event.key === 'c' || event.key === 'C')) {
            event.preventDefault();
            this.copySelection();
            return;
        }
        if (ctrl && !event.altKey && (event.key === 'z' || event.key === 'Z')) {
            event.preventDefault();
            const cell = this.getActive();
            if (cell && revertCell(this.state, cell.row.key, cell.column.name)) this.changed();
            return;
        }
        if (ctrl && event.altKey && (event.key === 'n' || event.key === 'N')) {
            event.preventDefault();
            this.setActiveNull();
            return;
        }
        if (!ctrl && !event.altKey && event.key.length === 1) {
            event.preventDefault();
            this.beginEdit(event.key);
        }
    }

    private onEditorKey(event: KeyboardEvent): void {
        const active = this.active;
        switch (event.key) {
            case 'Enter':
                event.preventDefault();
                this.commitEdit();
                if (active) this.setActive(active.row + 1, active.col);
                this.focus();
                return;
            case 'Tab':
                event.preventDefault();
                this.commitEdit();
                if (active) this.setActive(active.row, active.col + (event.shiftKey ? -1 : 1));
                this.focus();
                return;
            case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                this.cancelEdit();
                return;
        }
    }

    beginEdit(initial?: string): void {
        const cell = this.getActive();
        if (!cell || !this.state) return;
        if (cell.column.readonly || cell.row.status === 'deleted') return;
        const value = cell.row.values[cell.column.name];
        const original = value === null || value === undefined ? '' : formatDisplayValue(value);
        const input = document.createElement('input');
        input.className = 'cell-editor';
        input.spellcheck = false;
        input.value = initial ?? original;
        input.placeholder = 'NULL';
        input.addEventListener('blur', () => {
            if (!this.reattaching && this.editor?.input === input) this.commitEdit();
        });
        this.editor = { input, key: cell.row.key, column: cell.column.name, original };
        this.renderRows();
        input.focus({ preventScroll: true });
        if (initial === undefined) input.select();
        else input.setSelectionRange(input.value.length, input.value.length);
    }

    async openValueEditor(): Promise<void> {
        const cell = this.getActive();
        if (!cell || !this.state) return;
        this.commitEdit();
        const value = cell.row.values[cell.column.name];
        const result = await this.callbacks.onOpenValueEditor(cell.column, value);
        if (result === undefined || cell.column.readonly) {
            this.focus();
            return;
        }
        if (setCellValue(this.state, cell.row.key, cell.column.name, result)) this.changed();
        this.focus();
    }

    private copySelection(): void {
        if (!this.state) return;
        const keys = this.getSelectedKeys();
        const cell = this.getActive();
        if (keys.length <= 1 && cell) {
            const value = cell.row.values[cell.column.name];
            this.callbacks.copyText(value === null || value === undefined ? '' : formatDisplayValue(value));
            return;
        }
        this.copyRows(keys);
    }

    private copyRows(keys: string[], withHeader = false): void {
        if (!this.state) return;
        const lines = keys.map(k => {
            const row = this.state!.rows.get(k);
            return this.columns.map(c => {
                const v = row?.values[c.name];
                return v === null || v === undefined ? '' : formatDisplayValue(v).replace(/[\t\n\r]/g, ' ');
            }).join('\t');
        });
        if (withHeader) lines.unshift(this.columns.map(c => c.name).join('\t'));
        this.callbacks.copyText(lines.join('\n'));
    }

    // ---- Column resize ---------------------------------------------------

    private startResize(colIndex: number, event: MouseEvent): void {
        const column = this.columns[colIndex];
        if (!column) return;
        const startX = event.clientX;
        const startWidth = this.widths.get(column.name) ?? 120;
        document.body.classList.add('resizing');
        const onMove = (e: MouseEvent) => {
            this.widths.set(column.name, Math.max(MIN_COL_WIDTH, Math.round(startWidth + e.clientX - startX)));
            this.renderColgroup();
        };
        const onUp = () => {
            document.body.classList.remove('resizing');
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    // ---- Context menu ----------------------------------------------------

    private onContextMenu(event: MouseEvent): void {
        const cell = this.cellFromEvent(event);
        if (!cell || !this.state) return;
        event.preventDefault();
        if (!this.selectedKeys.has(cell.key)) {
            this.setActive(cell.row, cell.col ?? 0);
        }
        const active = this.getActive();
        if (!active) return;
        const keys = this.getSelectedKeys();
        const many = keys.length > 1;
        const value = active.row.values[active.column.name];
        const editable = !active.column.readonly && active.row.status !== 'deleted';
        const allDeleted = keys.every(k => this.state!.rows.get(k)?.status === 'deleted');
        const anyPending = keys.some(k => {
            const r = this.state!.rows.get(k);
            return r && (r.status !== 'clean' || r.modified.size > 0);
        });

        const items: (MenuItem | 'separator')[] = [];
        if (!this.readOnly) {
            items.push(
                { label: 'Edit value', icon: 'pencil', shortcut: 'Enter', disabled: !editable, action: () => this.beginEdit() },
                { label: 'Open value editor…', icon: 'maximize', shortcut: 'Shift+Enter', disabled: !editable, action: () => void this.openValueEditor() },
                { label: 'Set NULL', icon: 'circle-slash', shortcut: 'Ctrl+Alt+N', disabled: !editable || value === null, action: () => this.setActiveNull() },
                { label: 'Revert value', icon: 'undo', shortcut: 'Ctrl+Z', disabled: !active.row.modified.has(active.column.name), action: () => {
                    if (revertCell(this.state!, active.row.key, active.column.name)) this.changed();
                } },
                'separator',
            );
        }
        items.push(
            { label: 'Copy value', icon: 'copy', shortcut: 'Ctrl+C', action: () => this.callbacks.copyText(value === null || value === undefined ? '' : formatDisplayValue(value)) },
            { label: many ? `Copy ${keys.length} rows` : 'Copy row', icon: 'rows', action: () => this.copyRows(keys) },
            { label: many ? `Copy ${keys.length} rows with header` : 'Copy row with header', icon: 'table', action: () => this.copyRows(keys, true) },
            'separator',
            { label: `Filter by ${active.column.name} ${value === null || value === undefined ? 'IS NULL' : '= value'}`, icon: 'filter', action: () => this.callbacks.onFilterByValue(active.column, value) },
        );
        if (!this.readOnly) {
            items.push(
                'separator',
                { label: 'Add row', icon: 'plus', shortcut: 'Alt+Insert', action: () => this.addRow() },
                { label: many ? `Duplicate ${keys.length} rows` : 'Duplicate row', icon: 'copy', shortcut: 'Ctrl+D', action: () => this.duplicateSelected() },
                { label: allDeleted ? (many ? `Restore ${keys.length} rows` : 'Restore row') : (many ? `Delete ${keys.length} rows` : 'Delete row'), icon: allDeleted ? 'undo' : 'trash', shortcut: 'Delete', danger: !allDeleted, action: () => this.deleteSelected() },
                { label: many ? `Revert ${keys.length} rows` : 'Revert row', icon: 'undo', disabled: !anyPending, action: () => this.revertSelected() },
            );
        }
        this.showMenu(event.clientX, event.clientY, items);
    }

    private showMenu(x: number, y: number, items: (MenuItem | 'separator')[]): void {
        const menu = document.getElementById('contextMenu');
        if (!menu) return;
        menu.replaceChildren(...items.map((item, i) => {
            if (item === 'separator') {
                const separator = document.createElement('div');
                separator.className = 'context-menu__sep';
                separator.setAttribute('role', 'separator');
                return separator;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `context-menu__item${item.danger ? ' danger' : ''}`;
            button.dataset.menu = String(i);
            button.disabled = Boolean(item.disabled);
            button.setAttribute('role', 'menuitem');
            if (item.icon) {
                button.appendChild(createMenuIcon(item.icon, 'context-menu__icon'));
            }
            const label = document.createElement('span');
            label.className = 'context-menu__label';
            label.textContent = item.label;
            button.appendChild(label);
            if (item.shortcut) {
                const shortcut = document.createElement('kbd');
                shortcut.textContent = item.shortcut;
                button.appendChild(shortcut);
            }
            button.addEventListener('click', () => {
                if (item.disabled) return;
                this.hideMenu();
                item.action();
                this.focus();
            });
            return button;
        }));
        menu.hidden = false;
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
        menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
    }

    hideMenu(): void {
        const menu = document.getElementById('contextMenu');
        if (menu && !menu.hidden) {
            menu.hidden = true;
            menu.innerHTML = '';
        }
    }

    describeActive(): string {
        const cell = this.getActive();
        if (!cell) return '';
        const parts = [
            `<strong>${escapeHtml(cell.column.name)}</strong>`,
            cell.column.type ? escapeHtml(cell.column.type) : '',
            cell.column.notNull ? 'NOT NULL' : '',
            cell.row.rowId !== null ? `ROWID ${escapeHtml(String(cell.row.rowId))}` : '<span class="status-new">new row</span>',
            `row ${formatCount(cell.index + 1)} of ${formatCount(this.rowCount())}`,
        ];
        const selected = this.selectedKeys.size;
        if (selected > 1) parts.push(`${formatCount(selected)} rows selected`);
        return parts.filter(Boolean).join('<span class="sep">·</span>');
    }
}

function spacer(height: number, colSpan: number): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.className = 'spacer';
    tr.style.height = `${height}px`;
    const td = document.createElement('td');
    td.colSpan = colSpan;
    tr.appendChild(td);
    return tr;
}

function renderValue(text: string, column: GridColumn, raw: unknown): string {
    const shown = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    const escaped = escapeHtml(shown.replace(/[\r\n]+/g, ' ⏎ '));
    if (column.family === 'number') return `<span class="val-num">${escaped}</span>`;
    if (column.family === 'date') return `<span class="val-date">${escaped}</span>`;
    if (column.family === 'bool') {
        const truthy = raw === true || /^(t|true|1|y|yes)$/i.test(text);
        return truthy ? `<span class="val-bool-t">✓ ${escaped}</span>` : `<span class="val-bool-f">✗ ${escaped}</span>`;
    }
    return escaped;
}
