import { ResultStateManager } from '../state/resultStateManager';
import { ResultSet } from '../types';

// Mock logger
jest.mock('../utils/logger', () => ({
    getLogger: jest.fn().mockReturnValue({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    })
}));

// Mock vscode with working EventEmitter
jest.mock(
    'vscode',
    () => ({
        EventEmitter: jest.fn().mockImplementation(() => {
            const listeners: Array<(data: unknown) => void> = [];
            return {
                event: jest.fn().mockImplementation((callback: (data: unknown) => void) => {
                    listeners.push(callback);
                    return { dispose: jest.fn() };
                }),
                fire: jest.fn().mockImplementation((data: unknown) => {
                    listeners.forEach(callback => callback(data));
                })
            };
        }),
        workspace: {
            getConfiguration: jest.fn().mockImplementation((section: string) => {
                if (section === 'netezza.results') {
                    return {
                        get: jest.fn().mockImplementation((key: string, defaultValue: unknown) => {
                            if (key === 'maxDataResults') return 50;
                            if (key === 'maxPinnedDataResults') return 10;
                            return defaultValue;
                        })
                    };
                }
                return {
                    get: jest.fn().mockReturnValue(undefined)
                };
            })
        },
        window: {
            showInformationMessage: jest.fn(),
            showWarningMessage: jest.fn().mockResolvedValue(undefined)
        }
    }),
    { virtual: true }
);

describe('ResultStateManager', () => {
    let manager: ResultStateManager;

    beforeEach(() => {
        manager = new ResultStateManager();
    });

    afterEach(() => {
        manager.disposeAllDiskStores();
        manager.dispose();
    });

    function isNodeSqliteAvailable(): boolean {
        try {
             
            require('node:sqlite');
            return true;
        } catch {
            return false;
        }
    }

    describe('onDidCancel event', () => {
        it('should emit cancel event when cancelExecution is called', () => {
            const mockListener = jest.fn();
            const disposable = manager.onDidCancel(mockListener);

            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.cancelExecution(sourceUri);

            expect(mockListener).toHaveBeenCalledTimes(1);
            expect(mockListener).toHaveBeenCalledWith(sourceUri);

            disposable.dispose();
        });

        it('should emit cancel event with row counts when provided', () => {
            const mockListener = jest.fn();
            const disposable = manager.onDidCancel(mockListener);

            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.cancelExecution(sourceUri, [100, 50]);

            expect(mockListener).toHaveBeenCalledWith(sourceUri);

            disposable.dispose();
        });
    });

    describe('setActiveSource', () => {
        it('should set active source for valid URI', () => {
            const sourceUri = 'file:///test.sql';
            const result = manager.setActiveSource(sourceUri);

            expect(result).toBe(true);
            expect(manager.activeSourceUri).toBe(sourceUri);
        });

        it('should reject invalid URI schemes', () => {
            expect(manager.setActiveSource('vscode-chat-code-block://test')).toBe(false);
            expect(manager.setActiveSource('output://test')).toBe(false);
            expect(manager.activeSourceUri).toBeUndefined();
        });

        it('should return false if source already active', () => {
            const sourceUri = 'file:///test.sql';
            manager.setActiveSource(sourceUri);
            const result = manager.setActiveSource(sourceUri);

            expect(result).toBe(false);
        });
    });

    describe('startExecution', () => {
        it('should create log result set for new execution', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            const results = manager.resultsMap.get(sourceUri);
            expect(results).toHaveLength(1);
            expect(results![0].isLog).toBe(true);
            expect(results![0].name).toBe('Logs');
        });

        it('should append to existing log on subsequent executions', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            const initialLength = manager.resultsMap.get(sourceUri)![0].data.length;

            manager.startExecution(sourceUri);
            const newLength = manager.resultsMap.get(sourceUri)![0].data.length;

            expect(newLength).toBeGreaterThan(initialLength);
        });

        it('should add source to executing sources', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            expect(manager.executingSources.has(sourceUri)).toBe(true);
        });

        it('should auto-pin the source', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            expect(manager.pinnedSources.has(sourceUri)).toBe(true);
        });

        it('should reset to Logs and bump data version for a new execution', () => {
            const sourceUri = 'file:///test.sql';

            manager.startExecution(sourceUri);
            const initialVersion = manager.getDataVersion(sourceUri);

            manager.setActiveResultSetIndex(sourceUri, 3);
            manager.startExecution(sourceUri);

            expect(manager.getActiveResultSetIndex(sourceUri)).toBe(0);
            expect(manager.getDataVersion(sourceUri)).toBeGreaterThan(initialVersion);
        });

        it('should remove unpinned error results when a new execution starts', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.updateResults(
                [{
                    columns: [],
                    data: [],
                    message: 'Syntax error',
                    isError: true,
                    sql: 'SELECT * FORM test',
                }],
                sourceUri,
            );
            manager.finalizeExecution(sourceUri);

            const { clearedUnpinnedResults } = manager.startExecution(sourceUri);
            expect(clearedUnpinnedResults).toBe(true);

            const results = manager.resultsMap.get(sourceUri) ?? [];
            expect(results.some(resultSet => resultSet.isError)).toBe(false);
            expect(results.filter(resultSet => !resultSet.isLog)).toHaveLength(0);
        });

        it('should report clearedUnpinnedResults false when only logs remain before re-run', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.finalizeExecution(sourceUri);

            const { clearedUnpinnedResults } = manager.startExecution(sourceUri);
            expect(clearedUnpinnedResults).toBe(false);
        });

        it('should keep manually pinned results when a new execution starts', () => {
            const sourceUri = 'file:///test.sql';

            manager.startExecution(sourceUri);
            manager.updateResults(
                [{ columns: [{ name: 'a', type: 'int' }], data: [[1]], name: 'Result 1' }],
                sourceUri,
            );
            manager.finalizeExecution(sourceUri);
            manager.toggleResultPin(sourceUri, 1);

            manager.startExecution(sourceUri);
            manager.updateResults(
                [{ columns: [{ name: 'b', type: 'int' }], data: [[2]], name: 'Result 2' }],
                sourceUri,
            );
            manager.finalizeExecution(sourceUri);
            manager.toggleResultPin(sourceUri, 2);

            manager.startExecution(sourceUri);

            const dataResults = (manager.resultsMap.get(sourceUri) ?? []).filter(resultSet => !resultSet.isLog);
            expect(dataResults).toHaveLength(2);
            expect(dataResults[0]?.name).toBe('Result 1');
            expect(dataResults[1]?.name).toBe('Result 2');
        });
    });

    describe('log', () => {
        it('should append message to log result set', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            const initialLength = manager.resultsMap.get(sourceUri)![0].data.length;

            manager.log(sourceUri, 'Test message');
            const newLength = manager.resultsMap.get(sourceUri)![0].data.length;

            expect(newLength).toBe(initialLength + 1);
        });

        it('should do nothing if no results exist', () => {
            const sourceUri = 'file:///test.sql';
            // No startExecution called

            expect(() => manager.log(sourceUri, 'Test')).not.toThrow();
        });
    });

    describe('structured execution logging', () => {
        it('builds an authoritative log delta for gap recovery', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            const before = manager.resultsMap.get(sourceUri)![0].data.length;

            const start = manager.logExecutionStart(sourceUri, 'SELECT 1', 'conn1');
            manager.logExecutionEnd(start.id, 1, 'success');

            const delta = manager.getLogSyncUpdate(sourceUri, before);
            expect(delta).toEqual(expect.objectContaining({
                command: 'appendRows',
                sourceUri,
                fromRow: before,
                totalRows: before + 2,
                isLog: true,
            }));
            expect(delta?.rows).toHaveLength(2);
            expect(delta?.logExecutionTimestamp).toBeGreaterThan(0);
        });

        it('should append a structured retrying entry', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            const { id } = manager.logExecutionStart(sourceUri, 'SELECT 1', 'conn1');
            const update = manager.logExecutionEnd(
                id,
                0,
                'retrying',
                'Connection was closed by server. Reconnecting and retrying...'
            );

            const logResult = manager.resultsMap.get(sourceUri)![0];
            const lastMessage = logResult.data[logResult.data.length - 1][1] as string;

            expect(lastMessage).toContain('↻ RETRYING: SELECT 1 | conn1 | Connection was closed by server. Reconnecting and retrying...');
            expect(update?.rows[0][1]).toContain('↻ RETRYING');
            expect(manager.getExecutionLogs(sourceUri)[0].status).toBe('retrying');
        });

        it('should preserve error then retrying then success sequence for one execution', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            const { id } = manager.logExecutionStart(sourceUri, 'SELECT 1', 'conn1');
            manager.logExecutionEnd(id, 0, 'error', 'Connection lost');
            manager.logExecutionEnd(
                id,
                0,
                'retrying',
                'Connection was closed by server. Reconnecting and retrying...'
            );
            manager.logExecutionEnd(id, 3, 'success');

            const messages = manager.resultsMap
                .get(sourceUri)![0]
                .data
                .map(row => row[1] as string);

            expect(messages.some(message => message.includes('✗ ERROR: SELECT 1 | conn1'))).toBe(true);
            expect(messages.some(message => message.includes('↻ RETRYING: SELECT 1 | conn1 | Connection was closed by server. Reconnecting and retrying...'))).toBe(true);
            expect(messages.some(message => message.includes('✓ SUCCESS: SELECT 1 | conn1'))).toBe(true);
            expect(manager.getExecutionLogs(sourceUri)[0].status).toBe('success');
        });
    });

    describe('cancelExecution', () => {
        it('should mark source as cancelled', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            expect(manager.isCancelled(sourceUri)).toBe(false);
            manager.cancelExecution(sourceUri);
            expect(manager.isCancelled(sourceUri)).toBe(true);
        });

        it('should remove from executing sources', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            manager.cancelExecution(sourceUri);

            expect(manager.executingSources.has(sourceUri)).toBe(false);
        });

        it('should truncate data if row counts provided', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            // Add some mock data rows
            const rs = manager.resultsMap.get(sourceUri)![0];
            rs.data.push(['row1'], ['row2'], ['row3']);

            manager.cancelExecution(sourceUri, [2]); // Keep only 2 rows

            expect(rs.data.length).toBe(2);
        });
    });

    describe('finalizeExecution', () => {
        it('should remove source from executing sources', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            manager.finalizeExecution(sourceUri);

            expect(manager.executingSources.has(sourceUri)).toBe(false);
        });

        it('should unpin auto-pinned results', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            // Add results which will be auto-pinned
            const results: ResultSet[] = [
                {
                    columns: [{ name: 'id', type: 'int' }],
                    data: [[1]],
                    name: 'Result 1'
                } as ResultSet
            ];
            manager.updateResults(results, sourceUri);

            const pinnedCountWithResults = manager.pinnedResults.size;
            expect(pinnedCountWithResults).toBeGreaterThan(0); // Log + result

            manager.finalizeExecution(sourceUri);

            // After finalize, auto-pinned results should be removed (only log remains)
            expect(manager.pinnedResults.size).toBeLessThan(pinnedCountWithResults);
        });
    });

    describe('updateResults', () => {
        it('should add new result sets', () => {
            const sourceUri = 'file:///test.sql';
            const results: ResultSet[] = [
                {
                    columns: [{ name: 'id', type: 'int' }],
                    data: [[1], [2]],
                    name: 'Result 1'
                } as ResultSet
            ];

            manager.updateResults(results, sourceUri);

            expect(manager.resultsMap.get(sourceUri)).toHaveLength(1);
        });

        it('should auto-pin new results', () => {
            const sourceUri = 'file:///test.sql';
            const results: ResultSet[] = [
                {
                    columns: [{ name: 'id', type: 'int' }],
                    data: [[1]],
                    name: 'Result 1'
                } as ResultSet
            ];

            manager.updateResults(results, sourceUri);

            expect(manager.pinnedResults.size).toBeGreaterThan(0);
        });

        it('should set active source', () => {
            const sourceUri = 'file:///test.sql';
            const results: ResultSet[] = [
                {
                    columns: [{ name: 'id', type: 'int' }],
                    data: [[1]],
                    name: 'Result 1'
                } as ResultSet
            ];

            manager.updateResults(results, sourceUri);

            expect(manager.activeSourceUri).toBe(sourceUri);
        });

        it('should not switch active source when updating inactive source', () => {
            const activeSource = 'file:///active.sql';
            const backgroundSource = 'file:///background.sql';
            manager.setActiveSource(activeSource);

            manager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Background Result'
                    } as ResultSet
                ],
                backgroundSource
            );

            expect(manager.activeSourceUri).toBe(activeSource);
        });
    });

    describe('togglePin', () => {
        it('should pin unpinned source', () => {
            const sourceUri = 'file:///test.sql';
            manager.setActiveSource(sourceUri);

            manager.togglePin(sourceUri);

            expect(manager.pinnedSources.has(sourceUri)).toBe(true);
        });

        it('should unpin pinned source', () => {
            const sourceUri = 'file:///test.sql';
            manager.setActiveSource(sourceUri);
            manager.togglePin(sourceUri);

            manager.togglePin(sourceUri);

            expect(manager.pinnedSources.has(sourceUri)).toBe(false);
        });
    });

    describe('closeSource', () => {
        it('should remove source from results map', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            manager.closeSource(sourceUri);

            expect(manager.resultsMap.has(sourceUri)).toBe(false);
        });

        it('should switch to another source if closing active', () => {
            const uriA = 'file:///A.sql';
            const uriB = 'file:///B.sql';
            manager.startExecution(uriA);
            manager.startExecution(uriB);

            manager.closeSource(uriA);

            expect(manager.activeSourceUri).toBe(uriB);
        });

        it('should set active to undefined if no sources remain', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            manager.closeSource(sourceUri);

            expect(manager.activeSourceUri).toBeUndefined();
        });

        it('should increment global state version', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            const initialVersion = manager.globalStateVersion;

            manager.closeSource(sourceUri);

            expect(manager.globalStateVersion).toBe(initialVersion + 1);
        });
    });

    describe('closeResult', () => {
        it('should remove specific result set', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            const results: ResultSet[] = [
                {
                    columns: [{ name: 'id', type: 'int' }],
                    data: [[1]],
                    name: 'Result 1'
                } as ResultSet
            ];
            manager.updateResults(results, sourceUri);
            const initialCount = manager.resultsMap.get(sourceUri)!.length;

            manager.closeResult(sourceUri, 1); // Index 1 (after log)

            expect(manager.resultsMap.get(sourceUri)!.length).toBe(initialCount - 1);
        });
    });

    describe('clearLogs', () => {
        it('should clear log data', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.log(sourceUri, 'Test message');

            manager.clearLogs(sourceUri);

            const logResult = manager.resultsMap.get(sourceUri)!.find(r => r.isLog);
            expect(logResult!.data.length).toBe(1); // Only the "Logs Cleared" message
        });

        it('should mark source as stale when clearing logs after streaming completed', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.log(sourceUri, 'Streamed log entry');

            // Simulate that streaming has completed (no active execution)
            manager.finalizeExecution(sourceUri);
            manager.markStreamingCompleted(sourceUri);
            expect(manager.isStale(sourceUri)).toBe(false);

            manager.clearLogs(sourceUri);

            // clearLogs should force a full hydrate by marking the source as stale
            expect(manager.isStale(sourceUri)).toBe(true);

            // Log data should be cleared
            const logResult = manager.resultsMap.get(sourceUri)!.find(r => r.isLog);
            expect(logResult!.data.length).toBe(1);
            expect(logResult!.data[0][1]).toBe('--- Logs Cleared ---');
        });

        it('should not mark stale when called on source without log', () => {
            const sourceUri = 'file:///test.sql';
            // No startExecution — no log result set
            expect(manager.resultsMap.has(sourceUri)).toBe(false);

            manager.clearLogs(sourceUri);

            // Should not crash, and source should not be marked stale
            expect(manager.isStale(sourceUri)).toBe(false);
        });
    });

    describe('default disk-backed threshold', () => {
        const itIfSqlite = isNodeSqliteAvailable() ? it : it.skip;

        itIfSqlite('keeps rows below memoryRowThreshold in memory and spills at 25000', () => {
            const belowSourceUri = 'file:///below-default-threshold.sql';
            manager.startExecution(belowSourceUri);

            manager.appendStreamingChunk(belowSourceUri, {
                columns: [{ name: 'id', type: 'INTEGER' }],
                rows: [[1], [2]],
                isFirstChunk: true,
                isLastChunk: false,
                totalRowsSoFar: 24999,
                limitReached: false,
            }, 'SELECT * FROM t');

            const belowResult = manager.resultsMap.get(belowSourceUri)![1];
            expect(belowResult.storageMode).toBeUndefined();
            expect(belowResult.data).toEqual([[1], [2]]);

            const thresholdSourceUri = 'file:///at-default-threshold.sql';
            manager.startExecution(thresholdSourceUri);

            const result = manager.appendStreamingChunk(thresholdSourceUri, {
                columns: [{ name: 'id', type: 'INTEGER' }],
                rows: [[1], [2]],
                isFirstChunk: true,
                isLastChunk: false,
                totalRowsSoFar: 25000,
                limitReached: false,
            }, 'SELECT * FROM t');

            const thresholdResult = manager.resultsMap.get(thresholdSourceUri)![1];
            expect(result.type).toBe('diskBackedActivate');
            expect(thresholdResult.storageMode).toBe('sqlite');
            expect(thresholdResult.data).toHaveLength(0);
            expect(thresholdResult.totalRowCount).toBe(25000);
            expect(thresholdResult.diskStoreId).toBeDefined();
        });
    });

    describe('version management', () => {
        it('should track data versions per source', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            const initialVersion = manager.getDataVersion(sourceUri);

            manager.log(sourceUri, 'Test');

            expect(manager.getDataVersion(sourceUri)).toBeGreaterThan(initialVersion);
        });

        it('should track sent data versions', () => {
            const sourceUri = 'file:///test.sql';
            manager.setSentDataVersion(sourceUri, 5);

            expect(manager.getSentDataVersion(sourceUri)).toBe(5);
        });

        it('should track stale sources', () => {
            const sourceUri = 'file:///test.sql';
            manager.markStale(sourceUri);

            expect(manager.isStale(sourceUri)).toBe(true);

            manager.clearStale(sourceUri);

            expect(manager.isStale(sourceUri)).toBe(false);
        });

        it('should mark all sources as stale', () => {
            const uriA = 'file:///A.sql';
            const uriB = 'file:///B.sql';
            manager.startExecution(uriA);
            manager.startExecution(uriB);

            manager.markAllStale();

            expect(manager.isStale(uriA)).toBe(true);
            expect(manager.isStale(uriB)).toBe(true);
        });
    });

    describe('appendStreamingChunk', () => {
        it('should ignore chunks for cancelled sources', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.cancelExecution(sourceUri);

            const chunk = {
                columns: [{ name: 'id', type: 'int' }],
                rows: [[1], [2]],
                isFirstChunk: true,
                isLastChunk: false,
                totalRowsSoFar: 2,
                limitReached: false
            };

            const result = manager.appendStreamingChunk(sourceUri, chunk, 'SELECT * FROM test');

            expect(result.type).toBe('ignore');
        });

        it('should create new result set on first chunk', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            const chunk = {
                columns: [
                    { name: 'id', type: 'int' },
                    { name: 'name', type: 'string' }
                ],
                rows: [
                    [1, 'Alice'],
                    [2, 'Bob']
                ],
                isFirstChunk: true,
                isLastChunk: false,
                totalRowsSoFar: 2,
                limitReached: false
            };

            const result = manager.appendStreamingChunk(sourceUri, chunk, 'SELECT * FROM users');

            expect(result.type).toBe('incremental');
            if (result.type === 'incremental') {
                expect(result.props.isFirstChunk).toBe(true);
            }
            expect(manager.resultsMap.get(sourceUri)!.length).toBe(2); // log + new result

            const newResult = manager.resultsMap.get(sourceUri)![1];
            expect(newResult.columns).toHaveLength(2);
            expect(newResult.data).toHaveLength(2);
            expect(newResult.sql).toBe('SELECT * FROM users');
        });

        it('should append rows to existing result set', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            // First chunk
            const chunk1 = {
                columns: [{ name: 'id', type: 'int' }],
                rows: [[1], [2]],
                isFirstChunk: true,
                isLastChunk: false,
                totalRowsSoFar: 2,
                limitReached: false
            };
            manager.appendStreamingChunk(sourceUri, chunk1, 'SELECT * FROM test');

            // Second chunk
            const chunk2 = {
                columns: [{ name: 'id', type: 'int' }],
                rows: [[3], [4]],
                isFirstChunk: false,
                isLastChunk: false,
                totalRowsSoFar: 4,
                limitReached: false
            };
            const result = manager.appendStreamingChunk(sourceUri, chunk2, 'SELECT * FROM test');

            expect(result.type).toBe('incremental');
            expect(manager.resultsMap.get(sourceUri)![1].data.length).toBe(4);
        });

        it('should send combined limitReached in incremental appendRows messages', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            manager.appendStreamingChunk(sourceUri, {
                columns: [{ name: 'id', type: 'int' }],
                rows: [[1]],
                isFirstChunk: true,
                isLastChunk: false,
                totalRowsSoFar: 1,
                limitReached: true
            }, 'SELECT * FROM test');

            const result = manager.appendStreamingChunk(sourceUri, {
                columns: [{ name: 'id', type: 'int' }],
                rows: [[2]],
                isFirstChunk: false,
                isLastChunk: false,
                totalRowsSoFar: 2,
                limitReached: false
            }, 'SELECT * FROM test');

            expect(result.type).toBe('incremental');
            if (result.type === 'incremental') {
                expect(result.props.limitReached).toBe(true);
            }
            expect(manager.resultsMap.get(sourceUri)![1].limitReached).toBe(true);
        });

        it('should auto-pin streaming results', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            const initialPinnedCount = manager.pinnedResults.size;

            const chunk = {
                columns: [{ name: 'id', type: 'int' }],
                rows: [[1]],
                isFirstChunk: true,
                isLastChunk: true,
                totalRowsSoFar: 1,
                limitReached: false
            };
            manager.appendStreamingChunk(sourceUri, chunk, 'SELECT 1');

            expect(manager.pinnedResults.size).toBe(initialPinnedCount + 1);
        });

        it('should create an empty result set for zero-row final chunks', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            const chunk = {
                columns: [{ name: 'id', type: 'int' }],
                rows: [],
                isFirstChunk: true,
                isLastChunk: true,
                totalRowsSoFar: 0,
                limitReached: false
            };

            const result = manager.appendStreamingChunk(sourceUri, chunk, 'SELECT * FROM empty_result');

            expect(result.type).toBe('incremental');
            if (result.type === 'incremental') {
                expect(result.props.isFirstChunk).toBe(true);
            }
            expect(manager.resultsMap.get(sourceUri)).toHaveLength(2);
            expect(manager.resultsMap.get(sourceUri)![1]).toEqual(
                expect.objectContaining({
                    columns: [{ name: 'id', type: 'int' }],
                    data: [],
                    sql: 'SELECT * FROM empty_result',
                    limitReached: false
                })
            );
        });

        it('should switch to streaming result tab during execution and set active source', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            const chunk = {
                columns: [{ name: 'id', type: 'int' }],
                rows: [[1]],
                isFirstChunk: true,
                isLastChunk: true,
                totalRowsSoFar: 1,
                limitReached: false
            };
            manager.appendStreamingChunk(sourceUri, chunk, 'SELECT 1');

            expect(manager.activeSourceUri).toBe(sourceUri);
            expect(manager.getActiveResultSetIndex(sourceUri)).toBe(1);

            manager.finalizeExecution(sourceUri);
            expect(manager.getActiveResultSetIndex(sourceUri)).toBe(1);
        });

        it('should not switch active source when background chunk arrives', () => {
            const backgroundSource = 'file:///background.sql';
            const activeSource = 'file:///active.sql';

            manager.startExecution(backgroundSource);
            manager.startExecution(activeSource);
            manager.setActiveSource(activeSource);

            const chunk = {
                columns: [{ name: 'id', type: 'int' }],
                rows: [[1]],
                isFirstChunk: true,
                isLastChunk: false,
                totalRowsSoFar: 1,
                limitReached: false
            };

            manager.appendStreamingChunk(backgroundSource, chunk, 'SELECT * FROM bg');

            expect(manager.activeSourceUri).toBe(activeSource);
        });
    });

    describe('toggleResultPin', () => {
        it('should pin unpinned result', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet
                ],
                sourceUri
            );

            // Unpin first to test re-pinning
            const pinnedEntries = Array.from(manager.pinnedResults.entries());
            const result1Entry = pinnedEntries.find(([_, info]) => info.resultSetIndex === 1);
            if (result1Entry) {
                manager.pinnedResults.delete(result1Entry[0]);
            }

            const initialPinnedCount = manager.pinnedResults.size;

            manager.toggleResultPin(sourceUri, 1);

            expect(manager.pinnedResults.size).toBe(initialPinnedCount + 1);
        });

        it('should unpin pinned result', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet
                ],
                sourceUri
            );

            const initialPinnedCount = manager.pinnedResults.size;

            manager.toggleResultPin(sourceUri, 1); // Unpin result at index 1

            expect(manager.pinnedResults.size).toBe(initialPinnedCount - 1);
        });
    });

    describe('switchToPinnedResult', () => {
        it('should switch to pinned result and return result set index', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet
                ],
                sourceUri
            );

            const pinnedId = Array.from(manager.pinnedResults.keys()).find(id => {
                const info = manager.pinnedResults.get(id)!;
                return info.resultSetIndex === 1;
            });

            // Switch to a different source first
            manager.setActiveSource('file:///other.sql');

            const resultSetIndex = manager.switchToPinnedResult(pinnedId!);

            expect(resultSetIndex).toBe(1);
            expect(manager.activeSourceUri).toBe(sourceUri);
        });

        it('should return undefined for invalid pinned result', () => {
            const result = manager.switchToPinnedResult('invalid_id');
            expect(result).toBeUndefined();
        });
    });

    describe('closeAllResults', () => {
        it('should remove all results except log', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet,
                    {
                        columns: [{ name: 'name', type: 'string' }],
                        data: [['test']],
                        name: 'Result 2'
                    } as ResultSet
                ],
                sourceUri
            );

            expect(manager.resultsMap.get(sourceUri)!.length).toBe(3); // log + 2 results

            manager.closeAllResults(sourceUri);

            expect(manager.resultsMap.get(sourceUri)!.length).toBe(1);
            expect(manager.resultsMap.get(sourceUri)![0].isLog).toBe(true);
        });

        it('should increment data version to force immediate webview refresh', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet
                ],
                sourceUri
            );

            const beforeVersion = manager.getDataVersion(sourceUri);
            manager.closeAllResults(sourceUri);
            const afterVersion = manager.getDataVersion(sourceUri);

            expect(afterVersion).toBe(beforeVersion + 1);
        });

        it('should reset active result set index to 0', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet
                ],
                sourceUri
            );

            expect(manager.getActiveResultSetIndex(sourceUri)).toBe(1);

            manager.finalizeExecution(sourceUri);
            expect(manager.getActiveResultSetIndex(sourceUri)).toBe(1);

            manager.closeAllResults(sourceUri);

            expect(manager.getActiveResultSetIndex(sourceUri)).toBe(0);
        });
    });

    describe('setActiveResultSetIndex', () => {
        it('should set active result set index', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);
            manager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet
                ],
                sourceUri
            );

            manager.setActiveResultSetIndex(sourceUri, 0);

            expect(manager.getActiveResultSetIndex(sourceUri)).toBe(0);
        });
    });

    describe('unpinResult', () => {
        it('should remove pinned result by ID', () => {
            const sourceUri = 'file:///test.sql';
            manager.updateResults([{
                columns: [{ name: 'id', type: 'int' }],
                data: [[1]],
                name: 'Result 1'
            } as ResultSet], sourceUri);

            const pinnedId = Array.from(manager.pinnedResults.keys())[0];
            expect(manager.pinnedResults.has(pinnedId)).toBe(true);

            manager.unpinResult(pinnedId);

            expect(manager.pinnedResults.has(pinnedId)).toBe(false);
        });
    });

    describe('result pruning and limits', () => {
        it('should prune results exceeding configured maxDataResults', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri); // Adds log

            // Add 55 results (default limit is 50)
            const resultsToAdd: ResultSet[] = [];
            for (let i = 1; i <= 55; i++) {
                resultsToAdd.push({
                    columns: [{ name: 'id', type: 'int' }],
                    data: [[i]],
                    name: `Result ${i}`
                } as ResultSet);
            }
            manager.updateResults(resultsToAdd, sourceUri);

            // Finalize to start fresh for next test, though not strictly needed for assertion
            manager.finalizeExecution(sourceUri);

            const results = manager.resultsMap.get(sourceUri);
            expect(results).toHaveLength(51); // 50 data results + 1 log
            expect(results![0].isLog).toBe(true);
            // Oldest unpinned results (1-5) should be gone, 6-55 should remain
            expect(results![1].name).toBe('Result 6');
            expect(results![50].name).toBe('Result 55');
        });

        it('should NOT prune pinned results', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            // Add Result 1
            manager.updateResults([{
                columns: [{ name: 'id', type: 'int' }],
                data: [[1]],
                name: 'Result 1'
            } as ResultSet], sourceUri);

            // Finalize to clear auto-pin, then manually pin it
            manager.finalizeExecution(sourceUri);
            manager.toggleResultPin(sourceUri, 1);

            // Add 54 more results (total 55 data results)
            for (let i = 2; i <= 55; i++) {
                manager.updateResults([{
                    columns: [{ name: 'id', type: 'int' }],
                    data: [[i]],
                    name: `Result ${i}`
                } as ResultSet], sourceUri);
                manager.finalizeExecution(sourceUri);
            }

            const results = manager.resultsMap.get(sourceUri);
            // Result 1 is pinned, so it should stay.
            expect(results!.some(r => r.name === 'Result 1')).toBe(true);
            // Result 2 should be gone (oldest unpinned)
            expect(results!.some(r => r.name === 'Result 2')).toBe(false);
        });

        it('should enforce configured maxPinnedDataResults limit', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            // Add 10 results and pin them (manual pins)
            for (let i = 1; i <= 10; i++) {
                manager.updateResults([{
                    columns: [{ name: 'id', type: 'int' }],
                    data: [[i]],
                    name: `Result ${i}`
                } as ResultSet], sourceUri);
                // Finalize to make them eligible for manual pinning without auto-pin interference
                manager.finalizeExecution(sourceUri);

                // Toggle pin manually (since they were auto-pinned then unpinned by finalize)
                const results = manager.resultsMap.get(sourceUri)!;
                const idx = results.findIndex(r => r.name === `Result ${i}`);
                manager.toggleResultPin(sourceUri, idx);
            }

            // Try to pin 11th result
            manager.updateResults([{
                columns: [{ name: 'id', type: 'int' }],
                data: [[11]],
                name: 'Result 11'
            } as ResultSet], sourceUri);
            manager.finalizeExecution(sourceUri);

            const results = manager.resultsMap.get(sourceUri)!;
            const idx11 = results.findIndex(r => r.name === 'Result 11');

            expect(() => manager.toggleResultPin(sourceUri, idx11)).toThrow(/Maximum of 10 pinned results reached/);
        });

        it('should delete underlying data when pruned', () => {
            const sourceUri = 'file:///test.sql';
            manager.startExecution(sourceUri);

            const result1Data = [[1], [2], [3]];
            const rs1 = {
                columns: [{ name: 'id', type: 'int' }],
                data: result1Data,
                name: 'Result 1'
            } as ResultSet;

            manager.updateResults([rs1], sourceUri);
            manager.finalizeExecution(sourceUri);

            // Add many more results to trigger pruning of Result 1
            for (let i = 2; i <= 55; i++) {
                manager.updateResults([{
                    columns: [{ name: 'id', type: 'int' }],
                    data: [[i]],
                    name: `Result ${i}`
                } as ResultSet], sourceUri);
                manager.finalizeExecution(sourceUri);
            }

            expect(rs1.data).toHaveLength(0);
        });
    });
});
