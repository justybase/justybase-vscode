/**
 * DOM-only focus helper for Explore column cards. It deliberately avoids the
 * chart-heavy `explorePanel` module so the grid context menu can link to a
 * column without pulling ECharts into its import graph.
 */
import { getElementById } from '../dom.js';

const FOCUS_CLASS = 'explore-column-card-focus';
const RETRY_DELAY_MS = 60;
const HIGHLIGHT_MS = 1600;

/**
 * Scrolls the Explore view to one column card and highlights it briefly.
 * Cards render asynchronously (a disk-backed sample is fetched first), so the
 * lookup retries a few frames before giving up.
 */
export function focusExploreColumn(columnIndex: number, attempts = 12): void {
    const container = getElementById('analysisContainer');
    const card = container?.querySelector<HTMLElement>(
        `.explore-column-card[data-column-index="${columnIndex}"]`,
    );
    if (!card) {
        if (attempts > 0) {
            setTimeout(() => focusExploreColumn(columnIndex, attempts - 1), RETRY_DELAY_MS);
        }
        return;
    }
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add(FOCUS_CLASS);
    setTimeout(() => card.classList.remove(FOCUS_CLASS), HIGHLIGHT_MS);
}
