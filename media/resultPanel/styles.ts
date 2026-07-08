// Styles module - CSS injection for result panel

export function injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
    .console-wrapper {
        background-color: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-editor-font-family), 'Consolas', 'Courier New', monospace;
        font-size: var(--vscode-editor-font-size, 13px);
        overflow-y: auto;
        padding: 10px;
        height: 100%;
        box-sizing: border-box;
    }
    .console-view {
        display: flex;
        flex-direction: column;
    }
    .console-line {
        line-height: 1.5;
        white-space: pre-wrap;
        border-bottom: 1px solid var(--vscode-panel-border);
    }
    .console-line.separator {
        color: var(--vscode-textLink-foreground);
        font-weight: bold;
        margin-top: 10px;
        margin-bottom: 5px;
        border-bottom: 1px solid var(--vscode-textLink-foreground);
    }
    .console-time {
        color: var(--vscode-descriptionForeground);
        margin-right: 8px;
        user-select: none;
    }
    .console-msg {
        color: var(--vscode-editor-foreground);
    }
    .error-wrapper {
        padding: 20px;
        background-color: var(--vscode-editor-background);
        height: 100%;
        overflow: auto;
        box-sizing: border-box;
    }
    .error-view {
        border-left: 4px solid var(--vscode-errorForeground);
        background-color: var(--vscode-input-background);
        padding: 15px;
        margin: 10px 0;
        white-space: pre-wrap;
        font-family: var(--vscode-editor-font-family);
        color: var(--vscode-errorForeground);
    }
    .error-title {
        font-weight: bold;
        margin-bottom: 8px;
        font-size: 1.1em;
    }
    .error-recovery-hint {
        margin-top: 12px;
        color: var(--vscode-descriptionForeground);
        font-size: 0.95em;
        line-height: 1.5;
    }
    .error-sql {
        margin-top: 15px;
        padding-top: 10px;
        border-top: 1px solid var(--vscode-panel-border);
        opacity: 0.7;
        font-size: 0.9em;
    }
    .error-actions {
        margin-top: 20px;
        padding-top: 15px;
        border-top: 1px solid var(--vscode-panel-border);
        display: flex;
        gap: 10px;
        align-items: center;
    }
    .error-secondary-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        font-size: 13px;
        font-weight: 500;
        border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
        border-radius: 4px;
        cursor: pointer;
        background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
        color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
        transition: background 0.2s ease;
    }
    .error-secondary-btn:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
    }
    .copilot-fix-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 500;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        background: linear-gradient(135deg, var(--vscode-button-background) 0%, #6b5ce7 100%);
        color: var(--vscode-button-foreground);
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        transition: all 0.2s ease;
    }
    .copilot-fix-btn:hover {
        background: linear-gradient(135deg, var(--vscode-button-hoverBackground) 0%, #7d6ff0 100%);
        box-shadow: 0 3px 8px rgba(0, 0, 0, 0.3);
        transform: translateY(-1px);
    }
    .copilot-fix-btn:active {
        transform: translateY(0);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    }
    .copilot-fix-btn .icon {
        font-size: 16px;
    }
    .copilot-fix-btn.loading {
        opacity: 0.7;
        cursor: wait;
    }
`;
    document.head.appendChild(style);
}
