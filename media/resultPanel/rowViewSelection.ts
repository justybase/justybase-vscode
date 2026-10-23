import { writeMultiFormatToClipboard } from './selection/clipboard.js';

/**
 * Rectangular cell selection for the Row View, mirroring the result grid instead of
 * native text selection. Cells are addressed by `data-rv-row` (one per result column)
 * and `data-rv-col` (0 = column name, 1..n = compared rows); `data-rv-copy` overrides
 * the copied text when the displayed text is decorated (booleans, for example).
 */
type RowViewCellPosition = { row: number; col: number };

const SELECTED_CLASS = 'rv-selected';
const ANCHOR_CLASS = 'rv-anchor';

function getCellPosition(element: Element | null): RowViewCellPosition | null {
    const cell = element?.closest<HTMLElement>('[data-rv-row][data-rv-col]');
    if (!cell) return null;
    return { row: Number(cell.dataset.rvRow), col: Number(cell.dataset.rvCol) };
}

function getCells(content: HTMLElement): HTMLElement[] {
    return Array.from(content.querySelectorAll<HTMLElement>('[data-rv-row][data-rv-col]'));
}

export function attachRowViewSelection(content: HTMLElement): void {
    if (content.dataset.rvSelectionAttached === 'true') return;
    content.dataset.rvSelectionAttached = 'true';
    let anchor: RowViewCellPosition | null = null;
    let focus: RowViewCellPosition | null = null;
    let dragging = false;

    content.tabIndex = 0;

    const isInRange = (position: RowViewCellPosition): boolean => {
        if (!anchor || !focus) return false;
        return position.row >= Math.min(anchor.row, focus.row)
            && position.row <= Math.max(anchor.row, focus.row)
            && position.col >= Math.min(anchor.col, focus.col)
            && position.col <= Math.max(anchor.col, focus.col);
    };

    const paint = (): void => {
        for (const cell of getCells(content)) {
            const position = getCellPosition(cell)!;
            cell.classList.toggle(SELECTED_CLASS, isInRange(position));
            cell.classList.toggle(ANCHOR_CLASS, !!anchor && anchor.row === position.row && anchor.col === position.col);
        }
    };

    const clear = (): void => {
        anchor = null;
        focus = null;
        paint();
    };

    const selectAll = (): void => {
        const positions = getCells(content).map(cell => getCellPosition(cell)!);
        if (positions.length === 0) return;
        anchor = { row: 0, col: 0 };
        focus = {
            row: Math.max(...positions.map(position => position.row)),
            col: Math.max(...positions.map(position => position.col)),
        };
        paint();
    };

    const copySelection = (): void => {
        const rows = new Map<number, Map<number, string>>();
        for (const cell of getCells(content)) {
            const position = getCellPosition(cell)!;
            if (!isInRange(position)) continue;
            if (!rows.has(position.row)) rows.set(position.row, new Map());
            rows.get(position.row)!.set(position.col, cell.dataset.rvCopy ?? cell.textContent ?? '');
        }
        if (rows.size === 0) return;
        const minCol = Math.min(anchor!.col, focus!.col);
        const maxCol = Math.max(anchor!.col, focus!.col);
        const lines = Array.from(rows.keys()).sort((a, b) => a - b).map(row => {
            const values: string[] = [];
            for (let col = minCol; col <= maxCol; col++) {
                values.push(rows.get(row)!.get(col) ?? '');
            }
            return values.join('\t');
        });
        const cellCount = lines.length * (maxCol - minCol + 1);
        writeMultiFormatToClipboard('', lines.join('\n'), '', `${cellCount} cell${cellCount === 1 ? '' : 's'}`);
    };

    content.addEventListener('mousedown', event => {
        if (event.button !== 0) return;
        const position = getCellPosition(event.target as Element);
        // Keep focus in the Row View so its shortcuts win over the grid's.
        event.preventDefault();
        content.focus({ preventScroll: true });
        if (!position) {
            clear();
            return;
        }
        if (!event.shiftKey || !anchor) {
            anchor = position;
        }
        focus = position;
        dragging = true;
        paint();
    });

    content.addEventListener('mouseover', event => {
        if (!dragging) return;
        const position = getCellPosition(event.target as Element);
        if (!position || (focus && position.row === focus.row && position.col === focus.col)) return;
        focus = position;
        paint();
    });

    document.addEventListener('mouseup', () => {
        dragging = false;
    });

    // Window capture runs before the grid's document-level shortcut handlers.
    window.addEventListener('keydown', event => {
        if (!content.contains(document.activeElement)) return;
        const key = event.key.toLowerCase();
        const modifier = event.ctrlKey || event.metaKey;
        if (modifier && key === 'a') {
            selectAll();
        } else if (modifier && key === 'c') {
            if (!anchor) return;
            copySelection();
        } else if (key === 'escape' && anchor) {
            clear();
        } else {
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);

    // A re-render replaces the cells, so drop the stale selection with them.
    new MutationObserver(() => {
        anchor = null;
        focus = null;
        dragging = false;
    }).observe(content, { childList: true });
}
