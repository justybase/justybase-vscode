/**
 * Disk restart → code completion integration guard.
 *
 * Simulates a full VS Code restart: a complete Netezza metadata snapshot is
 * written to disk, a brand-new `MetadataCache` hydrates from it, and every
 * authoring surface is exercised through the real LSP bridge + completion
 * engine. The point is that persisted metadata alone (databases, schemas,
 * tables, views, procedures, columns and their comments) must power
 * completion without a single catalog query.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CompletionItem } from 'vscode-languageserver/node';

// Alias binding comes from the real Chevrotain parse; the shared unit mock
// cannot produce a semantic scope.
jest.unmock('chevrotain');

import { handleMetadataRequest } from '../../activation/lspRegistration';
import type { ConnectionManager } from '../../core/connectionManager';
import { runQueryRaw } from '../../core/queryRunner';
import { ensureBuiltInDialectsRegistered } from '../../dialects';
import { LspCompletionEngine } from '../../server/completionEngine';
import { MetadataBridge } from '../../server/metadataBridge';
import { MetadataCache } from '../../metadataCache';
import { DocumentParseSession } from '../../sqlParser/documentParseSession';
import { Logger } from '../../utils/logger';
import {
    countColumnLayersInRam,
    createMetadataCache,
    createTempStorageDir,
    installDiskPersistenceConfigMock,
    isDatabaseColumnsFullyLoaded,
    LARGE_DB,
    LARGE_DB_TABLE_COUNT,
    populateLargeCatalogColumnLayers,
    RESTART_CONN,
    restartFromDisk,
    SCHEMA,
    SMALL_DB,
} from '../fixtures/metadataCacheRestartFixture';
import type { MetadataProvider } from '../../providers/providers/metadataProvider';

jest.mock('vscode');

jest.mock('../../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn((result: { data?: unknown[][]; columns?: { name: string }[] }) => {
        if (!result?.data || !result.columns) {
            return [];
        }
        return result.data.map((row) => {
            const obj: Record<string, unknown> = {};
            result.columns!.forEach((col, index) => {
                obj[col.name] = row[index];
            });
            return obj;
        });
    }),
}));

jest.mock('../../dialects/netezza/metadata/netezzaSchemaContext', () => ({
    resolveNetezzaSchemasEnabled: jest.fn(async () => true),
    resolveNetezzaDefaultSchema: jest.fn(async () => 'ADMIN'),
}));

const COMPLETION_DOCUMENT = 'file:///restart-completion.sql';

describe('metadata cache restart → completion integration', () => {
    let tempDir: string;
    const runQueryRawMock = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;

    beforeEach(() => {
        tempDir = createTempStorageDir();
        runQueryRawMock.mockReset();

        const mockOutputChannel = {
            appendLine: () => undefined,
            show: () => undefined,
            dispose: () => undefined,
        } as unknown as vscode.OutputChannel;
        Logger.initialize(mockOutputChannel);
        installDiskPersistenceConfigMock();
        jest.spyOn(
            require('../../compatibility/configuration'),
            'getExtensionConfiguration',
        ).mockReturnValue({
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'metadataCache.diskPersistence') {
                    return true;
                }
                if (key === 'metadataCache.crossWindowSync') {
                    return false;
                }
                return defaultValue;
            },
        });
        ensureBuiltInDialectsRegistered();
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function populateRichCatalog(cache: MetadataCache): void {
        cache.setDatabases(RESTART_CONN, [
            { DATABASE: SMALL_DB, label: SMALL_DB, kind: 9, detail: 'Database' },
        ]);
        cache.setSchemas(RESTART_CONN, SMALL_DB, [
            { SCHEMA, label: SCHEMA, kind: 19, detail: 'Schema' },
            { SCHEMA: 'STAGE', label: 'STAGE', kind: 19, detail: 'Schema' },
        ]);
        cache.setTables(
            RESTART_CONN,
            `${SMALL_DB}.${SCHEMA}`,
            [
                {
                    OBJNAME: 'DIM_ACCOUNT',
                    OBJID: 101,
                    SCHEMA,
                    label: 'DIM_ACCOUNT',
                    objType: 'TABLE',
                    kind: 6,
                    DESCRIPTION: 'Account dimension',
                    rowCount: 18484,
                },
                {
                    OBJNAME: 'V_ACCOUNT_SUMMARY',
                    OBJID: 102,
                    SCHEMA,
                    label: 'V_ACCOUNT_SUMMARY',
                    objType: 'VIEW',
                    kind: 18,
                    DESCRIPTION: 'Aggregated accounts',
                },
            ],
            new Map<string, number>([
                [`${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`, 101],
                [`${SMALL_DB}.${SCHEMA}.V_ACCOUNT_SUMMARY`, 102],
            ]),
        );
        cache.setProcedures(RESTART_CONN, `${SMALL_DB}..`, [
            {
                PROCEDURE: 'REFRESH_ACCOUNTS',
                PROCEDURESIGNATURE: 'REFRESH_ACCOUNTS()',
                SCHEMA,
                label: 'REFRESH_ACCOUNTS()',
                detail: 'Procedure',
            },
        ]);
        cache.setTypeGroups(RESTART_CONN, SMALL_DB, ['TABLE', 'VIEW', 'PROCEDURE']);
        cache.setColumns(RESTART_CONN, `${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`, [
            {
                ATTNAME: 'ACCOUNT_ID',
                FORMAT_TYPE: 'INTEGER',
                label: 'ACCOUNT_ID',
                kind: 5,
                detail: 'INTEGER',
                documentation: 'Surrogate account key',
                isPk: true,
                isFk: false,
                isDistributionKey: true,
                isNotNull: true,
                colDefault: null,
            },
            {
                ATTNAME: 'ACCOUNT_NAME',
                FORMAT_TYPE: 'NATIONAL CHARACTER VARYING(64)',
                label: 'ACCOUNT_NAME',
                kind: 5,
                detail: 'NATIONAL CHARACTER VARYING(64)',
                documentation: 'Display name of the account',
                isPk: false,
                isFk: false,
                isDistributionKey: false,
                isNotNull: false,
                colDefault: null,
            },
            {
                ATTNAME: 'PARENT_ACCOUNT_ID',
                FORMAT_TYPE: 'INTEGER',
                label: 'PARENT_ACCOUNT_ID',
                kind: 5,
                detail: 'INTEGER',
                documentation: 'Self reference to the parent account',
                isPk: false,
                isFk: true,
                isDistributionKey: false,
                joinReferences: [{
                    fromDatabase: SMALL_DB,
                    fromSchema: SCHEMA,
                    fromTable: 'DIM_ACCOUNT',
                    fromColumn: 'PARENT_ACCOUNT_ID',
                    toDatabase: SMALL_DB,
                    toSchema: SCHEMA,
                    toTable: 'DIM_ACCOUNT',
                    toColumn: 'ACCOUNT_ID',
                    constraintName: 'FK_ACCOUNT_PARENT',
                    ordinalPosition: 1,
                }],
            },
        ]);
        cache.setColumns(RESTART_CONN, `${SMALL_DB}.${SCHEMA}.V_ACCOUNT_SUMMARY`, [
            {
                ATTNAME: 'ACCOUNT_NAME',
                FORMAT_TYPE: 'NATIONAL CHARACTER VARYING(64)',
                label: 'ACCOUNT_NAME',
                kind: 5,
                detail: 'NATIONAL CHARACTER VARYING(64)',
                documentation: 'Display name of the account',
                isPk: false,
                isFk: false,
                isDistributionKey: false,
            },
        ]);
    }

    function createCompletionConnectionManager(): ConnectionManager {
        return {
            ensureFullyLoaded: async () => undefined,
            getConnectionForExecution: () => RESTART_CONN,
            getConnection: async () => ({
                name: RESTART_CONN,
                host: 'nz.host',
                port: 5480,
                database: SMALL_DB,
                user: 'admin',
                password: '',
                dbType: 'netezza' as const,
            }),
            getConnectionMetadata: () => ({
                host: 'nz.host',
                port: 5480,
                database: SMALL_DB,
                user: 'admin',
                dbType: 'netezza' as const,
            }),
            getConnectionDatabaseKind: () => 'netezza' as const,
            getConnectionNames: () => [RESTART_CONN],
            getEffectiveDatabase: async () => SMALL_DB,
            getEffectiveSchema: async () => SCHEMA,
            getExecutionDatabaseKind: () => 'netezza' as const,
        } as unknown as ConnectionManager;
    }

    function createCompletionHarness(cache: MetadataCache): {
        complete: (sqlWithCursor: string) => Promise<CompletionItem[]>;
    } {
        const connectionManager = createCompletionConnectionManager();
        // Cache-only paths must never reach the live provider. Failing loudly
        // here proves completion is served by the persisted snapshot.
        const metadataProvider = {
            getDatabases: () => { throw new Error('live getDatabases must not run'); },
            getSchemas: () => { throw new Error('live getSchemas must not run'); },
            getTables: () => { throw new Error('live getTables must not run'); },
            getViews: () => { throw new Error('live getViews must not run'); },
            getProcedures: () => { throw new Error('live getProcedures must not run'); },
            getTableColumnsMetadata: () => { throw new Error('live columns must not run'); },
            warmDatabaseColumns: () => { throw new Error('live column warm must not run'); },
        } as unknown as MetadataProvider;
        const bridge = new MetadataBridge(async (params) => handleMetadataRequest(
            params,
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            metadataProvider,
            cache,
            connectionManager,
        ));
        const engine = new LspCompletionEngine(bridge, new DocumentParseSession());
        return {
            complete: async (sqlWithCursor: string): Promise<CompletionItem[]> => {
                const cursor = sqlWithCursor.indexOf('|');
                if (cursor < 0) {
                    throw new Error('missing cursor marker');
                }
                const text = `${sqlWithCursor.slice(0, cursor)}${sqlWithCursor.slice(cursor + 1)}`;
                const document = TextDocument.create(COMPLETION_DOCUMENT, 'sql', 1, text);
                return engine.provideCompletionItems(document, document.positionAt(cursor));
            },
        };
    }

    function labels(items: readonly CompletionItem[]): string[] {
        return items.map(item => item.label);
    }

    function documentationOf(item: CompletionItem | undefined): string | undefined {
        if (!item) {
            return undefined;
        }
        const documentation = item.documentation;
        if (typeof documentation === 'string') {
            return documentation;
        }
        if (documentation && 'value' in documentation) {
            return documentation.value;
        }
        return undefined;
    }

    it('restores databases, schemas, objects and column comments after a restart', async () => {
        const writer = createMetadataCache(tempDir);
        populateRichCatalog(writer);

        const restarted = await restartFromDisk(writer, tempDir);

        expect(restarted.getDatabases(RESTART_CONN)?.map(db => db.DATABASE)).toEqual([SMALL_DB]);
        expect(restarted.getSchemas(RESTART_CONN, SMALL_DB)?.map(schema => schema.SCHEMA))
            .toEqual([SCHEMA, 'STAGE']);

        const tables = restarted.getTables(RESTART_CONN, `${SMALL_DB}.${SCHEMA}`);
        expect(tables?.find(table => table.OBJNAME === 'DIM_ACCOUNT')).toEqual(
            expect.objectContaining({ DESCRIPTION: 'Account dimension', rowCount: 18484 }),
        );
        expect(tables?.find(table => table.OBJNAME === 'V_ACCOUNT_SUMMARY')?.DESCRIPTION)
            .toBe('Aggregated accounts');

        expect(restarted.getProcedures(RESTART_CONN, `${SMALL_DB}..`))
            .toEqual([expect.objectContaining({ PROCEDURE: 'REFRESH_ACCOUNTS' })]);
        expect(restarted.getTypeGroups(RESTART_CONN, SMALL_DB))
            .toEqual(expect.arrayContaining(['TABLE', 'VIEW', 'PROCEDURE']));

        // Columns stay lazy on purpose; the first read hydrates them from disk.
        expect(restarted.getColumns(RESTART_CONN, `${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`))
            .toBeUndefined();
        expect(runQueryRawMock).not.toHaveBeenCalled();

        const columns = await restarted
            .ensureColumnsLoadedForTableKey(RESTART_CONN, `${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`)
            .then(() => restarted.getColumns(RESTART_CONN, `${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`));
        expect(columns).toEqual([
            expect.objectContaining({
                ATTNAME: 'ACCOUNT_ID',
                FORMAT_TYPE: 'INTEGER',
                documentation: 'Surrogate account key',
                isPk: true,
                isDistributionKey: true,
                isNotNull: true,
            }),
            expect.objectContaining({
                ATTNAME: 'ACCOUNT_NAME',
                documentation: 'Display name of the account',
            }),
            expect.objectContaining({
                ATTNAME: 'PARENT_ACCOUNT_ID',
                isFk: true,
                documentation: 'Self reference to the parent account',
                joinReferences: [expect.objectContaining({
                    toTable: 'DIM_ACCOUNT',
                    toColumn: 'ACCOUNT_ID',
                    constraintName: 'FK_ACCOUNT_PARENT',
                })],
            }),
        ]);
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });

    it('offers databases, schemas, tables, views and procedures from disk metadata', async () => {
        const writer = createMetadataCache(tempDir);
        populateRichCatalog(writer);
        const restarted = await restartFromDisk(writer, tempDir);
        const { complete } = createCompletionHarness(restarted);

        expect(labels(await complete('SELECT * FROM SMA|'))).toContain(SMALL_DB);
        expect(labels(await complete(`SELECT * FROM ${SMALL_DB}.|`)))
            .toEqual(expect.arrayContaining([SCHEMA, 'STAGE']));
        expect(labels(await complete(`SELECT * FROM ${SMALL_DB}.${SCHEMA}.|`)))
            .toEqual(expect.arrayContaining(['DIM_ACCOUNT', 'V_ACCOUNT_SUMMARY']));

        const tableItem = (await complete('SELECT * FROM DIM_AC|'))
            .find(item => item.label === 'DIM_ACCOUNT');
        expect(tableItem?.detail).toContain('Account dimension');

        const viewItem = (await complete('SELECT * FROM V_ACCOUNT_|'))
            .find(item => item.label === 'V_ACCOUNT_SUMMARY');
        expect(viewItem?.detail).toContain('Aggregated accounts');

        expect(labels(await complete(`SELECT * FROM ${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT D WHERE D.ACCOUNT_|`)))
            .toEqual(expect.arrayContaining(['ACCOUNT_ID', 'ACCOUNT_NAME']));
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });

    it('serves column completions with catalog comments from the persisted layer', async () => {
        const writer = createMetadataCache(tempDir);
        populateRichCatalog(writer);
        const restarted = await restartFromDisk(writer, tempDir);
        const { complete } = createCompletionHarness(restarted);

        const items = await complete(
            `SELECT * FROM ${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT D WHERE D.|`,
        );
        const accountName = items.find(item => labels([item]).includes('D.ACCOUNT_NAME'))
            ?? items.find(item => String(item.label).endsWith('ACCOUNT_NAME'));
        expect(accountName).toBeDefined();
        expect(documentationOf(accountName)).toBe('Display name of the account');

        const parentItem = items.find(item => String(item.label).endsWith('PARENT_ACCOUNT_ID'));
        expect(parentItem).toBeDefined();
        expect(documentationOf(parentItem)).toBe('Self reference to the parent account');
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });

    it('keeps comments edited in the previous session visible to completion after restart', async () => {
        const writer = createMetadataCache(tempDir);
        populateRichCatalog(writer);
        expect(writer.updateObjectComment(
            RESTART_CONN,
            SMALL_DB,
            SCHEMA,
            'DIM_ACCOUNT',
            'Account dimension (curated)',
        )).toBe(true);
        expect(writer.updateColumnComment(
            RESTART_CONN,
            SMALL_DB,
            SCHEMA,
            'DIM_ACCOUNT',
            'ACCOUNT_NAME',
            'Curated display name',
        )).toBe(true);

        const restarted = await restartFromDisk(writer, tempDir);
        const { complete } = createCompletionHarness(restarted);

        const tableItem = (await complete('SELECT * FROM DIM_AC|'))
            .find(item => item.label === 'DIM_ACCOUNT');
        expect(tableItem?.detail).toContain('Account dimension (curated)');

        const items = await complete(
            `SELECT * FROM ${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT D WHERE D.ACCOUNT_NAME|`,
        );
        const columnItem = items.find(item => String(item.label).endsWith('ACCOUNT_NAME'));
        expect(documentationOf(columnItem)).toBe('Curated display name');
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });

    it('hydrates only the requested large-catalog column layer during completion', async () => {
        const writer = createMetadataCache(tempDir);
        populateLargeCatalogColumnLayers(writer);

        const restarted = await restartFromDisk(writer, tempDir);
        expect(restarted.getTables(RESTART_CONN, `${LARGE_DB}.${SCHEMA}`)?.length)
            .toBe(LARGE_DB_TABLE_COUNT);
        expect(countColumnLayersInRam(restarted, RESTART_CONN, LARGE_DB)).toBe(0);

        const { complete } = createCompletionHarness(restarted);
        const items = await complete(
            `SELECT * FROM ${LARGE_DB}.${SCHEMA}.TARGET T WHERE T.TARGET_|`,
        );
        expect(labels(items)).toEqual(expect.arrayContaining([
            expect.stringContaining('TARGET_ID'),
        ]));

        expect(countColumnLayersInRam(restarted, RESTART_CONN, LARGE_DB)).toBe(1);
        expect(isDatabaseColumnsFullyLoaded(restarted, RESTART_CONN, LARGE_DB)).toBe(false);
        expect(restarted.getColumns(RESTART_CONN, `${LARGE_DB}.${SCHEMA}.T0`)).toBeUndefined();
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });
});
