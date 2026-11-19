import { clearExploreRowRequests, fetchExploreRows, handleExploreRowWindow } from '../resultPanel/explore/rows.js';
import { postHostMessage } from '../resultPanel/protocol.js';

jest.mock('../resultPanel/protocol.js', () => ({ postHostMessage: jest.fn() }));

describe('Explore disk sample bridge', () => {
    afterEach(() => clearExploreRowRequests());

    it('requests an unfiltered page and resolves only its own response', async () => {
        const sample = fetchExploreRows('file:///disk.sql', 0, 0, 500_000);
        const request = jest.mocked(postHostMessage).mock.calls.at(-1)![0] as { requestId: number; command: string; querySpec?: unknown };
        expect(request.command).toBe('requestRows');
        expect(request).not.toHaveProperty('querySpec');
        expect(handleExploreRowWindow({ requestId: request.requestId, rows: [['unfiltered']] })).toBe(true);
        await expect(sample).resolves.toEqual([['unfiltered']]);
    });

    it('does not claim responses that belong to the shared grid', () => {
        expect(handleExploreRowWindow({ requestId: 123, rows: [['grid']] })).toBe(false);
    });
});
