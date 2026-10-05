/**
 * Live database-analysis contract suite.
 *
 * Proves the DatabaseAnalysisService against a real Netezza instance through
 * the production AnalysisSession/catalog/EXPLAIN paths (no re-implemented
 * queries):
 *   1. Identity namespace and per-scope wildcard evidence: a view with an
 *      explicit column list, a view with `SELECT *`, and a procedure that
 *      references the same table.
 *   2. Distribution model: HASH vs DISTRIBUTE ON RANDOM, verified directly in
 *      `_V_TABLE_DIST_MAP` and through NZPERF001 on aligned and RANDOM joins.
 *   3. EXPLAIN path: the live EXPLAIN is structured or preserved without an
 *      EXPLAIN failure.
 *
 * Fixture DDL is required because the suite creates and drops a schema, tables,
 * views and a procedure. Every created object is dropped in `finally`/`afterAll`.
 * Credentials are never written to reports; only fixture names are used.
 *
 * Required configuration (missing variables are a configuration error, not a
 * silent skip):
 *   NZ_DEV_PASSWORD
 *   NZ_DEV_ALLOW_FIXTURE_DDL=1
 *
 * Optional:
 *   NZ_DEV_HOST, NZ_DEV_PORT, NZ_DEV_DATABASE, NZ_DEV_USER
 *
 * Run:
 *   NZ_DEV_PASSWORD=... NZ_DEV_ALLOW_FIXTURE_DDL=1 \
 *     npx jest --config jest.live.config.js --runInBand \
 *     src/__tests__/integration/databaseAnalysis.live.integration.test.ts
 */

jest.unmock('chevrotain');

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { NzConnection } from '@justybase/netezza-driver';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../core/connectionManager';
import { MetadataCache } from '../../metadataCache';
import { DatabaseAnalysisService } from '../../services/analysis/databaseAnalysisService';
import { analyzeSql, type ObjectReference } from '../../services/analysis/sqlAnalysis';
import {
    buildNetezzaLiveDetails,
    netezzaFixtureEnabled,
    netezzaLiveEnabled,
    readRecordRows,
    uniqueNetezzaName,
} from './netezzaLiveTestHarness';

const CONNECTION_NAME = 'netezza-analysis-live';
const configurationError = !netezzaLiveEnabled
    ? 'NZ_DEV_PASSWORD is required for the live database-analysis suite.'
    : !netezzaFixtureEnabled
        ? 'NZ_DEV_ALLOW_FIXTURE_DDL=1 is required because this suite creates and drops fixture objects.'
        : undefined;

const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;

describe('live database analysis contract', () => {
    if (configurationError) {
        it('fails fast when the live Netezza configuration is missing', () => {
            throw new Error(configurationError);
        });
        return;
    }

    const details = buildNetezzaLiveDetails();
    const database = details.database;
    const schema = uniqueNetezzaName('JB_ANALYSIS');
    const qualified = (name: string): string => `${quote(schema)}.${quote(name)}`;
    const created: string[] = [];
    const rootTarget: ObjectReference = { database, schema, name: 'QUERY', type: 'UNKNOWN' };
    let connection: NzConnection;
    let service: DatabaseAnalysisService;
    let cache: MetadataCache;
    const token = new vscode.CancellationTokenSource().token;

    const createConnectionManager = (): ConnectionManager => ({
        getConnection: async (name: string) => name === CONNECTION_NAME ? { ...details, name: CONNECTION_NAME } : undefined,
        getConnectionMetadata: (name: string) => name === CONNECTION_NAME ? { ...details, name: CONNECTION_NAME } : undefined,
        getConnectionDatabaseKind: (name?: string) => name && name !== CONNECTION_NAME ? undefined : 'netezza',
        getConnectionNames: () => [CONNECTION_NAME],
        getDocumentKeepConnectionOpen: () => false,
        ensureFullyLoaded: async () => undefined,
    } as unknown as ConnectionManager);

    beforeAll(async () => {
        connection = new NzConnection({
            host: details.host,
            port: details.port,
            database,
            user: details.user,
            password: details.password || '',
        });
        await connection.connect();
        const manager = createConnectionManager();
        cache = new MetadataCache({} as vscode.ExtensionContext, manager);
        service = new DatabaseAnalysisService({} as vscode.ExtensionContext, manager, cache);

        await connection.execute(`CREATE SCHEMA ${quote(schema)}`);
        created.push(`SCHEMA ${quote(schema)}`);
        await connection.execute(`CREATE TABLE ${qualified('T1')} (ID INTEGER, NAME VARCHAR(50)) DISTRIBUTE ON (ID)`);
        await connection.execute(`CREATE TABLE ${qualified('T2')} (ID INTEGER) DISTRIBUTE ON (ID)`);
        await connection.execute(`CREATE TABLE ${qualified('T3')} (ID INTEGER) DISTRIBUTE ON RANDOM`);
        await connection.execute(`CREATE VIEW ${qualified('V1')} AS SELECT ID, NAME FROM ${qualified('T1')}`);
        await connection.execute(`CREATE VIEW ${qualified('V2')} AS SELECT * FROM ${qualified('T1')}`);
        await connection.execute(`CREATE PROCEDURE ${qualified('P1')}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  N INT;
BEGIN
  SELECT COUNT(*) INTO N FROM ${qualified('T1')};
  RETURN N;
END;
END_PROC;`);
    }, 180_000);

    afterAll(async () => {
        if (!connection) { return; }
        const drops = [
            `DROP PROCEDURE ${qualified('P1')}()`,
            `DROP VIEW ${qualified('V2')}`,
            `DROP VIEW ${qualified('V1')}`,
            `DROP TABLE ${qualified('T3')}`,
            `DROP TABLE ${qualified('T2')}`,
            `DROP TABLE ${qualified('T1')}`,
            `DROP SCHEMA ${quote(schema)}`,
        ];
        for (const statement of drops) {
            try { await connection.execute(statement); }
            catch { /* best-effort cleanup */ }
        }
        service?.dispose();
        await connection.close();
    }, 120_000);

    it('catalog exposes HASH keys for DISTRIBUTE ON and none for RANDOM', async () => {
        const rows = await readRecordRows(connection, `
            SELECT O.OBJNAME AS OBJNAME, COUNT(D.ATTNAME) AS DISTKEYCOUNT
            FROM ${database}.._V_OBJECT_DATA O
            LEFT JOIN ${database}.._V_TABLE_DIST_MAP D ON D.OBJID = O.OBJID
            WHERE O.DBNAME = '${database}' AND O.SCHEMA = '${schema}' AND O.OBJNAME IN ('T1','T2','T3')
            GROUP BY O.OBJNAME`).catch(() => [] as Record<string, unknown>[]);
        const byName = new Map(rows.map(row => [String(row.OBJNAME), Number(row.DISTKEYCOUNT)]));
        expect(byName.get('T1')).toBeGreaterThanOrEqual(1);
        expect(byName.get('T2')).toBeGreaterThanOrEqual(1);
        expect(byName.get('T3')).toBe(0);
    }, 120_000);

    it('resolves namespace, column evidence and per-scope wildcard from live definitions', async () => {
        const root: ObjectReference = { database, schema, name: 'T1', type: 'TABLE' };
        const report = await service.dependencies(CONNECTION_NAME, root, 'incoming', 2, token);
        const names = report.affected.map(entry => entry.object.name);
        expect(names).toEqual(expect.arrayContaining(['V1', 'V2', 'P1']));

        // Netezza rewrites view definitions and expands SELECT *, so both views
        // contribute column evidence rather than a catalog wildcard.
        const edge = (source: string, target: string) => report.edges.find(item => item.source.name === source && item.target.name === target);
        expect(edge('V1', 'T1')?.evidence.some(item => item.column?.toUpperCase() === 'ID')).toBe(true);
        expect(edge('V2', 'T1')?.evidence.some(item => item.column?.toUpperCase() === 'ID')).toBe(true);
        expect(report.edges.filter(item => item.source.name === 'V2' && item.target.name !== 'T1')).toHaveLength(0);
        expect(edge('P1', 'T1')).toBeDefined();

        // Per-scope wildcard, verified with the real fixture schema/table names.
        const sql = `SELECT * FROM ${qualified('T1')} WHERE EXISTS (SELECT 1 FROM ${qualified('T3')})`;
        const analysis = analyzeSql(sql, rootTarget);
        expect(analysis.references.filter(ref => ref.kind === 'wildcard').map(ref => ref.target.name)).toEqual(['T1']);
        expect(analysis.references.filter(ref => ref.kind === 'object').map(ref => ref.target.name).sort()).toEqual(['T1', 'T3']);
    }, 180_000);

    it('maps live distribution to HASH/RANDOM and flags only the RANDOM join', async () => {
        const alignedSql = `SELECT T1.ID FROM ${qualified('T1')} T1 JOIN ${qualified('T2')} T2 ON T1.ID = T2.ID`;
        const aligned = await service.performance(CONNECTION_NAME, alignedSql, rootTarget, token);
        expect(aligned.recommendations.map(item => item.id)).not.toContain('NZPERF001');
        expect(aligned.issues.join(' ')).not.toContain('alignment check was skipped');

        const movedSql = `SELECT T1.ID FROM ${qualified('T1')} T1 JOIN ${qualified('T3')} T3 ON T1.ID = T3.ID`;
        const moved = await service.performance(CONNECTION_NAME, movedSql, rootTarget, token);
        expect(moved.recommendations.map(item => item.id)).toContain('NZPERF001');
        expect(moved.recommendations.find(item => item.id === 'NZPERF001')?.evidence.some(item => /RANDOM/.test(item.summary))).toBe(true);
    }, 180_000);

    it('structures the live EXPLAIN or preserves it without an EXPLAIN failure', async () => {
        const sql = `SELECT T1.ID FROM ${qualified('T1')} T1 JOIN ${qualified('T3')} T3 ON T1.ID = T3.ID`;
        const report = await service.performance(CONNECTION_NAME, sql, rootTarget, token);
        expect(report.issues.join(' ')).not.toContain('EXPLAIN failed');
        expect(report.plan).toBeDefined();
        expect((report.plan?.rawPlan ?? '').length).toBeGreaterThan(0);
    }, 180_000);
});
