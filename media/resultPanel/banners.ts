import { getActiveGridIndex } from './state.js';
import { isResultSetRowLimitReached } from './filter.js';
import { getAnalysisLimitWarning } from './analysis.js';
import { getDiskGroupingTruncationMessage } from './diskGrouping.js';
import { getResultPanelWindow, getResultSetAt } from './types.js';

export function updateResultLimitBanner(): void {
    const banner = document.getElementById('resultLimitBanner');
    if (!banner) {
        return;
    }

    const warnings: string[] = [];
    const activeIndex = getActiveGridIndex();
    const activeResult = getResultSetAt(activeIndex);

    if (isResultSetRowLimitReached(activeResult)) {
        const limit = Number(getResultPanelWindow().queryRowLimit) || 200000;
        const fetched = Array.isArray(activeResult?.data) ? activeResult.data.length : 0;
        warnings.push(
            `Query row limit reached: ${fetched.toLocaleString()} of ${limit.toLocaleString()} rows fetched. ` +
            'Increase "justybase.query.rowLimit" in settings to fetch more.'
        );
    }

    const analysisWarning = getAnalysisLimitWarning();
    if (analysisWarning) {
        warnings.push(analysisWarning);
    }

    const groupingWarning = getDiskGroupingTruncationMessage(activeIndex);
    if (groupingWarning) {
        warnings.push(groupingWarning);
    }

    if (warnings.length === 0) {
        banner.style.display = 'none';
        banner.classList.remove('visible');
        banner.innerHTML = '';
        banner.title = '';
        return;
    }

    const text = warnings.join(' ');
    banner.innerHTML =
        '<span class="result-limit-banner__icon" aria-hidden="true">⚠</span>' +
        `<span class="result-limit-banner__text">${text}</span>`;
    banner.title = text;
    banner.style.display = 'flex';
    banner.classList.add('visible');
}
