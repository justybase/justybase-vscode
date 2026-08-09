// SQL preview modal for Explore (reuses the sql-preview CSS from styles.ts).

import { getElementById } from '../dom.js';
import { postHostMessage } from '../protocol.js';

export interface PreviewModalOptions {
    title?: string;
    sql: string;
    onOpenInEditor?: (sql: string) => void;
}

function ensureOverlay(): HTMLElement {
    let overlay = getElementById('exploreSqlPreviewOverlay');
    if (overlay) {
        return overlay;
    }
    overlay = document.createElement('div');
    overlay.id = 'exploreSqlPreviewOverlay';
    overlay.className = 'sql-preview-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
        <div class="sql-preview-modal">
            <div class="sql-preview-header">
                <div class="sql-preview-title" id="exploreSqlPreviewTitle">SQL</div>
                <button class="sql-preview-close" id="exploreSqlPreviewClose" title="Close" aria-label="Close">✕</button>
            </div>
            <div class="sql-preview-body">
                <pre class="sql-preview-code" id="exploreSqlPreviewCode"></pre>
            </div>
            <div class="sql-preview-footer">
                <span class="sql-preview-hint">Generated SQL — copy or open in the editor.</span>
                <div class="sql-preview-actions">
                    <button id="exploreSqlPreviewCopy">Copy</button>
                    <button id="exploreSqlPreviewOpen" class="primary">Open in Editor</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => {
        overlay.style.display = 'none';
    };
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            close();
        }
    });
    const closeBtn = getElementById('exploreSqlPreviewClose');
    closeBtn?.addEventListener('click', close);
    const copyBtn = getElementById('exploreSqlPreviewCopy');
    copyBtn?.addEventListener('click', async () => {
        const code = getElementById<HTMLPreElement>('exploreSqlPreviewCode');
        if (!code) return;
        try {
            await navigator.clipboard.writeText(code.textContent ?? '');
            copyBtn.textContent = '✓ Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        } catch {
            postHostMessage({ command: 'info', text: 'Failed to copy SQL to clipboard' });
        }
    });
    const openBtn = getElementById('exploreSqlPreviewOpen');
    openBtn?.addEventListener('click', () => {
        const code = getElementById<HTMLPreElement>('exploreSqlPreviewCode');
        if (!code) return;
        const onOpen = window.__exploreOpenSqlInEditor;
        if (typeof onOpen === 'function') {
            onOpen(code.textContent ?? '');
        }
        close();
    });

    return overlay;
}

export function showSqlPreviewModal(options: PreviewModalOptions): void {
    const overlay = ensureOverlay();
    const title = getElementById('exploreSqlPreviewTitle');
    const code = getElementById<HTMLPreElement>('exploreSqlPreviewCode');
    if (title) title.textContent = options.title ?? 'SQL';
    if (code) code.textContent = options.sql;
    overlay.style.display = 'flex';
}

export function closeSqlPreviewModal(): void {
    const overlay = getElementById('exploreSqlPreviewOverlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

export function wireExplorePreviewGlobal(): void {
    window.__exploreOpenSqlInEditor = (sql: string, label?: string) => {
        postHostMessage({ command: 'openExploreSqlInEditor', sql, label } as never);
    };
}

declare global {
    interface Window {
        __exploreOpenSqlInEditor?: (sql: string, label?: string) => void;
    }
}
