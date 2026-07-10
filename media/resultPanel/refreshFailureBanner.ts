import { postHostMessage } from './protocol.js';
import { getActiveGridIndex } from './state.js';
import { callPanelMethod, getActiveSourceUri, getResultSetAt } from './types.js';

function findGridWrapper(rsIndex: number): HTMLElement | null {
    const container = document.getElementById('gridContainer');
    if (!container) {
        return null;
    }
    return container.querySelector(`.grid-wrapper[data-index="${rsIndex}"]`) as HTMLElement | null;
}

function removeRefreshFailureBanner(wrapper: HTMLElement): void {
    wrapper.querySelector('.refresh-failure-banner')?.remove();
}

function buildRefreshFailureBanner(
    rsIndex: number,
    message: string,
): HTMLElement {
    const banner = document.createElement('div');
    banner.className = 'refresh-failure-banner';
    banner.setAttribute('role', 'alert');

    const text = document.createElement('div');
    text.className = 'refresh-failure-banner__message';
    text.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'refresh-failure-banner__actions';

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'refresh-failure-banner__retry';
    retryBtn.textContent = 'Retry refresh';
    retryBtn.onclick = (event) => {
        event.stopPropagation();
        event.preventDefault();
        callPanelMethod('refreshResultAt', rsIndex);
    };

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'refresh-failure-banner__dismiss';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.onclick = (event) => {
        event.stopPropagation();
        event.preventDefault();
        const sourceUri = getActiveSourceUri();
        const wrapper = banner.parentElement;
        if (wrapper) {
            removeRefreshFailureBanner(wrapper);
        }
        if (!sourceUri) {
            return;
        }
        postHostMessage({
            command: 'clearRefreshFailure',
            sourceUri,
            resultSetIndex: rsIndex,
        });
    };

    actions.appendChild(retryBtn);
    actions.appendChild(dismissBtn);
    banner.appendChild(text);
    banner.appendChild(actions);
    return banner;
}

export function updateRefreshFailureBanner(rsIndex: number): void {
    const wrapper = findGridWrapper(rsIndex);
    if (!wrapper) {
        return;
    }

    const failure = getResultSetAt(rsIndex)?.refreshFailure;
    removeRefreshFailureBanner(wrapper);
    if (!failure?.message) {
        return;
    }

    const banner = buildRefreshFailureBanner(rsIndex, failure.message);
    wrapper.insertBefore(banner, wrapper.firstChild);
}

export function updateAllRefreshFailureBanners(): void {
    const activeIndex = getActiveGridIndex();
    updateRefreshFailureBanner(activeIndex);
}

export function clearRefreshFailureBanner(rsIndex: number): void {
    const wrapper = findGridWrapper(rsIndex);
    if (wrapper) {
        removeRefreshFailureBanner(wrapper);
    }
}
