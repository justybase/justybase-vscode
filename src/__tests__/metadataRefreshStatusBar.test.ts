import * as vscode from 'vscode';
import {
    createMetadataRefreshStatusBar,
    updateMetadataRefreshStatusBar
} from '../services/statusBarManager';
import type { MetadataPrefetchProgress } from '../metadata/prefetch';

jest.mock('vscode');

describe('Metadata Refresh Status Bar', () => {
    let mockContext: vscode.ExtensionContext;
    let mockStatusBarItem: vscode.StatusBarItem;

    beforeEach(() => {
        jest.clearAllMocks();

        mockStatusBarItem = {
            text: '',
            tooltip: '',
            show: jest.fn(),
            hide: jest.fn()
        } as unknown as vscode.StatusBarItem;

        mockContext = {
            subscriptions: []
        } as unknown as vscode.ExtensionContext;

        (vscode.window.createStatusBarItem as jest.Mock).mockReturnValue(mockStatusBarItem);
    });

    it('creates metadata status bar as hidden by default', () => {
        const item = createMetadataRefreshStatusBar(mockContext);

        expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(vscode.StatusBarAlignment.Right, 97);
        expect(item.tooltip).toBe('Metadata refresh progress');
        expect(item.hide).toHaveBeenCalled();
        expect(mockContext.subscriptions).toContain(item);
    });

    it('shows spinner text for in-progress refresh', () => {
        const progress: MetadataPrefetchProgress = {
            connectionName: 'DEV',
            stage: 'schemas',
            percent: 37,
            message: 'Fetching schemas (3/8)'
        };

        updateMetadataRefreshStatusBar(mockStatusBarItem, progress);

        expect(mockStatusBarItem.text).toBe('$(sync~spin) Metadata refresh 37%');
        expect(mockStatusBarItem.tooltip).toBe('Connection: DEV\nFetching schemas (3/8)');
        expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it('shows completion text for finished refresh', () => {
        const progress: MetadataPrefetchProgress = {
            connectionName: 'DEV',
            stage: 'complete',
            percent: 100,
            message: 'Metadata refresh complete'
        };

        updateMetadataRefreshStatusBar(mockStatusBarItem, progress);

        expect(mockStatusBarItem.text).toBe('$(check) Metadata ready 100%');
    });

    it('hides item when progress is null', () => {
        updateMetadataRefreshStatusBar(mockStatusBarItem, null);
        expect(mockStatusBarItem.hide).toHaveBeenCalled();
    });
});
