/**
 * E2E audit: which completion-keyword proposals are actually accepted by a
 * real Netezza instance?
 *
 * The parser-based legality matrix lives in
 * src/__tests__/sqlParser/netezzaKeywordLegality.test.ts; the cases below are
 * the doubtful ones where the parser verdict needs confirmation against a real
 * database (OUTER JOIN standalone, OFFSET without LIMIT, UNION/INTERSECT/EXCEPT
 * after a FROM alias, HAVING without GROUP BY, IN/BETWEEN after a complete
 * predicate). Read-only statements, no schema modification.
 *
 * Prerequisites:
 *   NZ_DEV_PASSWORD environment variable (falls back to 'password')
 *
 * Run:
 *   NZ_DEV_PASSWORD=password npx jest --config jest.live.config.js --runInBand \
 *     src/__tests__/integration/netezzaCompletionKeywordLegality.live.integration.test.ts
 */

const skipTests = !process.env.NZ_DEV_PASSWORD;
const describeIfDb = skipTests ? describe.skip : describe;
const itIfDb = skipTests ? it.skip : it;

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { NzConnection } from '@justybase/netezza-driver';
import { applyTextReplacements, buildSelectStarExpansion, findSelectStarContext } from '../../sql/expandSelectStar';
import { extractGroupableSelectExpressions } from '../../server/completionSelectList';

const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password',
};

const DATABASE = DB_CONFIG.database.toUpperCase();

async function tryExecute(
    connection: NzConnection,
    sql: string,
): Promise<{ ok: boolean; error?: string }> {
    const cmd = connection.createCommand(sql);
    cmd.commandTimeout = 15;
    try {
        const reader = await cmd.executeReader();
        await reader.close();
        return { ok: true };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err ?? 'unknown');
        return { ok: false, error: msg.substring(0, 500) };
    }
}

describeIfDb('Netezza Completion Keyword Legality (live audit)', () => {
    let connection: NzConnection;

    beforeAll(async () => {
        if (skipTests) return;
        connection = new NzConnection(DB_CONFIG);
        await connection.connect();
    });

    afterAll(async () => {
        if (!skipTests) {
            await connection.close();
        }
    });

    const FROM_TAIL = `SELECT * FROM ${DATABASE}..DIMACCOUNT A`;
    const JOIN_PARTNER = '_V_DATABASE';
    const SAFE = ' WHERE 1=0 LIMIT 1';

    itIfDb('OUTER JOIN standalone is REJECTED (only LEFT/RIGHT/FULL OUTER are legal)', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL} OUTER JOIN ${JOIN_PARTNER} B ON 1=1${SAFE}`,
        );
        expect(result.ok).toBe(false);
    });

    itIfDb('LEFT OUTER JOIN is accepted', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL} LEFT OUTER JOIN ${JOIN_PARTNER} B ON 1=1${SAFE}`,
        );
        expect(result.ok).toBe(true);
    });

    itIfDb('NATURAL JOIN is accepted', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL} NATURAL JOIN ${JOIN_PARTNER}${SAFE}`,
        );
        expect(result.ok).toBe(true);
    });

    itIfDb('CROSS JOIN is accepted', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL} CROSS JOIN ${JOIN_PARTNER}${SAFE}`,
        );
        expect(result.ok).toBe(true);
    });

    itIfDb('UNION after FROM alias is accepted (matching column counts)', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL.replace('SELECT *', 'SELECT 1')} UNION SELECT 1 FROM ${DATABASE}..DIMDATE${SAFE}`,
        );
        expect(result.ok).toBe(true);
    });

    itIfDb('INTERSECT after FROM alias is accepted (matching column counts)', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL.replace('SELECT *', 'SELECT 1')} INTERSECT SELECT 1 FROM ${DATABASE}..DIMDATE${SAFE}`,
        );
        expect(result.ok).toBe(true);
    });

    itIfDb('EXCEPT after FROM alias is accepted (matching column counts)', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL.replace('SELECT *', 'SELECT 1')} EXCEPT SELECT 1 FROM ${DATABASE}..DIMDATE${SAFE}`,
        );
        expect(result.ok).toBe(true);
    });

    itIfDb('HAVING without GROUP BY is accepted', async () => {
        const result = await tryExecute(
            connection,
            `SELECT COUNT(*) FROM ${DATABASE}..DIMACCOUNT A WHERE 1=0 HAVING 1=1`,
        );
        expect(result.ok).toBe(true);
    });

    itIfDb('FETCH FIRST n ROWS ONLY is REJECTED by this NPS version', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL} WHERE 1=0 FETCH FIRST 1 ROWS ONLY`,
        );
        expect(result.ok).toBe(false);
    });

    itIfDb('OFFSET without LIMIT is accepted', async () => {
        const result = await tryExecute(connection, `${FROM_TAIL} OFFSET 5`);
        expect(result.ok).toBe(true);
    });

    itIfDb('LIMIT n OFFSET m is accepted', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL} WHERE 1=0 LIMIT 5 OFFSET 2`,
        );
        expect(result.ok).toBe(true);
    });

    itIfDb('IN at predicate start is accepted', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL} WHERE A.ACCOUNTKEY IN (1,2)`,
        );
        expect(result.ok).toBe(true);
    });

    itIfDb('IN after a complete predicate is REJECTED', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL} WHERE A.ACCOUNTKEY = 1 IN (2)`,
        );
        expect(result.ok).toBe(false);
    });

    itIfDb('BETWEEN after a complete predicate is REJECTED', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL} WHERE A.ACCOUNTKEY = 1 BETWEEN 1 AND 2`,
        );
        expect(result.ok).toBe(false);
    });

    // Operand-continuation keywords offered by completion after a completed
    // operand (completionExpressionAnalyzer.resolveOperandContinuationKeywords).
    itIfDb('a column directly after a complete predicate is REJECTED', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL} WHERE A.ACCOUNTKEY = 1 ACCOUNTNAME`,
        );
        expect(result.ok).toBe(false);
    });

    itIfDb('SELECT * expanded with a generated alias and leading commas is accepted', async () => {
        const columnReader = await connection.createCommand(
            `SELECT ATTNAME FROM ${DATABASE}.._V_RELATION_COLUMN WHERE NAME = 'DIMACCOUNT' ORDER BY ATTNUM`,
        ).executeReader();
        const columns: string[] = [];
        try {
            while (await columnReader.read()) columns.push(String(columnReader.getValue(0)));
        } finally {
            await columnReader.close();
        }
        expect(columns.length).toBeGreaterThan(0);

        const sql = `SELECT * FROM ${DATABASE}..DIMACCOUNT WHERE 1=0`;
        const context = findSelectStarContext(sql, sql.indexOf('*'));
        const edits = context && buildSelectStarExpansion(sql, context, {
            databaseKind: 'netezza',
            getColumns: () => columns,
        });
        expect(edits).toBeDefined();
        const expanded = applyTextReplacements(sql, edits!);
        expect(expanded).toContain(`FROM ${DATABASE}..DIMACCOUNT D WHERE`);
        expect(await tryExecute(connection, expanded)).toEqual({ ok: true });
    });

    itIfDb('GROUP BY of all non-aggregated SELECT items is accepted', async () => {
        const select = `SELECT A.ACCOUNTKEY, UPPER(A.ACCOUNTTYPE) AS T, COUNT(*) N, 1 FROM ${DATABASE}..DIMACCOUNT A WHERE 1=0 GROUP BY `;
        const groupBy = extractGroupableSelectExpressions(select).join(', ');
        expect(groupBy).toBe('A.ACCOUNTKEY, UPPER(A.ACCOUNTTYPE)');
        expect(await tryExecute(connection, `${select}${groupBy}`)).toEqual({ ok: true });
    });

    it.each([
        ['LIMIT after a WHERE predicate', `${FROM_TAIL} WHERE A.ACCOUNTKEY > 0 LIMIT 1`],
        ['UNION after a WHERE predicate', `SELECT 1 FROM ${DATABASE}..DIMACCOUNT A WHERE 1=0 UNION SELECT 1 FROM ${DATABASE}..DIMDATE${SAFE}`],
        ['WHERE after a JOIN ON predicate', `${FROM_TAIL} JOIN ${JOIN_PARTNER} B ON 1=1 WHERE 1=0`],
        ['LIMIT after GROUP BY', `SELECT A.ACCOUNTKEY FROM ${DATABASE}..DIMACCOUNT A WHERE 1=0 GROUP BY A.ACCOUNTKEY LIMIT 1`],
        ['LIMIT after HAVING', `SELECT COUNT(*) FROM ${DATABASE}..DIMACCOUNT A WHERE 1=0 HAVING 1=1 LIMIT 1`],
        ['NULLS LAST after ORDER BY ... DESC', `${FROM_TAIL} WHERE 1=0 ORDER BY A.ACCOUNTKEY DESC NULLS LAST LIMIT 1`],
        ['ESCAPE after LIKE', `${FROM_TAIL} WHERE 'A%B' LIKE 'A!%%' ESCAPE '!' LIMIT 1`],
        ['OVER after an aggregate in the select list', `SELECT SUM(A.ACCOUNTKEY) OVER () FROM ${DATABASE}..DIMACCOUNT A${SAFE}`],
    ])('%s is accepted', async (_label, sql) => {
        if (skipTests) return;
        const result = await tryExecute(connection, sql);
        expect(result).toEqual({ ok: true });
    });
});

if (skipTests) {
    console.log('⚠️ Netezza completion keyword legality audit skipped: NZ_DEV_PASSWORD not set');
}
