/**
 * Status Bar Manager - manages VS Code status bar items for Netezza extension
 *
 * Connection / database / keep-connection state is rendered by the single
 * connection capsule (see ./connectionCapsule); this module keeps the
 * result-panel selection stats and metadata refresh items.
 */

import * as vscode from 'vscode';
import type { MetadataPrefetchProgress } from '../metadata/prefetch';

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
    statusBarItem.command = 'netezza.showMetadataRefreshDetails';
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
