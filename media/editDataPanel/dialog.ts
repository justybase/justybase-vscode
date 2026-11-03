/**
 * In-webview modal dialogs. `window.confirm()` is blocked inside the VS Code
 * webview sandbox, so confirmations must be rendered by the panel itself.
 */
import { escapeHtml } from './utils.js';

export interface DialogButton {
    id: string;
    label: string;
    kind?: 'primary' | 'danger' | 'secondary';
}

export interface DialogOptions {
    title: string;
    /** Trusted HTML body; callers escape any user/database text. */
    bodyHtml: string;
    buttons: DialogButton[];
    /** Button returned for Escape / backdrop click. */
    cancelId: string;
    wide?: boolean;
    onRender?: (root: HTMLElement) => void;
}

let openDialog: { close: (id: string) => void } | null = null;

export function isDialogOpen(): boolean {
    return openDialog !== null;
}

export function showDialog(options: DialogOptions): Promise<string> {
    const host = document.getElementById('dialogHost') ?? document.body;
    openDialog?.close(options.cancelId);

    return new Promise(resolve => {
        const backdrop = document.createElement('div');
        backdrop.className = 'dialog-backdrop';
        backdrop.innerHTML = `
            <div class="dialog${options.wide ? ' dialog--wide' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(options.title)}">
                <div class="dialog__title">${escapeHtml(options.title)}</div>
                <div class="dialog__body">${options.bodyHtml}</div>
                <div class="dialog__actions">
                    ${options.buttons.map(b => `<button type="button" data-dialog-button="${escapeHtml(b.id)}" class="${b.kind ?? 'secondary'}">${escapeHtml(b.label)}</button>`).join('')}
                </div>
            </div>`;

        const previousFocus = document.activeElement as HTMLElement | null;
        const close = (id: string) => {
            backdrop.remove();
            document.removeEventListener('keydown', onKey, true);
            openDialog = null;
            previousFocus?.focus?.();
            resolve(id);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close(options.cancelId);
            }
        };

        backdrop.addEventListener('mousedown', event => {
            if (event.target === backdrop) close(options.cancelId);
        });
        backdrop.querySelectorAll<HTMLButtonElement>('[data-dialog-button]').forEach(button => {
            button.addEventListener('click', () => close(button.dataset.dialogButton || options.cancelId));
        });
        document.addEventListener('keydown', onKey, true);
        host.appendChild(backdrop);
        openDialog = { close };
        options.onRender?.(backdrop);

        const primary = backdrop.querySelector<HTMLButtonElement>('button.primary, button.danger')
            ?? backdrop.querySelector<HTMLButtonElement>('button');
        primary?.focus();
    });
}

export async function confirmDialog(options: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
}): Promise<boolean> {
    const result = await showDialog({
        title: options.title,
        bodyHtml: `<p class="dialog__message">${escapeHtml(options.message)}</p>`,
        buttons: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'ok', label: options.confirmLabel, kind: options.danger ? 'danger' : 'primary' },
        ],
        cancelId: 'cancel',
    });
    return result === 'ok';
}
