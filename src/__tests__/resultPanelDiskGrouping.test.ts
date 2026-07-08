import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const queryDiskGroups = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const createVirtualizer = jest.fn();
const render = jest.fn();

jest.mock('../../media/resultPanel/diskBackedGrid.js', () => ({
    DISK_WINDOW_ROWS: 2_000,
    queryDiskGroups: (...args: unknown[]) => queryDiskGroups(...args),
}));

jest.mock('../../media/resultPanel/state.js', () => ({
    getGrid: jest.fn(() => ({ createVirtualizer, render })),
}));

describe('diskGrouping webview cache', () => {
    beforeEach(() => {
        jest.resetModules();
        queryDiskGroups.mockReset();
        createVirtualizer.mockReset();
        render.mockReset();
    });

    it('loads SQLite grouping through disk group queries and clears when grouping is disabled', async () => {
        queryDiskGroups.mockResolvedValueOnce({
            kind: 'groups',
            path: [],
            depth: 0,
            totalCount: 2,
            groups: [
                {
                    kind: 'group',
                    columnIndex: 1,
                    depth: 0,
                    value: 'EU',
                    count: 2,
                    path: [{ columnIndex: 1, value: 'EU' }],
                    hasChildren: true,
                },
            ],
        });

        const diskGrouping = require('../../media/resultPanel/diskGrouping.js');
        diskGrouping.refreshDiskGrouping(0, ['1']);

        expect(diskGrouping.getDiskGroupingRows(0)).toEqual([{ kind: 'loading', depth: 0 }]);
        await Promise.resolve();

        expect(queryDiskGroups).toHaveBeenCalledWith(
            0,
            [{ columnIndex: 1 }],
            [],
            0,
            2_000,
            [],
        );
        expect(diskGrouping.getDiskGroupingRows(0)).toEqual([
            {
                kind: 'group',
                group: expect.objectContaining({
                    columnIndex: 1,
                    value: 'EU',
                    count: 2,
                }),
            },
        ]);
        expect(createVirtualizer).toHaveBeenCalled();
        expect(render).toHaveBeenCalled();

        diskGrouping.refreshDiskGrouping(0, []);
        expect(diskGrouping.getDiskGroupingRows(0)).toEqual([]);
    });

    it('expands a group by loading children with parent path', async () => {
        const parentGroup = {
            kind: 'group',
            columnIndex: 1,
            depth: 0,
            value: 'EU',
            count: 2,
            path: [{ columnIndex: 1, value: 'EU' }],
            hasChildren: true,
        };
        queryDiskGroups
            .mockResolvedValueOnce({
                kind: 'groups',
                path: [],
                depth: 0,
                totalCount: 1,
                groups: [parentGroup],
            })
            .mockResolvedValueOnce({
                kind: 'leafRows',
                path: parentGroup.path,
                depth: 1,
                totalCount: 1,
                rows: [[1, 'EU']],
            });

        const diskGrouping = require('../../media/resultPanel/diskGrouping.js');
        diskGrouping.refreshDiskGrouping(0, ['1']);
        await Promise.resolve();
        diskGrouping.toggleDiskGroupRow(0, parentGroup);
        await Promise.resolve();

        expect(queryDiskGroups).toHaveBeenLastCalledWith(
            0,
            [{ columnIndex: 1 }],
            parentGroup.path,
            0,
            2_000,
            [],
        );
        expect(diskGrouping.getDiskGroupingRows(0)).toEqual([
            { kind: 'group', group: parentGroup },
            {
                kind: 'leaf',
                row: [1, 'EU'],
                depth: 1,
                path: parentGroup.path,
            },
        ]);
    });

    it('adds a footer row when expanded group includes aggregations', async () => {
        const parentGroup = {
            kind: 'group',
            columnIndex: 1,
            depth: 0,
            value: 'EU',
            count: 2,
            path: [{ columnIndex: 1, value: 'EU' }],
            hasChildren: true,
            aggregations: [{ columnIndex: 2, fn: 'sum', value: 30 }],
        };
        queryDiskGroups
            .mockResolvedValueOnce({
                kind: 'groups',
                path: [],
                depth: 0,
                totalCount: 1,
                groups: [parentGroup],
            })
            .mockResolvedValueOnce({
                kind: 'leafRows',
                path: parentGroup.path,
                depth: 1,
                totalCount: 1,
                rows: [[1, 'EU', 30]],
            });

        const diskGrouping = require('../../media/resultPanel/diskGrouping.js');
        diskGrouping.refreshDiskGrouping(0, ['1'], [{ columnIndex: 2, fn: 'sum' }]);
        await Promise.resolve();
        diskGrouping.toggleDiskGroupRow(0, parentGroup);
        await Promise.resolve();

        expect(queryDiskGroups).toHaveBeenCalledWith(
            0,
            [{ columnIndex: 1 }],
            [],
            0,
            2_000,
            [{ columnIndex: 2, fn: 'sum' }],
        );
        expect(diskGrouping.getDiskGroupingRows(0)).toEqual([
            { kind: 'group', group: parentGroup },
            {
                kind: 'leaf',
                row: [1, 'EU', 30],
                depth: 1,
                path: parentGroup.path,
            },
            {
                kind: 'footer',
                group: parentGroup,
                aggregations: [{ columnIndex: 2, fn: 'sum', value: 30 }],
            },
        ]);
    });

    it('restores persisted expanded keys by loading child paths', async () => {
        const parentGroup = {
            kind: 'group',
            columnIndex: 1,
            depth: 0,
            value: 'EU',
            count: 2,
            path: [{ columnIndex: 1, value: 'EU' }],
            hasChildren: true,
        };
        const expandedKey = JSON.stringify([[1, 'EU']]);
        queryDiskGroups
            .mockResolvedValueOnce({
                kind: 'groups',
                path: [],
                depth: 0,
                totalCount: 1,
                groups: [parentGroup],
            })
            .mockResolvedValueOnce({
                kind: 'leafRows',
                path: parentGroup.path,
                depth: 1,
                totalCount: 1,
                rows: [[1, 'EU']],
            });

        const diskGrouping = require('../../media/resultPanel/diskGrouping.js');
        diskGrouping.refreshDiskGrouping(0, ['1']);
        await Promise.resolve();
        diskGrouping.restoreDiskGroupingExpandedKeys(0, [expandedKey]);
        await Promise.resolve();

        expect(queryDiskGroups).toHaveBeenLastCalledWith(
            0,
            [{ columnIndex: 1 }],
            parentGroup.path,
            0,
            2_000,
            [],
        );
        expect(diskGrouping.getDiskGroupingRows(0)).toEqual([
            { kind: 'group', group: parentGroup },
            {
                kind: 'leaf',
                row: [1, 'EU'],
                depth: 1,
                path: parentGroup.path,
            },
        ]);
    });

    it('loads the next root group page only when scrolled near the last loaded root group', async () => {
        const rootGroups = Array.from({ length: 600 }, (_, index) => ({
            kind: 'group',
            columnIndex: 1,
            depth: 0,
            value: `G${index}`,
            count: 1,
            path: [{ columnIndex: 1, value: `G${index}` }],
            hasChildren: true,
        }));
        queryDiskGroups.mockResolvedValueOnce({
            kind: 'groups',
            path: [],
            depth: 0,
            totalCount: 1200,
            groups: rootGroups,
        });

        const diskGrouping = require('../../media/resultPanel/diskGrouping.js');
        diskGrouping.refreshDiskGrouping(0, ['1']);
        await Promise.resolve();
        expect(queryDiskGroups).toHaveBeenCalledTimes(1);

        diskGrouping.ensureDiskGroupingPagesLoaded(0, 0, 10);
        expect(queryDiskGroups).toHaveBeenCalledTimes(1);

        queryDiskGroups.mockResolvedValueOnce({
            kind: 'groups',
            path: [],
            depth: 0,
            totalCount: 1200,
            groups: [{
                kind: 'group',
                columnIndex: 1,
                depth: 0,
                value: 'G600',
                count: 1,
                path: [{ columnIndex: 1, value: 'G600' }],
                hasChildren: true,
            }],
        });
        diskGrouping.ensureDiskGroupingPagesLoaded(0, 0, 599);
        await Promise.resolve();
        expect(queryDiskGroups).toHaveBeenCalledTimes(2);
        expect(queryDiskGroups).toHaveBeenLastCalledWith(
            0,
            [{ columnIndex: 1 }],
            [],
            600,
            2_000,
            [],
        );
    });

    it('loads the next expanded leaf page before sibling root groups when there is no footer', async () => {
        const groupA = {
            kind: 'group',
            columnIndex: 1,
            depth: 0,
            value: 'EU',
            count: 1200,
            path: [{ columnIndex: 1, value: 'EU' }],
            hasChildren: true,
        };
        const groupB = {
            kind: 'group',
            columnIndex: 1,
            depth: 0,
            value: 'US',
            count: 1,
            path: [{ columnIndex: 1, value: 'US' }],
            hasChildren: true,
        };
        const groupC = {
            kind: 'group',
            columnIndex: 1,
            depth: 0,
            value: 'APAC',
            count: 1,
            path: [{ columnIndex: 1, value: 'APAC' }],
            hasChildren: true,
        };
        const leafRows = Array.from({ length: 600 }, (_, index) => [index + 1, 'EU']);

        queryDiskGroups
            .mockResolvedValueOnce({
                kind: 'groups',
                path: [],
                depth: 0,
                totalCount: 3,
                groups: [groupA, groupB, groupC],
            })
            .mockResolvedValueOnce({
                kind: 'leafRows',
                path: groupA.path,
                depth: 1,
                totalCount: 1200,
                rows: leafRows,
            });

        const diskGrouping = require('../../media/resultPanel/diskGrouping.js');
        diskGrouping.refreshDiskGrouping(0, ['1']);
        await Promise.resolve();
        diskGrouping.toggleDiskGroupRow(0, groupA);
        await Promise.resolve();
        expect(queryDiskGroups).toHaveBeenCalledTimes(2);

        diskGrouping.ensureDiskGroupingPagesLoaded(0, 0, 549);
        expect(queryDiskGroups).toHaveBeenCalledTimes(2);

        queryDiskGroups.mockResolvedValueOnce({
            kind: 'leafRows',
            path: groupA.path,
            depth: 1,
            totalCount: 1200,
            rows: [[601, 'EU']],
        });
        diskGrouping.ensureDiskGroupingPagesLoaded(0, 0, 550);
        await Promise.resolve();

        expect(queryDiskGroups).toHaveBeenCalledTimes(3);
        expect(queryDiskGroups).toHaveBeenLastCalledWith(
            0,
            [{ columnIndex: 1 }],
            groupA.path,
            600,
            2_000,
            [],
        );
    });
});
