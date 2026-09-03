export interface StreamingSequenceEnvelope {
    resultSetId?: string;
    chunkSequence?: number;
    fromRow?: number;
    totalRows?: number;
    isFirstChunk?: boolean;
}

export interface StreamingSequenceBaseline {
    resultSetId?: string;
    totalRows: number;
}

export type StreamingSequenceDecision =
    | { kind: 'apply' }
    | { kind: 'duplicate' }
    | { kind: 'stale' }
    | { kind: 'desync'; reason: 'missing-chunk' | 'out-of-order-chunk' | 'missing-stream' };

interface StreamingCursor {
    resultSetId: string;
    nextSequence: number;
    nextRow: number;
    desynchronized: boolean;
    terminal: boolean;
}

function isSequenceEnvelopeComplete(
    envelope: StreamingSequenceEnvelope,
): envelope is Required<Pick<StreamingSequenceEnvelope, 'resultSetId' | 'chunkSequence' | 'fromRow' | 'totalRows'>>
    & StreamingSequenceEnvelope {
    return typeof envelope.resultSetId === 'string'
        && envelope.resultSetId.length > 0
        && Number.isInteger(envelope.chunkSequence)
        && (envelope.chunkSequence ?? -1) >= 0
        && Number.isInteger(envelope.fromRow)
        && (envelope.fromRow ?? -1) >= 0
        && Number.isInteger(envelope.totalRows)
        && (envelope.totalRows ?? -1) >= 0;
}

/**
 * Tracks the authoritative ordering of streamed Result Panel messages.
 * Messages without sequence metadata use the legacy path and are accepted.
 */
export class StreamingSequenceTracker {
    private readonly cursors = new Map<string, StreamingCursor>();

    evaluate(
        sourceUri: string | undefined,
        envelope: StreamingSequenceEnvelope,
        baseline?: StreamingSequenceBaseline,
    ): StreamingSequenceDecision {
        if (!sourceUri || !isSequenceEnvelopeComplete(envelope)) {
            return { kind: 'apply' };
        }

        let cursor = this.cursors.get(sourceUri);
        if (envelope.isFirstChunk === true) {
            if (
                cursor
                && cursor.resultSetId === envelope.resultSetId
                && envelope.chunkSequence < cursor.nextSequence
            ) {
                return { kind: 'duplicate' };
            }
            if (envelope.chunkSequence !== 0 || envelope.fromRow !== 0) {
                return this.markDesynchronized(sourceUri, envelope, 'missing-stream');
            }
            cursor = {
                resultSetId: envelope.resultSetId,
                nextSequence: 0,
                nextRow: 0,
                desynchronized: false,
                terminal: false,
            };
            this.cursors.set(sourceUri, cursor);
        } else if (!cursor) {
            if (
                baseline?.resultSetId === envelope.resultSetId
                && baseline.totalRows === envelope.fromRow
            ) {
                cursor = {
                    resultSetId: envelope.resultSetId,
                    nextSequence: envelope.chunkSequence,
                    nextRow: envelope.fromRow,
                    desynchronized: false,
                    terminal: false,
                };
                this.cursors.set(sourceUri, cursor);
            } else {
                return this.markDesynchronized(sourceUri, envelope, 'missing-stream');
            }
        }

        if (cursor.resultSetId !== envelope.resultSetId || cursor.terminal) {
            return { kind: 'stale' };
        }
        if (cursor.desynchronized) {
            return { kind: 'stale' };
        }
        if (envelope.chunkSequence < cursor.nextSequence) {
            return { kind: 'duplicate' };
        }
        if (envelope.chunkSequence > cursor.nextSequence) {
            return this.markDesynchronized(sourceUri, envelope, 'out-of-order-chunk');
        }
        if (envelope.fromRow < cursor.nextRow) {
            return envelope.totalRows <= cursor.nextRow
                ? { kind: 'duplicate' }
                : this.markDesynchronized(sourceUri, envelope, 'out-of-order-chunk');
        }
        if (envelope.fromRow > cursor.nextRow) {
            return this.markDesynchronized(sourceUri, envelope, 'missing-chunk');
        }
        if (envelope.totalRows < envelope.fromRow) {
            return this.markDesynchronized(sourceUri, envelope, 'out-of-order-chunk');
        }

        cursor.nextSequence += 1;
        cursor.nextRow = envelope.totalRows;
        return { kind: 'apply' };
    }

    complete(
        sourceUri: string | undefined,
        resultSetId: string | undefined,
        lastChunkSequence: number | undefined,
    ): StreamingSequenceDecision {
        if (!sourceUri || !resultSetId) {
            return { kind: 'apply' };
        }
        const sequenceOmitted = lastChunkSequence === undefined;
        const hasValidSequence = Number.isInteger(lastChunkSequence)
            && (lastChunkSequence ?? -1) >= 0;
        const cursor = this.cursors.get(sourceUri);
        if (!cursor) {
            if (sequenceOmitted) {
                // A partially upgraded host may send a stable result identity
                // while its append messages remain legacy/unsequenced. Accept
                // that terminal marker and remember it for deduplication.
                this.cursors.set(sourceUri, {
                    resultSetId,
                    nextSequence: 0,
                    nextRow: 0,
                    desynchronized: false,
                    terminal: true,
                });
                return { kind: 'apply' };
            }
            return { kind: 'stale' };
        }
        if (cursor.resultSetId !== resultSetId) {
            return { kind: 'stale' };
        }
        if (cursor.terminal) {
            return { kind: 'duplicate' };
        }
        if (cursor.desynchronized) {
            return { kind: 'stale' };
        }
        if (sequenceOmitted) {
            // Preserve compatibility with hosts which have started sending a
            // result identity but do not yet include the terminal sequence.
            // Once accepted, a repeated terminal message is still harmless.
            cursor.terminal = true;
            return { kind: 'apply' };
        }
        if (!hasValidSequence) {
            return { kind: 'stale' };
        }
        const completedSequence = lastChunkSequence as number;
        if (completedSequence < cursor.nextSequence - 1) {
            return { kind: 'duplicate' };
        }
        if (completedSequence > cursor.nextSequence - 1) {
            return this.markDesynchronized(
                sourceUri,
                { resultSetId, chunkSequence: completedSequence, fromRow: cursor.nextRow, totalRows: cursor.nextRow },
                'missing-chunk',
            );
        }
        cursor.terminal = true;
        return { kind: 'apply' };
    }

    reset(sourceUri?: string): void {
        if (sourceUri) {
            this.cursors.delete(sourceUri);
            return;
        }
        this.cursors.clear();
    }

    private markDesynchronized(
        sourceUri: string,
        envelope: Required<Pick<StreamingSequenceEnvelope, 'resultSetId'>> & StreamingSequenceEnvelope,
        reason: 'missing-chunk' | 'out-of-order-chunk' | 'missing-stream',
    ): StreamingSequenceDecision {
        const existing = this.cursors.get(sourceUri);
        this.cursors.set(sourceUri, {
            resultSetId: envelope.resultSetId,
            nextSequence: existing?.nextSequence ?? 0,
            nextRow: existing?.nextRow ?? 0,
            desynchronized: true,
            terminal: false,
        });
        return { kind: 'desync', reason };
    }
}
