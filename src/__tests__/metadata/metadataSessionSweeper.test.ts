/**
 * Unit tests for metadata/metadataSessionSweeper.ts
 * Covers the session registry, stale-session detection, _V_SESSION
 * verification, DROP SESSION execution, dialect gating, and config.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const mockConfig: Record<string, unknown> = {};

jest.mock('vscode', () => ({
    window: { showErrorMessage: jest.fn() },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((key: string, defaultValue?: unknown) =>
                mockConfig[key] ?? defaultValue,
            ),
        })),
    },
}));

const mockCreateConnectedConnection = jest.fn();
const mockResolveConnectionDatabaseKind = jest.fn();
jest.mock('../../core/connectionFactory', () => ({
    createConnectedDatabaseConnectionFromDetails:
        mockCreateConnectedConnection,
    resolveConnectionDatabaseKind: mockResolveConnectionDatabaseKind,
}));

jest.mock('../../utils/logger', () => ({
    logWithFallback: jest.fn(),
}));

import { metadataSessionSweeper } from '../../metadata/metadataSessionSweeper';
import type { ConnectionManager } from '../../core/connectionManager';
import type { DatabaseConnection, DatabaseDataReader } from '../../contracts/database';

const CONN = 'CONN_1';
const BASE_TIME = 1_700_000_000_000;

function createReader(rows: [unknown, unknown][]): DatabaseDataReader {
    let cursor = -1;
    return {
        read: jest.fn(async () => {
            cursor += 1;
            return cursor < rows.length;
        }),
        close: jest.fn().mockResolvedValue(undefined),
        fieldCount: 2,
        getName: jest.fn(),
        getTypeName: jest.fn(),
        getValue: jest.fn((i: number) => {
            const row = rows[cursor];
            return row ? row[i] : undefined;
        }),
        nextResult: jest.fn(async () => false),
    } as any;
}

function createCommand(sql: string, readers: Record<string, DatabaseDataReader>) {
    return {
        commandTimeout: 0,
        executeReader: jest.fn(async () => readers[sql] ?? createReader([])),
        cancel: jest.fn(),
        execute: jest.fn(),
        _recordsAffected: 0,
    } as any;
}

function createConnection(
    readers: Record<string, DatabaseDataReader>,
): DatabaseConnection {
    return {
        connect: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
        createCommand: jest.fn((sql: string) => createCommand(sql, readers)),
        on: jest.fn(),
        removeListener: jest.fn(),
    } as any;
}

function createConnManager(details?: Record<string, unknown>): ConnectionManager {
    return {
        getConnection: jest.fn().mockResolvedValue(details ?? {
            host: 'localhost',
            port: 5480,
            database: 'SYSTEM',
            user: 'admin',
            password: 'pass',
            dbType: 'NetezzaSQL',
        }),
    } as unknown as ConnectionManager;
}

function dropSessionCalls(connection: DatabaseConnection): string[] {
    return (connection.createCommand as jest.Mock).mock.calls
        .map((args) => String(args[0]))
        .filter((sql) => sql.startsWith('DROP SESSION'));
}

describe('MetadataSessionSweeper', () => {
    let nowSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        Object.keys(mockConfig).forEach((key) => delete mockConfig[key]);
        mockResolveConnectionDatabaseKind.mockReturnValue('netezza');
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(BASE_TIME);
        metadataSessionSweeper.dispose();
    });

    afterEach(() => {
        nowSpy.mockRestore();
        metadataSessionSweeper.dispose();
    });

    describe('registry', () => {
        it('registers and reports sessions per connection', () => {
            metadataSessionSweeper.register(CONN, '100');
            metadataSessionSweeper.register(CONN, '101');
            metadataSessionSweeper.register('OTHER', '200');

            expect(metadataSessionSweeper.hasSession(CONN, '100')).toBe(true);
            expect(metadataSessionSweeper.hasSession(CONN, '101')).toBe(true);
            expect(metadataSessionSweeper.getRegisteredSessionCount(CONN)).toBe(2);
            expect(metadataSessionSweeper.hasSession('OTHER', '200')).toBe(true);
        });

        it('ignores empty connection names and session ids', () => {
            metadataSessionSweeper.register('', '100');
            metadataSessionSweeper.register(CONN, '');
            expect(metadataSessionSweeper.getRegisteredSessionCount(CONN)).toBe(0);
        });

        it('caps the per-connection registry size', () => {
            for (let i = 0; i < 505; i++) {
                metadataSessionSweeper.register(CONN, String(i));
            }
            expect(metadataSessionSweeper.getRegisteredSessionCount(CONN)).toBe(500);
            expect(metadataSessionSweeper.hasSession(CONN, '4')).toBe(false);
            expect(metadataSessionSweeper.hasSession(CONN, '504')).toBe(true);
        });
    });

    describe('sweep', () => {
        it('drops only stale sessions verified in _V_SESSION with matching user', async () => {
            mockConfig['maxAgeMinutes'] = 20;
            const connManager = createConnManager();
            const connection = createConnection({
                'SELECT ID, USERNAME FROM _V_SESSION WHERE ID IN (100,101)': createReader([
                    ['100', 'admin'],
                    ['101', 'admin'],
                ]),
                'DROP SESSION 100': createReader([]),
                'DROP SESSION 101': createReader([]),
            });
            mockCreateConnectedConnection.mockResolvedValue(connection);

            metadataSessionSweeper.register(CONN, '100');
            metadataSessionSweeper.register(CONN, '101');

            nowSpy.mockReturnValue(BASE_TIME + 21 * 60_000);
            metadataSessionSweeper.start(connManager);
            await metadataSessionSweeper.sweep();

            expect(dropSessionCalls(connection)).toEqual([
                'DROP SESSION 100',
                'DROP SESSION 101',
            ]);
            expect(metadataSessionSweeper.getRegisteredSessionCount(CONN)).toBe(0);
        });

        it('does not drop fresh sessions below the age threshold', async () => {
            mockConfig['maxAgeMinutes'] = 20;
            const connManager = createConnManager();
            const connection = createConnection({});
            mockCreateConnectedConnection.mockResolvedValue(connection);

            metadataSessionSweeper.register(CONN, '100');
            nowSpy.mockReturnValue(BASE_TIME + 19 * 60_000);
            metadataSessionSweeper.start(connManager);
            await metadataSessionSweeper.sweep();

            expect(connection.createCommand).not.toHaveBeenCalled();
            expect(metadataSessionSweeper.hasSession(CONN, '100')).toBe(true);
        });

        it('does not drop sessions whose username does not match the connection user', async () => {
            mockConfig['maxAgeMinutes'] = 20;
            const connManager = createConnManager();
            const connection = createConnection({
                'SELECT ID, USERNAME FROM _V_SESSION WHERE ID IN (100)': createReader([
                    ['100', 'someone_else'],
                ]),
            });
            mockCreateConnectedConnection.mockResolvedValue(connection);

            metadataSessionSweeper.register(CONN, '100');
            nowSpy.mockReturnValue(BASE_TIME + 30 * 60_000);
            metadataSessionSweeper.start(connManager);
            await metadataSessionSweeper.sweep();

            expect(dropSessionCalls(connection)).toEqual([]);
            expect(metadataSessionSweeper.getRegisteredSessionCount(CONN)).toBe(0);
        });

        it('prunes stale entries for non-Netezza connections without issuing commands', async () => {
            mockResolveConnectionDatabaseKind.mockReturnValue('duckdb');
            const connManager = createConnManager();
            const connection = createConnection({});
            mockCreateConnectedConnection.mockResolvedValue(connection);

            metadataSessionSweeper.register(CONN, '100');
            nowSpy.mockReturnValue(BASE_TIME + 30 * 60_000);
            metadataSessionSweeper.start(connManager);
            await metadataSessionSweeper.sweep();

            expect(connection.createCommand).not.toHaveBeenCalled();
            expect(mockCreateConnectedConnection).not.toHaveBeenCalled();
            expect(metadataSessionSweeper.getRegisteredSessionCount(CONN)).toBe(0);
        });

        it('clears the registry when the feature is disabled', async () => {
            mockConfig['enabled'] = false;
            const connManager = createConnManager();
            const connection = createConnection({});
            mockCreateConnectedConnection.mockResolvedValue(connection);

            metadataSessionSweeper.register(CONN, '100');
            metadataSessionSweeper.start(connManager);
            await metadataSessionSweeper.sweep();

            expect(connection.createCommand).not.toHaveBeenCalled();
            expect(metadataSessionSweeper.getRegisteredSessionCount(CONN)).toBe(0);
        });

        it('keeps entries when the stale-session check fails', async () => {
            mockConfig['maxAgeMinutes'] = 20;
            const connManager = createConnManager();
            mockCreateConnectedConnection.mockRejectedValue(
                new Error('connect failed'),
            );

            metadataSessionSweeper.register(CONN, '100');
            nowSpy.mockReturnValue(BASE_TIME + 30 * 60_000);
            metadataSessionSweeper.start(connManager);
            await metadataSessionSweeper.sweep();

            expect(metadataSessionSweeper.hasSession(CONN, '100')).toBe(true);
        });

        it('does not run overlapping sweeps', async () => {
            mockConfig['maxAgeMinutes'] = 20;
            const connManager = createConnManager();
            let release: (() => void) | undefined;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const connection = createConnection({});
            (connection.createCommand as jest.Mock).mockImplementation(
                (_sql: string) => ({
                    commandTimeout: 0,
                    executeReader: jest.fn(async () => {
                        await gate;
                        return createReader([['100', 'admin']]);
                    }),
                    cancel: jest.fn(),
                    execute: jest.fn(),
                    _recordsAffected: 0,
                }),
            );
            mockCreateConnectedConnection.mockResolvedValue(connection);

            metadataSessionSweeper.register(CONN, '100');
            nowSpy.mockReturnValue(BASE_TIME + 30 * 60_000);
            metadataSessionSweeper.start(connManager);

            const first = metadataSessionSweeper.sweep();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const second = metadataSessionSweeper.sweep();
            release!();
            await Promise.all([first, second]);

            const sessionQueries = (connection.createCommand as jest.Mock).mock.calls
                .map((args) => String(args[0]))
                .filter((sql) => sql.includes('_V_SESSION'));
            expect(sessionQueries).toHaveLength(1);
            expect(dropSessionCalls(connection)).toEqual(['DROP SESSION 100']);
        });
    });
});