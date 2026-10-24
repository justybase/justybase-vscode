import { getActiveGridIndex } from './state.js';
import { isResultSetRowLimitReached } from './filter.js';
import { getAnalysisLimitWarning } from './analysis.js';
import { getDiskGroupingTruncationMessage } from './diskGrouping.js';
import { getResultPanelWindow, getResultSetAt } from './types.js';
import type { ResultSet } from './types.js';

interface BannerWarning {
    /** Stable identity of the warning kind, used for per-result dismissal. */
    key: string;
    text: string;
}

interface ResultBannerState {
    /**
     * Sticky: once the row limit was observed for this result it stays reached.
     * Disk-backed results only expose a window of rows, so a later render must
     * not clear the warning just because `data.length` shrank.
     */
    limitReached: boolean;
    /** Warning kinds the user dismissed for this result. */
    dismissed: Set<string>;
}

/** Bound the per-result state map so long sessions cannot leak identities. */
const RESULT_BANNER_STATE_LIMIT = 50;

const resultBannerState = new Map<string, ResultBannerState>();
const bannerSignatures = new WeakMap<HTMLElement, string>();

function getResultBannerState(identity: string): ResultBannerState {
    let state = resultBannerState.get(identity);
    if (state) {
        return state;
    }

    state = { limitReached: false, dismissed: new Set<string>() };
    resultBannerState.set(identity, state);
    while (resultBannerState.size > RESULT_BANNER_STATE_LIMIT) {
        const oldest = resultBannerState.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        resultBannerState.delete(oldest);
    }
    return state;
}

function resolveResultIdentity(activeIndex: number, result: ResultSet | null): string {
    if (result?.resultSetId) {
        return `id:${result.resultSetId}`;
    }
    if (typeof result?.executionTimestamp === 'number' && result.executionTimestamp > 0) {
        return `ts:${result.executionTimestamp}:${activeIndex}`;
    }
    return `index:${activeIndex}`;
}

function collectWarnings(
    activeIndex: number,
    activeResult: ResultSet | null,
    state: ResultBannerState,
): BannerWarning[] {
    const warnings: BannerWarning[] = [];

    if (
        activeResult?.limitReached === true
        || state.limitReached
        || isResultSetRowLimitReached(activeResult)
    ) {
        // Latch the observation: subsequent renders may only see a data window.
        state.limitReached = true;
        const limit = Number(getResultPanelWindow().queryRowLimit) || 200000;
        const fetchedFromData = Array.isArray(activeResult?.data) ? activeResult.data.length : 0;
        const fetchedFromTotal = typeof activeResult?.totalRowCount === 'number' ? activeResult.totalRowCount : 0;
        const fetched = Math.min(limit, Math.max(fetchedFromData, fetchedFromTotal));
        warnings.push({
            key: 'row-limit',
            text:
                `Query row limit reached: ${fetched.toLocaleString()} of ${limit.toLocaleString()} rows fetched. ` +
                'Increase "justybase.query.rowLimit" in settings to fetch more.',
        });
    }

    const analysisWarning = getAnalysisLimitWarning();
    if (analysisWarning) {
        warnings.push({ key: 'analysis-limit', text: analysisWarning });
    }

    const groupingWarning = getDiskGroupingTruncationMessage(activeIndex);
    if (groupingWarning) {
        warnings.push({ key: 'disk-grouping-limit', text: groupingWarning });
    }

    return warnings;
}

function clearBanner(banner: HTMLElement): void {
    banner.style.display = 'none';
    banner.classList.remove('visible');
    banner.innerHTML = '';
    banner.title = '';
}

function appendBannerContent(
    banner: HTMLElement,
    text: string,
    onDismiss: () => void,
): void {
    const icon = document.createElement('span');
    icon.className = 'result-limit-banner__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⚠';

    const textElement = document.createElement('span');
    textElement.className = 'result-limit-banner__text';
    textElement.textContent = text;

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'result-limit-banner__dismiss';
    dismiss.title = 'Dismiss warning';
    dismiss.setAttribute('aria-label', 'Dismiss warning');
    dismiss.textContent = '✕';
    dismiss.addEventListener('click', onDismiss);

    banner.innerHTML = '';
    banner.appendChild(icon);
    banner.appendChild(textElement);
    banner.appendChild(dismiss);
}

export function updateResultLimitBanner(): void {
    const banner = document.getElementById('resultLimitBanner');
    if (!banner) {
        return;
    }

    const activeIndex = getActiveGridIndex();
    const activeResult = getResultSetAt(activeIndex) ?? null;
    const identity = resolveResultIdentity(activeIndex, activeResult);
    const state = getResultBannerState(identity);

    const warnings = collectWarnings(activeIndex, activeResult, state)
        .filter(warning => !state.dismissed.has(warning.key));
    const text = warnings.map(warning => warning.text).join(' ');

    // Only touch the DOM when the visible message actually changed. Rewriting
    // identical markup on every streamed chunk made the banner flash (and
    // re-announced it through aria-live).
    const signature = `${identity}\u0000${text}`;
    if (bannerSignatures.get(banner) === signature) {
        return;
    }
    bannerSignatures.set(banner, signature);

    if (warnings.length === 0) {
        clearBanner(banner);
        return;
    }

    appendBannerContent(banner, text, () => {
        for (const warning of warnings) {
            state.dismissed.add(warning.key);
        }
        updateResultLimitBanner();
    });
    banner.title = text;
    banner.style.display = 'flex';
    banner.classList.add('visible');
}
