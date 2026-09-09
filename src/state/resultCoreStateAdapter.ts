import {
    createEmptyResultPanelState,
    reduceResultPanelState,
    type PinnedResultState,
    type ResultPanelEvent,
    type ResultPanelState,
    type ResultSetInput,
    type ResultSetState,
    type SourceState,
} from '@justybase/result-core';
import type { ResultSet } from '../types';

export interface ResultCorePinSnapshot {
    resultId: string;
    sourceId: string;
    resultSetIndex: number;
    timestamp: number;
    label: string;
    automatic: boolean;
}

/**
 * Desktop boundary for the platform-neutral result reducer.
 *
 * The manager still owns the rich ResultSet objects and disk resources. This
 * adapter owns the structural projection used to validate lifecycle and
 * identity transitions. The projection is rebuilt from the authoritative
 * manager data before every transition, so legacy storage fields cannot leak
 * into result-core.
 */
export class ResultCoreStateAdapter {
    private _state: ResultPanelState = createEmptyResultPanelState();

    public get state(): ResultPanelState {
        return this._state;
    }

    public syncSource(
        sourceId: string,
        resultSets: readonly ResultSet[],
        pins: readonly ResultCorePinSnapshot[],
        activeResultSetIndex: number,
        isExecuting: boolean,
        executionId?: string,
    ): void {
        const previous = this._state.sources.get(sourceId);
        const coreResultSets = resultSets.map(resultSet => resultSetToCoreState(sourceId, executionId, resultSet));
        const sourceState = {
            sourceId,
            resultSets: coreResultSets,
            activeResultSetIndex,
            activeResultSetId: coreResultSets[activeResultSetIndex]?.resultSetId,
            isExecuting,
            executionId,
            executionEpoch: previous?.executionEpoch ?? 0,
        };
        const sourcePins: PinnedResultState[] = pins
            .filter(pin => pin.sourceId === sourceId)
            .flatMap(pin => {
                const resultSet = resultSets[pin.resultSetIndex];
                if (!resultSet) return [];
                return [{
                    sourceId,
                    resultSetId: coreResultSetId(resultSet),
                    resultSetIndex: pin.resultSetIndex,
                    timestamp: pin.timestamp,
                    label: pin.label,
                    automatic: pin.automatic,
                }];
            });
        this._state = {
            sources: new Map(this._state.sources).set(sourceId, sourceState),
            activeSourceId: this._state.activeSourceId,
            pinnedResults: [
                ...this._state.pinnedResults.filter(pin => pin.sourceId !== sourceId),
                ...sourcePins,
            ],
        };
    }

    public apply(event: ResultPanelEvent): ResultPanelState {
        this._state = reduceResultPanelState(this._state, event);
        return this._state;
    }

    public getSource(sourceId: string): SourceState | undefined {
        return this._state.sources.get(sourceId);
    }

    public getResultSetIndex(sourceId: string, resultSetId: string): number {
        return this._state.sources.get(sourceId)?.resultSets.findIndex(resultSet => resultSet.resultSetId === resultSetId) ?? -1;
    }
}

function coreResultSetId(resultSet: ResultSet): string {
    return resultSet.resultSetId ?? `legacy-result-${resultSet.executionTimestamp ?? 0}`;
}

function resultSetToCoreState(sourceId: string, executionId: string | undefined, resultSet: ResultSet): ResultSetState {
    const data = resultSet.data ?? [];
    const totalRowCount = resultSet.totalRowCount ?? data.length;
    const loadedRowCount = resultSet.storageMode === 'sqlite' ? totalRowCount : data.length;
    return {
        resultSetId: coreResultSetId(resultSet),
        sourceId,
        executionId,
        columns: resultSet.columns.map(column => ({ name: column.name, type: column.type, scale: column.scale })),
        // ResultStateManager remains the owner of row buffers and disk stores.
        // The shared projection carries counts only, avoiding a second copy of
        // a potentially very large result in the lifecycle state model.
        data: [],
        totalRowCount,
        loadedRowCount,
        statementIndex: resultSet.statementIndex,
        storageSessionId: resultSet.storageSessionId ?? resultSet.diskStoreId,
        status: resultSet.isCancelled ? 'cancelled' : resultSet.isError ? 'error' : resultSet.isLog ? 'streaming' : data.length === 0 && totalRowCount === 0 ? 'empty' : 'complete',
        limitReached: resultSet.limitReached === true,
        isCancelled: resultSet.isCancelled,
        lastChunkSequence: resultSet.lastChunkSequence,
        isLog: resultSet.isLog === true,
    } satisfies ResultSetState;
}

export function resultSetToCoreInput(sourceId: string, executionId: string | undefined, resultSet: ResultSet): ResultSetInput {
    const data = resultSet.data ?? [];
    const totalRowCount = resultSet.totalRowCount ?? data.length;
    const loadedRowCount = resultSet.storageMode === 'sqlite' ? totalRowCount : data.length;
    return {
        resultSetId: coreResultSetId(resultSet),
        sourceId,
        executionId,
        columns: resultSet.columns.map(column => ({ name: column.name, type: column.type, scale: column.scale })),
        data: [],
        totalRowCount,
        loadedRowCount,
        statementIndex: resultSet.statementIndex,
        storageSessionId: resultSet.storageSessionId ?? resultSet.diskStoreId,
        status: resultSet.isCancelled ? 'cancelled' : resultSet.isError ? 'error' : data.length === 0 && totalRowCount === 0 ? 'empty' : 'complete',
        limitReached: resultSet.limitReached === true,
        isCancelled: resultSet.isCancelled,
        lastChunkSequence: resultSet.lastChunkSequence,
    };
}
