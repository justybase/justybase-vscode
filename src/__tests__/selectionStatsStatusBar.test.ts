import { createSelectionStatsStatusBar, updateSelectionStatsStatusBar } from '../services/statusBarManager';
import * as vscode from 'vscode';

jest.mock('vscode');

describe('Selection Stats Status Bar', () => {
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

    describe('createSelectionStatsStatusBar', () => {
        it('should create a status bar item with correct configuration', () => {
            const result = createSelectionStatsStatusBar(mockContext);

            expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
                vscode.StatusBarAlignment.Right,
                98
            );
            expect(result.text).toBe('');
            expect(result.tooltip).toBe('Selection statistics');
            expect(result.hide).toHaveBeenCalled();
            expect(mockContext.subscriptions).toContain(result);
        });
    });

    describe('updateSelectionStatsStatusBar', () => {
        it('should hide status bar when stats are null', () => {
            updateSelectionStatsStatusBar(mockStatusBarItem, null);

            expect(mockStatusBarItem.hide).toHaveBeenCalled();
        });

        it('should hide status bar when cell count is 0', () => {
            const stats = { cellCount: 0, type: 'mixed' as const, count: 0, distinctCount: 0 };

            updateSelectionStatsStatusBar(mockStatusBarItem, stats);

            expect(mockStatusBarItem.hide).toHaveBeenCalled();
        });

        it('should hide status bar when cell count exceeds 100', () => {
            const stats = { cellCount: 101, type: 'mixed' as const, count: 101, distinctCount: 101 };

            updateSelectionStatsStatusBar(mockStatusBarItem, stats);

            expect(mockStatusBarItem.hide).toHaveBeenCalled();
        });

        it('should show status bar with numeric stats when all cells are numeric', () => {
            const stats = { cellCount: 3, type: 'numeric' as const, count: 3, distinctCount: 3, sum: 150, min: 10, max: 100 };

            updateSelectionStatsStatusBar(mockStatusBarItem, stats);

            expect(mockStatusBarItem.text).toBe('Σ=150 Count=3 Distinct=3 Min=10 Max=100');
            expect(mockStatusBarItem.tooltip).toBe('Selection: 3 cells\nSum: 150\nCount: 3\nDistinct: 3\nMin: 10\nMax: 100');
            expect(mockStatusBarItem.show).toHaveBeenCalled();
        });

        it('should show status bar with date stats when all cells are dates', () => {
            const stats = { cellCount: 3, type: 'date' as const, count: 3, distinctCount: 3, min: '2023-01-01', max: '2023-12-31' };

            updateSelectionStatsStatusBar(mockStatusBarItem, stats);

            expect(mockStatusBarItem.text).toBe('Count=3 Distinct=3 Min=2023-01-01 Max=2023-12-31');
            expect(mockStatusBarItem.tooltip).toBe('Selection: 3 cells\nCount: 3\nDistinct: 3\nMin: 2023-01-01\nMax: 2023-12-31');
            expect(mockStatusBarItem.show).toHaveBeenCalled();
        });

        it('should show status bar with text stats when all cells are text', () => {
            const stats = { cellCount: 3, type: 'text' as const, count: 3, distinctCount: 2 };

            updateSelectionStatsStatusBar(mockStatusBarItem, stats);

            expect(mockStatusBarItem.text).toBe('Count=3 Distinct=2');
            expect(mockStatusBarItem.tooltip).toBe('Selection: 3 cells\nCount: 3\nDistinct: 2');
            expect(mockStatusBarItem.show).toHaveBeenCalled();
        });

        it('should show status bar with mixed data type stats', () => {
            const stats = { cellCount: 5, type: 'mixed' as const, count: 5, distinctCount: 5 };

            updateSelectionStatsStatusBar(mockStatusBarItem, stats);

            expect(mockStatusBarItem.text).toBe('#5 Distinct=5');
            expect(mockStatusBarItem.tooltip).toBe('Selection: 5 cells\nMixed data types\nCount: 5\nDistinct: 5');
            expect(mockStatusBarItem.show).toHaveBeenCalled();
        });

        it('should handle negative numeric values correctly', () => {
            const stats = { cellCount: 2, type: 'numeric' as const, count: 2, distinctCount: 2, sum: -50, min: -100, max: 50 };

            updateSelectionStatsStatusBar(mockStatusBarItem, stats);

            expect(mockStatusBarItem.text).toBe('Σ=-50 Count=2 Distinct=2 Min=-100 Max=50');
            expect(mockStatusBarItem.tooltip).toBe('Selection: 2 cells\nSum: -50\nCount: 2\nDistinct: 2\nMin: -100\nMax: 50');
        });

        it('should handle decimal numeric values correctly', () => {
            const stats = { cellCount: 3, type: 'numeric' as const, count: 3, distinctCount: 3, sum: 15.5, min: 2.1, max: 8.9 };

            updateSelectionStatsStatusBar(mockStatusBarItem, stats);

            expect(mockStatusBarItem.text).toBe('Σ=15.5 Count=3 Distinct=3 Min=2.1 Max=8.9');
            expect(mockStatusBarItem.tooltip).toBe('Selection: 3 cells\nSum: 15.5\nCount: 3\nDistinct: 3\nMin: 2.1\nMax: 8.9');
        });
    });
});
