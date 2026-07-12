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
        background-color: var(--vscode-editor-background);
        padding: 16px;
        margin: 0;
        white-space: pre-wrap;
        font-family: var(--vscode-editor-font-family);
        color: var(--vscode-editor-foreground);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
    }
    .error-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        margin-bottom: 12px;
        font-size: 13px;
        color: var(--vscode-errorForeground);
        padding-bottom: 10px;
        border-bottom: 1px solid var(--vscode-panel-border);
    }
    .error-title .error-icon {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: var(--vscode-errorForeground);
        color: var(--vscode-editor-background);
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
    }
    .error-recovery-hint {
        margin-top: 12px;
        color: var(--vscode-descriptionForeground);
        font-size: 0.93em;
        line-height: 1.5;
    }
    .error-sql {
        margin-top: 15px;
        padding-top: 10px;
        border-top: 1px solid var(--vscode-panel-border);
        opacity: 0.7;
        font-size: 0.9em;
    }
    .error-summary {
        margin: 4px 0 8px;
        padding: 10px 12px;
        background: var(--vscode-textBlockQuote-background, var(--vscode-editor-background));
        border: 1px solid var(--vscode-panel-border);
        border-left: 3px solid var(--vscode-errorForeground);
        border-radius: 4px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 13px;
        font-weight: 500;
        line-height: 1.5;
        color: var(--vscode-editor-foreground);
        word-break: break-word;
    }
    .error-details-toggle {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-top: 8px;
        padding: 2px 6px;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--vscode-textLink-foreground);
        cursor: pointer;
        font-size: 11px;
        font-family: inherit;
        transition: background 0.15s ease;
    }
    .error-details-toggle:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .error-details-toggle .arrow {
        display: inline-block;
        transition: transform 0.2s ease;
        font-size: 10px;
    }
    .error-details-toggle .arrow.open {
        transform: rotate(90deg);
    }
    .error-details {
        margin-top: 6px;
        padding: 8px 10px;
        background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
        border: 1px solid var(--vscode-panel-border);
        border-radius: 3px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px;
        line-height: 1.4;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--vscode-descriptionForeground);
        display: none;
        max-height: 400px;
        overflow-y: auto;
    }
    .error-details.visible {
        display: block;
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

    /* === Database Grouping Panel + Right Bar === */
    .database-grouping-panel {
        position: relative;
        display: none;
        flex-direction: column;
        height: 100%;
        border-left: 1px solid var(--vscode-panel-border);
        background: var(--vscode-sideBar-background);
        color: var(--vscode-sideBar-foreground);
        font-size: 12px;
        width: 320px;
        min-width: 280px;
        overflow: hidden;
    }
    .database-grouping-panel .grouping-resize-handle {
        position: absolute;
        z-index: 4;
        left: -4px;
        top: 0;
        width: 8px;
        height: 100%;
        cursor: col-resize;
        outline: none;
    }
    .database-grouping-panel .grouping-resize-handle:hover,
    .database-grouping-panel .grouping-resize-handle:focus {
        background: var(--vscode-focusBorder);
    }
    .database-grouping-panel.visible {
        display: flex;
    }
    .database-grouping-panel .grouping-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
        font-weight: 600;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-sideBarTitle-foreground);
        flex-shrink: 0;
    }
    .database-grouping-panel .grouping-panel-header .header-actions {
        display: flex;
        gap: 4px;
        align-items: center;
    }
    .database-grouping-panel .grouping-panel-header .header-actions button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 2px;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
        font-size: 14px;
        transition: background 0.15s ease;
    }
    .database-grouping-panel .grouping-panel-header .header-actions button:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .database-grouping-panel .grouping-panel-header .header-actions button.close-btn {
        color: var(--vscode-errorForeground);
    }
    .database-grouping-panel .grouping-drop-zone {
        flex-shrink: 0;
        min-height: 34px;
        padding: 5px 7px;
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 4px;
        margin: 4px 6px;
        display: flex;
        flex-direction: row;
        gap: 5px;
        align-items: center;
        justify-content: flex-start;
        transition: all 0.2s ease;
        cursor: default;
    }
    .database-grouping-panel .grouping-drop-zone.drag-over {
        border-color: var(--vscode-focusBorder);
        background: var(--vscode-list-hoverBackground);
    }
    .database-grouping-panel .grouping-drop-zone .drop-hint {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        text-align: center;
        pointer-events: none;
        user-select: none;
        display: flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
    }
    .database-grouping-panel .grouping-drop-zone .drop-hint svg { width: 14px; height: 14px; }
    .database-grouping-panel .grouping-drop-zone .group-chips {
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        gap: 4px;
        width: 100%;
    }
    .database-grouping-panel .grouping-drop-zone .group-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 8px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        border-radius: 3px;
        font-size: 11px;
        cursor: move;
        user-select: none;
        transition: all 0.15s ease;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
    }
    .database-grouping-panel .grouping-drop-zone .group-chip .chip-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        border: none;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 12px;
        opacity: 0.6;
        padding: 0;
        border-radius: 2px;
    }
    .database-grouping-panel .grouping-drop-zone .group-chip .chip-remove:hover {
        opacity: 1;
        background: rgba(255, 0, 0, 0.2);
    }
    .database-grouping-panel .grouping-actions {
        display: flex;
        gap: 4px;
        padding: 4px 6px;
        border-bottom: 1px solid var(--vscode-panel-border);
        flex-shrink: 0;
    }
    .database-grouping-panel .grouping-limit-area {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 4px 6px;
        border-bottom: 1px solid var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        flex-shrink: 0;
    }
    .database-grouping-panel .grouping-limit-area select {
        min-width: 150px;
        background: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
        border: 1px solid var(--vscode-dropdown-border);
        border-radius: 3px;
        padding: 2px 4px;
    }
    .database-grouping-panel .grouping-actions button {
        flex: 1;
        padding: 4px 7px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 3px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        transition: all 0.15s ease;
    }
    .database-grouping-panel .grouping-actions button:hover:not(:disabled) {
        background: var(--vscode-button-hoverBackground);
    }
    .database-grouping-panel .grouping-actions button.secondary {
        background: transparent;
        color: var(--vscode-foreground);
    }
    .database-grouping-panel .grouping-actions button.secondary:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .database-grouping-panel .grouping-actions button.danger {
        color: var(--vscode-errorForeground);
        border-color: var(--vscode-errorForeground);
    }
    .database-grouping-panel .grouping-results {
        flex: 1;
        overflow: auto;
        padding: 4px;
    }
    .database-grouping-panel .grouping-summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        position: sticky;
        top: 0;
        z-index: 2;
        padding: 4px;
        background: var(--vscode-sideBar-background);
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
    }
    .database-grouping-panel .grouping-sql-copy {
        border: 0;
        padding: 2px 4px;
        color: var(--vscode-textLink-foreground);
        background: transparent;
        cursor: pointer;
        font-size: 11px;
    }
    .database-grouping-panel .grouping-result-actions {
        display: inline-flex;
        align-items: center;
        gap: 2px;
    }
    .database-grouping-panel .grouping-action-btn,
    .database-grouping-panel .grouping-sql-copy {
        border: 1px solid transparent;
        border-radius: 3px;
        padding: 2px 5px;
        background: transparent;
        color: var(--vscode-textLink-foreground);
        cursor: pointer;
        font-size: 10px;
        line-height: 16px;
    }
    .database-grouping-panel .grouping-action-btn:hover,
    .database-grouping-panel .grouping-sql-copy:hover {
        border-color: var(--vscode-panel-border);
        background: var(--vscode-list-hoverBackground);
    }
    .database-grouping-panel .grouping-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: auto;
        font-size: 11px;
    }
    .database-grouping-panel .grouping-grid-wrapper {
        min-height: 0;
        outline: none;
    }
    .database-grouping-panel .grouping-grid-wrapper:focus {
        box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
    }
    .database-grouping-panel .grouping-table th,
    .database-grouping-panel .grouping-table td {
        padding: 4px 6px;
        border: 1px solid var(--vscode-panel-border);
        text-align: left;
        white-space: nowrap;
    }
    .database-grouping-panel .grouping-table th {
        position: sticky;
        top: 0;
        background: var(--vscode-sideBar-background);
        z-index: 1;
    }
    .database-grouping-panel .grouping-select-column {
        width: 26px;
        min-width: 26px;
        padding: 3px !important;
        text-align: center !important;
    }
    .database-grouping-panel .grouping-sort-button {
        width: 100%;
        border: 0;
        padding: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: inherit;
        text-align: left;
        white-space: nowrap;
    }
    .database-grouping-panel .grouping-sort-button:hover {
        color: var(--vscode-textLink-foreground);
    }
    .database-grouping-panel .grouping-tanstack-table tbody tr {
        cursor: pointer;
    }
    .database-grouping-panel .grouping-tanstack-table tbody tr:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .database-grouping-panel .grouping-tanstack-table tbody tr.is-selected {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
    }
    .database-grouping-panel .pct-bar-container {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 90px;
    }
    .database-grouping-panel .pct-bar {
        height: 6px;
        background: var(--vscode-progressBar-background);
        border-radius: 3px;
    }
    .database-grouping-panel .grouping-results .no-results {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        text-align: center;
        padding: 20px;
    }
    .database-grouping-panel .grouping-results .grouping-query-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        gap: 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
    }
    .database-grouping-panel .grouping-progress-indicator {
        width: 18px;
        height: 18px;
        animation: grouping-spin 0.8s linear infinite;
    }
    .database-grouping-panel .grouping-progress-indicator circle {
        fill: none;
        stroke: var(--vscode-progressBar-background);
        stroke-width: 3;
        stroke-linecap: round;
        stroke-dasharray: 38 19;
    }
    @keyframes grouping-spin {
        to { transform: rotate(360deg); }
    }
    .database-grouping-panel .grouping-results .grouping-error {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 10px;
        margin: 4px;
        background: var(--vscode-inputValidation-errorBackground);
        border: 1px solid var(--vscode-inputValidation-errorBorder);
        border-radius: 3px;
        color: var(--vscode-errorForeground);
        font-size: 11px;
    }
    /* === Functions area inside grouping panel === */
    .database-grouping-panel .grouping-functions-area {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 4px 6px;
        border-bottom: 1px solid var(--vscode-panel-border);
        flex-shrink: 0;
    }
    .database-grouping-panel .grouping-functions-area .functions-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 0;
    }
    .database-grouping-panel .grouping-functions-area .function-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        flex: 1;
    }
    .database-grouping-panel .grouping-functions-area .function-chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 6px;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 3px;
        font-size: 10px;
        color: var(--vscode-foreground);
        cursor: default;
    }
    .database-grouping-panel .grouping-functions-area .function-chip .fn-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 12px;
        height: 12px;
        border: none;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 10px;
        opacity: 0.5;
        padding: 0;
    }
    .database-grouping-panel .grouping-functions-area .function-chip .fn-remove:hover {
        opacity: 1;
    }
    .database-grouping-panel .grouping-functions-area .add-function-btn {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 6px;
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 3px;
        background: transparent;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        font-size: 10px;
        transition: all 0.15s ease;
    }
    .database-grouping-panel .grouping-functions-area .add-function-btn:hover {
        border-color: var(--vscode-focusBorder);
        color: var(--vscode-foreground);
    }
    /* === Function configuration popup === */
    .grouping-fn-config-popup {
        position: fixed;
        z-index: 10001;
        background: var(--vscode-dropdown-background);
        border: 1px solid var(--vscode-dropdown-border);
        border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        padding: 10px;
        min-width: 200px;
        max-width: 280px;
    }
    .grouping-fn-config-popup .config-title {
        font-size: 12px;
        font-weight: 600;
        margin-bottom: 8px;
        color: var(--vscode-foreground);
    }
    .grouping-fn-config-popup .config-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 6px;
    }
    .grouping-fn-config-popup .config-row label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        min-width: 60px;
    }
    .grouping-fn-config-popup .config-row select,
    .grouping-fn-config-popup .config-row input {
        flex: 1;
        padding: 3px 6px;
        border: 1px solid var(--vscode-dropdown-border);
        border-radius: 2px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        font-size: 11px;
    }
    .grouping-fn-config-popup .config-actions {
        display: flex;
        gap: 4px;
        justify-content: flex-end;
        margin-top: 8px;
    }
    .grouping-fn-config-popup .config-actions button {
        padding: 4px 10px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 3px;
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
        font-size: 11px;
    }
    .grouping-fn-config-popup .config-actions button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: var(--vscode-button-background);
    }
    .grouping-fn-config-popup .config-actions button.primary:hover {
        background: var(--vscode-button-hoverBackground);
    }
    /* === SQL Preview Modal === */
    .sql-preview-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        z-index: 20000;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: sql-preview-fadein 0.15s ease;
    }
    @keyframes sql-preview-fadein {
        from { opacity: 0; }
        to { opacity: 1; }
    }
    .sql-preview-modal {
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        width: 90%;
        max-width: 800px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        animation: sql-preview-slidein 0.2s ease;
    }
    @keyframes sql-preview-slidein {
        from { transform: translateY(-10px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
    }
    .sql-preview-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        border-bottom: 1px solid var(--vscode-panel-border);
        flex-shrink: 0;
    }
    .sql-preview-title {
        font-weight: 600;
        font-size: 13px;
        color: var(--vscode-editor-foreground);
    }
    .sql-preview-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
        font-size: 16px;
        transition: background 0.15s ease;
    }
    .sql-preview-close:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .sql-preview-body {
        flex: 1;
        overflow: auto;
        padding: 12px 14px;
        min-height: 120px;
        max-height: 50vh;
    }
    .sql-preview-code {
        font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
        font-size: var(--vscode-editor-font-size, 12px);
        line-height: 1.5;
        color: var(--vscode-editor-foreground);
        white-space: pre;
        margin: 0;
        padding: 12px;
        background: var(--vscode-textCodeBlock-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        overflow-x: auto;
        -webkit-font-smoothing: auto;
    }
    .sql-preview-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        border-top: 1px solid var(--vscode-panel-border);
        flex-shrink: 0;
        gap: 12px;
    }
    .sql-preview-hint {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        flex: 1;
    }
    .sql-preview-actions {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
    }
    .sql-preview-actions button {
        padding: 6px 14px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        transition: all 0.15s ease;
    }
    .sql-preview-actions button:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .sql-preview-actions button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: var(--vscode-button-background);
    }
    .sql-preview-actions button.primary:hover {
        background: var(--vscode-button-hoverBackground);
    }
    /* === Column picker popup for grouping panel === */
    .grouping-add-column-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 5px 12px;
        margin-top: 6px;
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 4px;
        background: transparent;
        color: var(--vscode-textLink-foreground);
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        transition: all 0.15s ease;
    }
    .grouping-add-column-btn:hover {
        background: var(--vscode-list-hoverBackground);
        border-color: var(--vscode-focusBorder);
        color: var(--vscode-foreground);
    }
    .grouping-col-picker-popup {
        position: fixed;
        z-index: 10002;
        background: var(--vscode-dropdown-background);
        border: 1px solid var(--vscode-dropdown-border);
        border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        padding: 8px;
        min-width: 180px;
        max-width: 260px;
    }
    .grouping-col-picker-popup .grouping-col-picker-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 5px 8px;
        cursor: pointer;
        border-radius: 3px;
        font-size: 11px;
        gap: 8px;
    }
    .grouping-col-picker-popup .grouping-col-picker-item .col-name {
        color: var(--vscode-foreground);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .grouping-col-picker-popup .grouping-col-picker-item .col-type {
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
        flex-shrink: 0;
        opacity: 0.7;
    }
    .grouping-col-picker-popup .config-actions button {
        padding: 4px 10px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 3px;
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
        font-size: 11px;
    }
    .grouping-col-picker-popup .grouping-col-picker-list {
        max-height: 200px;
        overflow-y: auto;
    }
    .grouping-col-picker-msg {
        position: fixed;
        z-index: 10002;
        background: var(--vscode-dropdown-background);
        border: 1px solid var(--vscode-dropdown-border);
        border-radius: 4px;
        padding: 8px 12px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .grouping-col-picker-popup .config-actions button:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .result-panel-right-bar {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        padding: 4px;
        background: var(--vscode-sideBar-background);
        width: 36px;
        flex-shrink: 0;
    }
    .result-panel-right-bar .bar-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 4px;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
        transition: all 0.15s ease;
        position: relative;
    }
    .result-panel-right-bar .bar-btn:hover {
        background: var(--vscode-list-hoverBackground);
        border-color: var(--vscode-panel-border);
    }
    .result-panel-right-bar .bar-btn.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    .result-panel-right-bar .bar-btn svg {
        width: 16px;
        height: 16px;
    }
    .result-panel-right-bar .bar-btn .tooltip {
        position: absolute;
        right: calc(100% + 8px);
        top: 50%;
        transform: translateY(-50%);
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-editorWidget-border);
        color: var(--vscode-editorWidget-foreground);
        padding: 4px 8px;
        border-radius: 3px;
        font-size: 11px;
        white-space: nowrap;
        display: none;
        z-index: 100;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }
    .result-panel-right-bar .bar-btn:hover .tooltip {
        display: block;
    }
`;
    document.head.appendChild(style);
}
