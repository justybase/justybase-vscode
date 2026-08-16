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

const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password',
};

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

    const FROM_TAIL = 'SELECT * FROM JUST_DATA..DIMACCOUNT A';
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
            `${FROM_TAIL.replace('SELECT *', 'SELECT 1')} UNION SELECT 1 FROM JUST_DATA..DIMDATE${SAFE}`,
        );
        expect(result.ok).toBe(true);
    });

    itIfDb('INTERSECT after FROM alias is accepted (matching column counts)', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL.replace('SELECT *', 'SELECT 1')} INTERSECT SELECT 1 FROM JUST_DATA..DIMDATE${SAFE}`,
        );
        expect(result.ok).toBe(true);
    });

    itIfDb('EXCEPT after FROM alias is accepted (matching column counts)', async () => {
        const result = await tryExecute(
            connection,
            `${FROM_TAIL.replace('SELECT *', 'SELECT 1')} EXCEPT SELECT 1 FROM JUST_DATA..DIMDATE${SAFE}`,
        );
        expect(result.ok).toBe(true);
    });

    itIfDb('HAVING without GROUP BY is accepted', async () => {
        const result = await tryExecute(
            connection,
            `SELECT COUNT(*) FROM JUST_DATA..DIMACCOUNT A WHERE 1=0 HAVING 1=1`,
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
});

if (skipTests) {
    console.log('⚠️ Netezza completion keyword legality audit skipped: NZ_DEV_PASSWORD not set');
}
