const mockPostHostMessage = jest.fn();

jest.mock('../../media/resultPanel/protocol.js', () => ({
    postHostMessage: mockPostHostMessage,
}));

const mockGetActiveSourceUri = jest.fn(() => 'file:///active.sql');
const mockGetActiveGridIndex = jest.fn(() => 0);

jest.mock('../../media/resultPanel/state.js', () => ({
    getActiveGridIndex: mockGetActiveGridIndex,
}));

jest.mock('../../media/resultPanel/types.js', () => ({
    getActiveSourceUri: mockGetActiveSourceUri,
}));

import {
    applyDatabaseFilter,
    clearAllDatabaseFilterPending,
    discardAllDatabaseFilterPending,
    handleDatabaseFilterApplyResult,
    handleDatabaseFilterValuesResult,
    queryDatabaseFilterValues,
} from '../../media/resultPanel/databaseFilters';
import {
    clearAllDatabaseAggregationPending,
    clearDatabaseAggregationError,
    discardAllDatabaseAggregationPending,
    getDatabaseAggregationError,
    handleDatabaseAggregationResult,
    queryDatabaseAggregations,
} from '../../media/resultPanel/databaseAggregations';
import {
    formatAllRowsOperationError,
    showInlineErrorWithRetry,
} from '../../media/resultPanel/inlineErrorRetry';

function getLastRequestId(): number {
    const calls = mockPostHostMessage.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as { requestId?: number } | undefined;
    if (!lastCall?.requestId) {
        throw new Error('Expected postHostMessage call with requestId');
    }
    return lastCall.requestId;
}

describe('result panel all rows timeout UX', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetActiveSourceUri.mockReturnValue('file:///active.sql');
        mockGetActiveGridIndex.mockReturnValue(0);
    });

    afterEach(() => {
        discardAllDatabaseFilterPending();
        discardAllDatabaseAggregationPending();
    });

    it('posts requestDatabaseFilterValues with requestId', async () => {
        const pending = queryDatabaseFilterValues('file:///active.sql', 0, 2);
        const requestId = getLastRequestId();
        expect(mockPostHostMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'requestDatabaseFilterValues',
            requestId,
            columnIndex: 2,
        }));

        handleDatabaseFilterValuesResult({
            requestId,
            sourceUri: 'file:///active.sql',
            resultSetIndex: 0,
            columnIndex: 2,
            values: [{ raw: 5, count: 1 }],
            truncated: false,
        });

        await expect(pending).resolves.toEqual({
            values: [{ raw: 5, count: 1 }],
            truncated: false,
        });
    });

    it('posts first filter values request with short default timeout', () => {
        queryDatabaseFilterValues('file:///active.sql', 0, 2);
        expect(mockPostHostMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'requestDatabaseFilterValues',
            timeoutSeconds: 5,
            isRetry: false,
        }));
    });

    it('posts retry filter values request with isRetry and 30s timeout override', async () => {
        const pending = queryDatabaseFilterValues('file:///active.sql', 0, 2, undefined, { isRetry: true });
        const requestId = getLastRequestId();
        expect(mockPostHostMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'requestDatabaseFilterValues',
            requestId,
            timeoutSeconds: 30,
            isRetry: true,
        }));

        handleDatabaseFilterValuesResult({
            requestId,
            sourceUri: 'file:///active.sql',
            resultSetIndex: 0,
            columnIndex: 2,
            values: [],
            truncated: false,
        });

        await expect(pending).resolves.toEqual({ values: [], truncated: false });
    });

    it('shows inline error with retry for filter values failures', () => {
        const originalDocument = global.document;
        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                createElement: jest.fn((tagName: string) => {
                    const children: unknown[] = [];
                    const element = {
                        tagName,
                        textContent: '',
                        onclick: null as (() => void) | null,
                        appendChild: jest.fn((child: unknown) => {
                            children.push(child);
                        }),
                        querySelector: jest.fn((selector: string) => {
                            if (selector !== 'button') {
                                return null;
                            }
                            return children.find((child) => (
                                child as { tagName?: string }
                            ).tagName === 'button') ?? null;
                        }),
                        style: {} as Record<string, string>,
                    };
                    return element;
                }),
            },
        });

        try {
            const container = {
                replaceChildren: jest.fn(),
                appendChild: jest.fn(),
            } as unknown as HTMLElement;
            const onRetry = jest.fn();

            showInlineErrorWithRetry(container, new Error('Query timeout'), onRetry);

            expect(container.replaceChildren).toHaveBeenCalled();
            const wrapper = (container.appendChild as jest.Mock).mock.calls[0][0] as {
                querySelector: (selector: string) => { onclick: ((event: MouseEvent) => void) | null } | null;
            };
            const retryBtn = wrapper.querySelector('button');
            expect(retryBtn).not.toBeNull();
            const event = {
                stopPropagation: jest.fn(),
                preventDefault: jest.fn(),
            } as unknown as MouseEvent;
            retryBtn?.onclick?.(event);
            expect(event.stopPropagation).toHaveBeenCalled();
            expect(event.preventDefault).toHaveBeenCalled();
            expect(onRetry).toHaveBeenCalled();
        } finally {
            Object.defineProperty(global, 'document', {
                configurable: true,
                writable: true,
                value: originalDocument,
            });
        }
    });

    it('prefixes timeout errors in inline messaging', () => {
        expect(formatAllRowsOperationError(new Error('command timeout expired'))).toContain('Timed out:');
    });

    it('resolves applyDatabaseFilter when host reports success', async () => {
        const pending = applyDatabaseFilter('file:///active.sql', 0, undefined);
        const requestId = getLastRequestId();
        expect(mockPostHostMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'applyDatabaseFilter',
            requestId,
        }));

        handleDatabaseFilterApplyResult({
            requestId,
            sourceUri: 'file:///active.sql',
            resultSetIndex: 0,
        });

        await expect(pending).resolves.toBeUndefined();
    });

    it('rejects applyDatabaseFilter when host reports error', async () => {
        const pending = applyDatabaseFilter('file:///active.sql', 0, undefined);
        const requestId = getLastRequestId();

        handleDatabaseFilterApplyResult({
            requestId,
            sourceUri: 'file:///active.sql',
            resultSetIndex: 0,
            error: 'Timed out after 10s',
        });

        await expect(pending).rejects.toThrow('Timed out after 10s');
    });

    it('rejects stale filter values responses after source switch', async () => {
        const pending = queryDatabaseFilterValues('file:///active.sql', 0, 2);
        const requestId = getLastRequestId();
        mockGetActiveSourceUri.mockReturnValue('file:///other.sql');

        handleDatabaseFilterValuesResult({
            requestId,
            sourceUri: 'file:///active.sql',
            resultSetIndex: 0,
            columnIndex: 2,
            values: [{ raw: 5, count: 1 }],
            truncated: false,
        });

        await expect(pending).rejects.toThrow('Request superseded');
    });

    it('rejects stale applyDatabaseFilter responses after source switch', async () => {
        const pending = applyDatabaseFilter('file:///active.sql', 0, undefined);
        const requestId = getLastRequestId();
        mockGetActiveSourceUri.mockReturnValue('file:///other.sql');

        handleDatabaseFilterApplyResult({
            requestId,
            sourceUri: 'file:///active.sql',
            resultSetIndex: 0,
        });

        await expect(pending).rejects.toThrow('Request superseded');
    });

    it('rejects filter values requests when client watchdog expires', async () => {
        jest.useFakeTimers();
        try {
            const pending = queryDatabaseFilterValues(
                'file:///active.sql',
                0,
                2,
                undefined,
                { timeoutSeconds: 5 },
            );

            jest.advanceTimersByTime(7_500);

            await expect(pending).rejects.toThrow(/Timed out/i);
        } finally {
            jest.useRealTimers();
        }
    });

    it('rejects applyDatabaseFilter requests when client watchdog expires', async () => {
        jest.useFakeTimers();
        try {
            const pending = applyDatabaseFilter(
                'file:///active.sql',
                0,
                undefined,
                { timeoutSeconds: 10 },
            );

            jest.advanceTimersByTime(12_500);

            await expect(pending).rejects.toThrow(/Timed out/i);
        } finally {
            jest.useRealTimers();
        }
    });

    it('rejects stale aggregation responses after source switch', async () => {
        const pending = queryDatabaseAggregations(
            'file:///active.sql',
            0,
            [{ columnIndex: 1, fn: 'sum' }],
            { aggregationKey: 'agg-key-1' },
        );
        const requestId = getLastRequestId();
        mockGetActiveSourceUri.mockReturnValue('file:///other.sql');

        handleDatabaseAggregationResult({
            requestId,
            sourceUri: 'file:///active.sql',
            resultSetIndex: 0,
            aggregations: [{ columnIndex: 1, fn: 'sum', value: 42 }],
        });

        await expect(pending).rejects.toThrow('Request superseded');
    });

    it('rejects aggregation requests when client watchdog expires', async () => {
        jest.useFakeTimers();
        try {
            const pending = queryDatabaseAggregations(
                'file:///active.sql',
                0,
                [{ columnIndex: 1, fn: 'sum' }],
                { aggregationKey: 'agg-key-watchdog', timeoutSeconds: 8 },
            );

            jest.advanceTimersByTime(10_000);

            await expect(pending).rejects.toThrow(/Timed out/i);
            expect(getDatabaseAggregationError('agg-key-watchdog')).toMatch(/Timed out/i);
        } finally {
            jest.useRealTimers();
        }
    });

    it('remembers host aggregation errors by aggregation key', async () => {
        const pending = queryDatabaseAggregations(
            'file:///active.sql',
            0,
            [{ columnIndex: 1, fn: 'sum' }],
            { aggregationKey: 'agg-key-host-error' },
        );
        const requestId = getLastRequestId();

        handleDatabaseAggregationResult({
            requestId,
            sourceUri: 'file:///active.sql',
            resultSetIndex: 0,
            error: 'Error: Command execution timeout',
        });

        await expect(pending).rejects.toThrow('Command execution timeout');
        expect(getDatabaseAggregationError('agg-key-host-error')).toContain('timeout');
        clearDatabaseAggregationError('agg-key-host-error');
        expect(getDatabaseAggregationError('agg-key-host-error')).toBeUndefined();
    });

    it('clears pending filter and aggregation requests on cleanup', async () => {
        const valuesPending = queryDatabaseFilterValues('file:///active.sql', 0, 1);
        const applyPending = applyDatabaseFilter('file:///active.sql', 0, undefined);
        const aggPending = queryDatabaseAggregations('file:///active.sql', 0, [{ columnIndex: 0, fn: 'count' }]);

        clearAllDatabaseFilterPending('cancelled');
        clearAllDatabaseAggregationPending('cancelled');

        await expect(valuesPending).rejects.toThrow('cancelled');
        await expect(applyPending).rejects.toThrow('cancelled');
        await expect(aggPending).rejects.toThrow('cancelled');
    });
});
