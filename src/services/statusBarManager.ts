/**
 * Status Bar Manager - manages VS Code status bar items for Netezza extension
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import type { MetadataPrefetchProgress } from '../metadata/prefetch';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';

function getActiveSqlAuthoringEditor(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && isSqlAuthoringLanguageId(editor.document.languageId)) {
        return editor;
    }
    return undefined;
}

/**
 * Update "Keep Connection Open" status bar item (per-document)
 */
export function updateKeepConnectionStatusBar(
    statusBarItem: vscode.StatusBarItem,
    connectionManager: ConnectionManager
): void {
    const editor = getActiveSqlAuthoringEditor();

    if (editor) {
        const documentUri = editor.document.uri.toString();
        const isEnabled = connectionManager.getDocumentKeepConnectionOpen(documentUri);
        const isPerDocument = connectionManager.hasDocumentKeepConnectionOpen(documentUri);
        
        const prefix = isPerDocument ? '📌 ' : '';
        statusBarItem.text = isEnabled ? `${prefix}🔗 Keep ON` : `${prefix}⛓️‍💥 Keep OFF`;
        statusBarItem.tooltip = isEnabled
            ? `Keep Connection: ENABLED${isPerDocument ? ' (custom)' : ' (default)'} - Click to toggle`
            : `Keep Connection: DISABLED${isPerDocument ? ' (custom)' : ''} - Click to toggle`;
        statusBarItem.backgroundColor = isEnabled ? new vscode.ThemeColor('statusBarItem.prominentBackground') : undefined;
        statusBarItem.show();
    } else {
        statusBarItem.hide();
    }
}

/**
 * Create and configure the "Keep Connection Open" status bar item
 */
export function createKeepConnectionStatusBar(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager
): vscode.StatusBarItem {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'netezza.toggleKeepConnectionForTab';
    updateKeepConnectionStatusBar(statusBarItem, connectionManager);
    context.subscriptions.push(statusBarItem);
    return statusBarItem;
}

/**
 * Create and configure the "Active Connection" status bar item (per-tab)
 */
export function createActiveConnectionStatusBar(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager
): { statusBarItem: vscode.StatusBarItem; updateFn: () => void } {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'netezza.selectConnectionForTab';
    statusBarItem.tooltip = 'Click to select connection for this SQL tab';
    context.subscriptions.push(statusBarItem);

    const updateFn = () => {
        const editor = getActiveSqlAuthoringEditor();
        if (editor) {
            const documentUri = editor.document.uri.toString();
            const connectionName = connectionManager.getConnectionForExecution(documentUri);
            if (connectionName) {
                statusBarItem.text = `$(database) ${connectionName}`;
                statusBarItem.show();
            } else {
                statusBarItem.text = '$(database) Select Connection';
                statusBarItem.show();
            }
        } else {
            statusBarItem.hide();
        }
    };

    return { statusBarItem, updateFn };
}

/**
 * Create and configure the "Active Database" status bar item (per-tab)
 */
export function createActiveDatabaseStatusBar(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager
): { statusBarItem: vscode.StatusBarItem; updateFn: () => Promise<void> } {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    statusBarItem.command = 'netezza.selectDatabaseForTab';
    statusBarItem.tooltip = 'Click to select database for this SQL tab (will reconnect)';
    context.subscriptions.push(statusBarItem);

    const updateFn = async () => {
        const editor = getActiveSqlAuthoringEditor();
        if (!editor) {
            statusBarItem.hide();
            return;
        }

        const documentUri = editor.document.uri.toString();
        const connectionName = connectionManager.getConnectionForExecution(documentUri);

        if (connectionName) {
            const effectiveDb = await connectionManager.getEffectiveDatabase(documentUri);

            const currentEditor = getActiveSqlAuthoringEditor();
            if (!currentEditor || currentEditor.document.uri.toString() !== documentUri) {
                return;
            }

            const hasOverride = connectionManager.getDocumentDatabase(documentUri) !== undefined;

            if (effectiveDb) {
                const prefix = hasOverride ? '📌 ' : '';
                statusBarItem.text = `${prefix}$(server) ${effectiveDb}`;
                statusBarItem.tooltip = hasOverride
                    ? `Database: ${effectiveDb} (custom for this tab) - Click to change`
                    : `Database: ${effectiveDb} (from connection) - Click to change`;
                statusBarItem.show();
            } else {
                statusBarItem.text = '$(server) Select Database';
                statusBarItem.show();
            }
        } else {
            statusBarItem.hide();
        }
    };

    return { statusBarItem, updateFn };
}

/**
 * Create and configure the "Selection Statistics" status bar item for results panel
 */
export function createSelectionStatsStatusBar(
    context: vscode.ExtensionContext
): vscode.StatusBarItem {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    statusBarItem.text = '';
    statusBarItem.tooltip = 'Selection statistics';
    statusBarItem.hide();
    context.subscriptions.push(statusBarItem);
    return statusBarItem;
}

/**
 * Create and configure a subtle metadata refresh status item.
 * This appears only while metadata cache is being rebuilt.
 */
export function createMetadataRefreshStatusBar(
    context: vscode.ExtensionContext
): vscode.StatusBarItem {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
    statusBarItem.tooltip = 'Metadata refresh progress';
    statusBarItem.hide();
    context.subscriptions.push(statusBarItem);
    return statusBarItem;
}

/**
 * Update metadata refresh status bar item based on prefetch progress events.
 */
export function updateMetadataRefreshStatusBar(
    statusBarItem: vscode.StatusBarItem,
    progress?: MetadataPrefetchProgress | null
): void {
    if (!progress) {
        statusBarItem.hide();
        return;
    }

    const prefix = progress.stage === 'error' ? '$(warning)' : progress.stage === 'complete' ? '$(check)' : '$(sync~spin)';
    const percent = `${Math.max(0, Math.min(100, Math.round(progress.percent)))}%`;
    const stageText = progress.stage === 'complete'
        ? 'Metadata ready'
        : progress.stage === 'error'
            ? 'Metadata refresh failed'
            : 'Metadata refresh';

    statusBarItem.text = `${prefix} ${stageText} ${percent}`;
    statusBarItem.tooltip = `Connection: ${progress.connectionName}\n${progress.message}`;
    statusBarItem.show();
}

/**
 * Format number with space as thousands separator
 */
function formatNumber(num: number): string {
    return num.toLocaleString('en-US').replace(/,/g, ' ');
}

/**
 * Update the "Selection Statistics" status bar item with cell statistics
 */
export function updateSelectionStatsStatusBar(
    statusBarItem: vscode.StatusBarItem,
    stats?: { cellCount: number; type: 'numeric' | 'date' | 'text' | 'mixed'; count?: number; distinctCount?: number; sum?: number; min?: string | number; max?: string | number } | { state: 'calculating' } | null
): void {
    if (stats && 'state' in stats) {
        statusBarItem.text = '$(sync~spin) Calculating…';
        statusBarItem.tooltip = 'Calculating selection statistics';
        statusBarItem.show();
        return;
    }
    if (!stats || stats.cellCount === 0) {
        statusBarItem.hide();
        return;
    }

    let text = '';
    const tooltipParts: string[] = [`Selection: ${formatNumber(stats.cellCount)} cells`];

    switch (stats.type) {
        case 'numeric':
            text = `Σ=${formatNumber(stats.sum!)} Count=${formatNumber(stats.count!)} Distinct=${formatNumber(stats.distinctCount!)} Min=${stats.min} Max=${stats.max}`;
            tooltipParts.push(`Sum: ${formatNumber(stats.sum!)}`, `Count: ${formatNumber(stats.count!)}`, `Distinct: ${formatNumber(stats.distinctCount!)}`, `Min: ${stats.min}`, `Max: ${stats.max}`);
            break;
        case 'date':
            text = `Count=${formatNumber(stats.count!)} Distinct=${formatNumber(stats.distinctCount!)} Min=${stats.min} Max=${stats.max}`;
            tooltipParts.push(`Count: ${formatNumber(stats.count!)}`, `Distinct: ${formatNumber(stats.distinctCount!)}`, `Min: ${stats.min}`, `Max: ${stats.max}`);
            break;
        case 'text':
            text = `Count=${formatNumber(stats.count!)} Distinct=${formatNumber(stats.distinctCount!)}`;
            tooltipParts.push(`Count: ${formatNumber(stats.count!)}`, `Distinct: ${formatNumber(stats.distinctCount!)}`);
            break;
        case 'mixed':
            text = `#${formatNumber(stats.count!)} Distinct=${formatNumber(stats.distinctCount!)}`;
            tooltipParts.push(`Mixed data types`, `Count: ${formatNumber(stats.count!)}`, `Distinct: ${formatNumber(stats.distinctCount!)}`);
            break;
    }

    statusBarItem.text = text;
    statusBarItem.tooltip = tooltipParts.join('\n');
    statusBarItem.show();
}
