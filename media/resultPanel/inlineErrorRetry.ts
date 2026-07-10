import { ALL_ROWS_RETRY_TIMEOUT_SECONDS } from './allRowsOperationTimeouts.js';

export function formatAllRowsOperationError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
        return `Timed out: ${message}`;
    }
    return message;
}

export function showInlineErrorWithRetry(
    container: HTMLElement,
    error: unknown,
    onRetry: () => void,
): void {
    container.replaceChildren();
    const wrapper = document.createElement('div');
    wrapper.style.padding = '12px';
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.gap = '8px';

    const message = document.createElement('div');
    message.style.color = 'var(--vscode-errorForeground)';
    message.style.fontSize = '12px';
    message.style.lineHeight = '1.4';
    message.textContent = formatAllRowsOperationError(error);

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'filter-btn';
    retryBtn.textContent = `Retry (${ALL_ROWS_RETRY_TIMEOUT_SECONDS}s)`;
    retryBtn.title = `Retry with a ${ALL_ROWS_RETRY_TIMEOUT_SECONDS} second timeout`;
    retryBtn.style.alignSelf = 'flex-start';
    retryBtn.onclick = (event) => {
        event.stopPropagation();
        event.preventDefault();
        onRetry();
    };

    wrapper.appendChild(message);
    wrapper.appendChild(retryBtn);
    container.appendChild(wrapper);
}
