import { StreamingSequenceTracker } from '../../media/resultPanel/streamingSequence';

describe('StreamingSequenceTracker', () => {
    const sourceUri = 'file:///stream.sql';

    function chunk(
        sequence: number,
        fromRow: number,
        totalRows: number,
        resultSetId = 'result-1',
        isFirstChunk = sequence === 0,
    ) {
        return {
            resultSetId,
            chunkSequence: sequence,
            fromRow,
            totalRows,
            isFirstChunk,
        };
    }

    it('applies an ordered stream and its matching terminal message', () => {
        const tracker = new StreamingSequenceTracker();

        expect(tracker.evaluate(sourceUri, chunk(0, 0, 2))).toEqual({ kind: 'apply' });
        expect(tracker.evaluate(sourceUri, chunk(1, 2, 4))).toEqual({ kind: 'apply' });
        expect(tracker.complete(sourceUri, 'result-1', 1)).toEqual({ kind: 'apply' });
    });

    it('ignores duplicate and delayed chunks without advancing the cursor', () => {
        const tracker = new StreamingSequenceTracker();

        expect(tracker.evaluate(sourceUri, chunk(0, 0, 2))).toEqual({ kind: 'apply' });
        expect(tracker.evaluate(sourceUri, chunk(0, 0, 2, 'result-1', false))).toEqual({ kind: 'duplicate' });
        expect(tracker.evaluate(sourceUri, chunk(1, 2, 4))).toEqual({ kind: 'apply' });
        expect(tracker.evaluate(sourceUri, chunk(0, 0, 2, 'older-result', false))).toEqual({ kind: 'stale' });
    });

    it('marks a missing or out-of-order chunk as desynchronized once', () => {
        const tracker = new StreamingSequenceTracker();

        expect(tracker.evaluate(sourceUri, chunk(0, 0, 2))).toEqual({ kind: 'apply' });
        expect(tracker.evaluate(sourceUri, chunk(2, 4, 6))).toEqual({
            kind: 'desync',
            reason: 'out-of-order-chunk',
        });
        expect(tracker.evaluate(sourceUri, chunk(1, 2, 4))).toEqual({ kind: 'stale' });
        expect(tracker.complete(sourceUri, 'result-1', 2)).toEqual({ kind: 'stale' });
    });

    it('rebases after hydrate when the authoritative row count matches fromRow', () => {
        const tracker = new StreamingSequenceTracker();

        expect(tracker.evaluate(
            sourceUri,
            chunk(7, 12, 14, 'result-1', false),
            { resultSetId: 'result-1', totalRows: 12 },
        )).toEqual({ kind: 'apply' });
        expect(tracker.evaluate(sourceUri, chunk(8, 14, 16, 'result-1', false))).toEqual({ kind: 'apply' });
    });

    it('rejects a completion that proves an unseen chunk exists', () => {
        const tracker = new StreamingSequenceTracker();

        expect(tracker.evaluate(sourceUri, chunk(0, 0, 2))).toEqual({ kind: 'apply' });
        expect(tracker.complete(sourceUri, 'result-1', 2)).toEqual({
            kind: 'desync',
            reason: 'missing-chunk',
        });
    });

    it('treats a repeated terminal completion as a duplicate', () => {
        const tracker = new StreamingSequenceTracker();

        expect(tracker.evaluate(sourceUri, chunk(0, 0, 2))).toEqual({ kind: 'apply' });
        expect(tracker.complete(sourceUri, 'result-1', 0)).toEqual({ kind: 'apply' });
        expect(tracker.complete(sourceUri, 'result-1', 0)).toEqual({ kind: 'duplicate' });
    });

    it('deduplicates identity-only terminal completions after accepting them', () => {
        const tracker = new StreamingSequenceTracker();

        expect(tracker.evaluate(sourceUri, chunk(0, 0, 2))).toEqual({ kind: 'apply' });
        expect(tracker.complete(sourceUri, 'result-1', undefined)).toEqual({ kind: 'apply' });
        expect(tracker.complete(sourceUri, 'result-1', undefined)).toEqual({ kind: 'duplicate' });
    });

    it('accepts identity-only completion when legacy appends left no cursor', () => {
        const tracker = new StreamingSequenceTracker();

        expect(tracker.complete(sourceUri, 'legacy-result', undefined)).toEqual({ kind: 'apply' });
        expect(tracker.complete(sourceUri, 'legacy-result', undefined)).toEqual({ kind: 'duplicate' });
    });

    it('rejects an invalid terminal sequence when identity-only compatibility does not apply', () => {
        const tracker = new StreamingSequenceTracker();

        expect(tracker.complete(sourceUri, 'result-1', -1)).toEqual({ kind: 'stale' });
        expect(tracker.complete(sourceUri, 'result-1', undefined)).toEqual({ kind: 'apply' });
    });

    it('keeps legacy unsequenced messages compatible', () => {
        const tracker = new StreamingSequenceTracker();

        expect(tracker.evaluate(sourceUri, { totalRows: 2 })).toEqual({ kind: 'apply' });
        expect(tracker.complete(sourceUri, undefined, undefined)).toEqual({ kind: 'apply' });
    });
});
