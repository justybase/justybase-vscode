/**
 * Resizable column-name column for the Row View.
 *
 * Row View renders a two-column grid (column name | values). Long identifiers
 * were clipped by the fixed 42% column with no way to reveal them, so the
 * splitter below lets the user drag the name column wider. The choice is stored
 * as a percentage, which keeps it usable when the result panel itself changes
 * width, and it survives result switches and webview reloads.
 */

const STORAGE_KEY = 'justybase.row-view.key-column-width.v1';

export const ROW_VIEW_KEY_WIDTH_VARIABLE = '--rv-key-width';
export const ROW_VIEW_KEY_MIN_PERCENT = 12;
export const ROW_VIEW_KEY_MAX_PERCENT = 72;

const DEFAULT_PERCENT = 42;
const MIN_KEY_WIDTH_PX = 110;
const KEY_GAP_PX = 6;
/** Section horizontal padding plus the inter-column gap. */
const KEY_COLUMN_CHROME_PX = 26;

/** Keeps the name column above the type chip and below a workable value column. */
export function clampRowViewKeyWidth(percent: number, tableWidth: number): number {
    const minPercent = tableWidth > 0
        ? Math.min(ROW_VIEW_KEY_MAX_PERCENT, Math.max(ROW_VIEW_KEY_MIN_PERCENT, (MIN_KEY_WIDTH_PX / tableWidth) * 100))
        : ROW_VIEW_KEY_MIN_PERCENT;
    if (!Number.isFinite(percent)) {
        return DEFAULT_PERCENT;
    }
    return Math.min(ROW_VIEW_KEY_MAX_PERCENT, Math.max(minPercent, percent));
}

function readStoredRowViewKeyWidth(): number | undefined {
    try {
        const stored = window.localStorage?.getItem(STORAGE_KEY);
        if (stored === null || stored === undefined) {
            return undefined;
        }
        const parsed = Number.parseFloat(stored);
        return Number.isFinite(parsed) ? parsed : undefined;
    } catch {
        // Sandboxed webviews can deny storage access; the default width still works.
        return undefined;
    }
}

function storeRowViewKeyWidth(percent: number): void {
    try {
        window.localStorage?.setItem(STORAGE_KEY, String(Math.round(percent * 10) / 10));
    } catch {
        // Ignore storage failures: the current drag result stays applied.
    }
}

/**
 * Wires drag, keyboard and double-click resizing for the Row View name column.
 * Call after the splitter and sections are attached to the table.
 */
export function attachRowViewColumnResize(table: HTMLElement, splitter: HTMLElement): void {
    const stored = readStoredRowViewKeyWidth();
    let percent = clampRowViewKeyWidth(stored ?? DEFAULT_PERCENT, table.getBoundingClientRect().width);

    const updateAria = (): void => {
        splitter.setAttribute('aria-valuenow', String(Math.round(percent)));
    };
    const apply = (nextPercent: number): void => {
        percent = clampRowViewKeyWidth(nextPercent, table.getBoundingClientRect().width);
        table.style.setProperty(ROW_VIEW_KEY_WIDTH_VARIABLE, `${percent}%`);
        updateAria();
    };
    const commit = (nextPercent: number): void => {
        apply(nextPercent);
        storeRowViewKeyWidth(percent);
    };

    if (stored !== undefined) {
        apply(stored);
    } else {
        updateAria();
    }

    splitter.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }
        event.preventDefault();
        try {
            splitter.setPointerCapture(event.pointerId);
        } catch {
            // Pointer capture is unavailable in some test harnesses.
        }
        table.classList.add('row-view-resizing');

        const onMove = (moveEvent: PointerEvent): void => {
            const rect = table.getBoundingClientRect();
            if (rect.width <= 0) {
                return;
            }
            apply(((moveEvent.clientX - rect.left) / rect.width) * 100);
        };
        const onEnd = (): void => {
            splitter.removeEventListener('pointermove', onMove);
            splitter.removeEventListener('pointerup', onEnd);
            splitter.removeEventListener('pointercancel', onEnd);
            table.classList.remove('row-view-resizing');
            storeRowViewKeyWidth(percent);
        };

        splitter.addEventListener('pointermove', onMove);
        splitter.addEventListener('pointerup', onEnd);
        splitter.addEventListener('pointercancel', onEnd);
    });

    splitter.addEventListener('keydown', event => {
        const step = event.shiftKey ? 8 : 2;
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            commit(percent - step);
        } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            commit(percent + step);
        }
    });

    // Keep Row View cell selection and shortcuts out of the resize gesture.
    splitter.addEventListener('mousedown', event => {
        event.stopPropagation();
    });

    // Double-click sizes the column to the longest currently visible name.
    splitter.addEventListener('dblclick', event => {
        event.preventDefault();
        const rect = table.getBoundingClientRect();
        if (rect.width <= 0) {
            return;
        }
        let widest = 0;
        table.querySelectorAll<HTMLElement>('.row-view-key').forEach(key => {
            const name = key.querySelector<HTMLElement>('.row-view-key-name');
            const type = key.querySelector<HTMLElement>('.row-view-key-type');
            const nameWidth = name ? Math.max(name.scrollWidth, name.offsetWidth) : 0;
            const typeWidth = type ? type.offsetWidth : 0;
            widest = Math.max(widest, nameWidth + (typeWidth > 0 ? typeWidth + KEY_GAP_PX : 0));
        });
        if (widest <= 0) {
            return;
        }
        commit(((widest + KEY_COLUMN_CHROME_PX) / rect.width) * 100);
    });
}
