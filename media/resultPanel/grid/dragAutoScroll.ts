import { getGlobalDragState } from '../state.js';

const EDGE_THRESHOLD = 40;
const MAX_SCROLL_SPEED = 25;
// While the pointer rests, the HTML spec allows up to ~350ms between dragover events.
// A longer silence means the pointer left the grid, so scrolling must stop.
const DRAG_OVER_STALE_MS = 500;

export interface HorizontalViewport {
    left: number;
    right: number;
}

/**
 * Returns the horizontal scroll delta (px) for a pointer position relative to the visible
 * scroll area. Negative scrolls left, positive scrolls right, 0 means the pointer is not
 * inside an edge zone. Speed grows with the depth of the pointer inside the zone.
 */
export function computeEdgeScrollDelta(
    pointerX: number,
    viewport: HorizontalViewport,
    options: { threshold?: number; maxSpeed?: number } = {},
): number {
    const threshold = options.threshold ?? EDGE_THRESHOLD;
    const maxSpeed = options.maxSpeed ?? MAX_SCROLL_SPEED;
    const leftZone = viewport.left + threshold;
    const rightZone = viewport.right - threshold;

    if (pointerX < leftZone) {
        return -Math.min(maxSpeed, (leftZone - pointerX) * 0.5);
    }
    if (pointerX > rightZone) {
        return Math.min(maxSpeed, (pointerX - rightZone) * 0.5);
    }
    return 0;
}

/**
 * Visible horizontal area of the wrapper, excluding sticky left cells (row number and
 * pinned columns) which cover the start of the scrollable content.
 */
function getScrollViewport(wrapper: HTMLElement): HorizontalViewport {
    const rect = wrapper.getBoundingClientRect();
    const left = rect.left + wrapper.clientLeft;
    const right = left + wrapper.clientWidth;
    let stickyRight = left;

    wrapper.querySelectorAll<HTMLElement>('thead th').forEach((cell) => {
        if (cell.style.position === 'sticky') {
            stickyRight = Math.max(stickyRight, cell.getBoundingClientRect().right);
        }
    });

    return { left: stickyRight, right };
}

function isColumnDragActive(): boolean {
    const dragState = getGlobalDragState();
    return dragState.isDragging && dragState.dragType === 'column';
}

interface ColumnDragAutoScroller {
    readonly wrapper: HTMLElement;
    handleDragOver(clientX: number): void;
}

// While a column header is dragged, the grouping drop zone is revealed above the grid, so the
// pointer can be over it rather than the grid. One document listener routes the pointer to the
// grid whose horizontal extent contains it, regardless of which element receives dragover.
const autoScrollers = new Set<ColumnDragAutoScroller>();
let isDocumentListenerAttached = false;

function handleDocumentDragOver(event: DragEvent): void {
    if (!isColumnDragActive()) {
        return;
    }
    for (const scroller of autoScrollers) {
        if (scroller.wrapper.isConnected) {
            scroller.handleDragOver(event.clientX);
        } else {
            autoScrollers.delete(scroller);
        }
    }
}

/**
 * Lets a column header dragged near the left/right edge of a result grid scroll the grid
 * horizontally, so the column can be dropped beyond the currently visible area.
 * The scroll loop runs only while a column drag is active and the pointer is in an edge zone.
 */
export function attachColumnDragAutoScroll(wrapper: HTMLElement): void {
    let frame: number | null = null;
    let pointerX = 0;
    let lastDragOverAt = 0;

    function tick(): void {
        frame = null;
        if (!wrapper.isConnected || !isColumnDragActive()) {
            return;
        }
        if (performance.now() - lastDragOverAt > DRAG_OVER_STALE_MS) {
            return;
        }

        const delta = computeEdgeScrollDelta(pointerX, getScrollViewport(wrapper));
        if (delta === 0) {
            return;
        }

        wrapper.scrollBy(delta, 0);
        frame = requestAnimationFrame(tick);
    }

    autoScrollers.add({
        wrapper,
        handleDragOver(clientX: number): void {
            const rect = wrapper.getBoundingClientRect();
            // Hidden grids have no layout box, and pointers outside the grid's horizontal extent do not scroll it.
            if (rect.width === 0 || clientX < rect.left || clientX > rect.right) {
                return;
            }
            pointerX = clientX;
            lastDragOverAt = performance.now();

            if (frame === null && computeEdgeScrollDelta(pointerX, getScrollViewport(wrapper)) !== 0) {
                frame = requestAnimationFrame(tick);
            }
        },
    });

    if (!isDocumentListenerAttached) {
        document.addEventListener('dragover', handleDocumentDragOver);
        isDocumentListenerAttached = true;
    }
}
