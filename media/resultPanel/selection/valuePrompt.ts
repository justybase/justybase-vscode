/**
 * Minimal value prompt for the result-grid column menu. A webview cannot rely
 * on `window.prompt` being available, so the menu renders its own overlay and
 * resolves once the user applies or cancels.
 */

const OVERLAY_CLASS = 'grid-value-prompt-overlay';
const DIALOG_CLASS = 'grid-value-prompt';
const INPUT_CLASS = 'grid-value-prompt-input';
const ACTIONS_CLASS = 'grid-value-prompt-actions';

function styleOverlay(overlay: HTMLElement): void {
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '10001';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.background = 'rgba(0, 0, 0, 0.35)';
}

function styleDialog(dialog: HTMLElement): void {
    dialog.style.minWidth = '280px';
    dialog.style.maxWidth = 'min(480px, 90vw)';
    dialog.style.padding = '14px';
    dialog.style.borderRadius = '6px';
    dialog.style.border = '1px solid var(--vscode-widget-border, var(--vscode-menu-border))';
    dialog.style.background = 'var(--vscode-editorWidget-background)';
    dialog.style.color = 'var(--vscode-editorWidget-foreground)';
    dialog.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.4)';
    dialog.style.display = 'flex';
    dialog.style.flexDirection = 'column';
    dialog.style.gap = '10px';
}

function styleInput(input: HTMLInputElement): void {
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.padding = '5px 7px';
    input.style.fontSize = '12px';
    input.style.color = 'var(--vscode-input-foreground)';
    input.style.background = 'var(--vscode-input-background)';
    input.style.border = '1px solid var(--vscode-input-border, var(--vscode-menu-border))';
    input.style.borderRadius = '2px';
    input.style.outline = 'none';
}

function styleButton(button: HTMLButtonElement, primary: boolean): void {
    button.type = primary ? 'submit' : 'button';
    button.textContent = primary ? 'Apply' : 'Cancel';
    button.style.padding = '4px 10px';
    button.style.fontSize = '12px';
    button.style.borderRadius = '2px';
    button.style.cursor = 'pointer';
    button.style.border = '1px solid var(--vscode-button-border, transparent)';
    button.style.color = primary
        ? 'var(--vscode-button-foreground)'
        : 'var(--vscode-button-secondaryForeground)';
    button.style.background = primary
        ? 'var(--vscode-button-background)'
        : 'var(--vscode-button-secondaryBackground)';
}

/**
 * Asks for a value; resolves `undefined` on cancel and the trimmed text on
 * apply. An empty result is meaningful: it filters the column's empty cells.
 */
export function promptForMenuValue(title: string, initialValue = ''): Promise<string | undefined> {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = OVERLAY_CLASS;
        styleOverlay(overlay);

        const dialog = document.createElement('form');
        dialog.className = DIALOG_CLASS;
        styleDialog(dialog);

        const heading = document.createElement('div');
        heading.textContent = title;
        heading.style.fontSize = '12px';
        heading.style.fontWeight = '600';
        dialog.appendChild(heading);

        const input = document.createElement('input');
        input.className = INPUT_CLASS;
        input.type = 'text';
        input.value = initialValue;
        input.placeholder = 'Value to match (leave empty for empty cells)';
        styleInput(input);
        dialog.appendChild(input);

        const actions = document.createElement('div');
        actions.className = ACTIONS_CLASS;
        actions.style.display = 'flex';
        actions.style.justifyContent = 'flex-end';
        actions.style.gap = '8px';

        const cancel = document.createElement('button');
        styleButton(cancel, false);
        const apply = document.createElement('button');
        styleButton(apply, true);
        actions.append(cancel, apply);
        dialog.appendChild(actions);

        let settled = false;
        const finish = (value: string | undefined): void => {
            if (settled) return;
            settled = true;
            overlay.remove();
            resolve(value);
        };

        dialog.addEventListener('submit', event => {
            event.preventDefault();
            finish(input.value);
        });
        cancel.addEventListener('click', () => finish(undefined));
        overlay.addEventListener('mousedown', event => {
            if (event.target === overlay) {
                finish(undefined);
            }
        });
        overlay.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                finish(undefined);
            }
        });

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        input.focus();
        input.select();
    });
}
