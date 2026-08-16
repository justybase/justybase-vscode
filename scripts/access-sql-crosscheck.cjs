'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

require('ts-node/register/transpile-only');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
        return { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const { AccessConnection } = require('../extensions/access/src/accessConnection');
const { translateAccessSql } = require('../extensions/access/src/accessDuckDbMirror');

const repoRoot = path.resolve(__dirname, '..');
const harnessPath = path.join(repoRoot, 'scripts', 'access-com', 'access-com.ps1');

function skip(message) {
    console.log(`ACCESS SQL cross-check skipped: ${message}`);
}

function powershellCommand() {
    return process.env.ACCESS_POWERSHELL || (process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
}

function runHarness(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(powershellCommand(), [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            harnessPath,
            ...args,
        ], {
            cwd: repoRoot,
            env: process.env,
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            reject(new Error(`COM harness timed out: ${args.join(' ')}`));
        }, Number(process.env.ACCESS_COM_TIMEOUT_MS || 30000));
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`COM harness failed (${code}) for ${args.join(' ')}\n${stderr.trim()}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout.trim()));
            } catch (error) {
                reject(new Error(`COM harness returned invalid JSON for ${args.join(' ')}\n${stdout}\n${stderr}`, { cause: error }));
            }
        });
    });
}

function normalizeDate(value) {
    // Access Date/Time has no timezone. Compare the stored wall-clock value;
    // converting DAO's timezone-less ISO text through the local timezone would
    // otherwise introduce a one-hour DST/UTC difference.
    if (value instanceof Date) return value.toISOString().slice(0, 23);
    if (typeof value !== 'string') return undefined;
    const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
    if (!match) return undefined;
    return `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}`;
}

function normalizeValue(value) {
    const date = normalizeDate(value);
    if (date !== undefined) return { date };
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof Uint8Array) return Array.from(value);
    if (typeof value === 'number' && Object.is(value, -0)) return 0;
    return value;
}

function normalizeResult(result) {
    const columns = result.columns.map(column => typeof column === 'string' ? column : column.name);
    const rows = result.rows ?? [];
    return {
        columns: columns.map(column => column.toLowerCase()),
        rows: rows.map(row => Array.isArray(row)
            ? row.map(normalizeValue)
            : columns.map(column => normalizeValue(row[column]))),
    };
}

async function runTs(connection, sql) {
    try {
        const raw = await connection.executeRaw(sql);
        if (raw.rowChunks) {
            const rows = [];
            try {
                for await (const chunk of raw.rowChunks) rows.push(...chunk);
            } finally {
                raw.release?.();
            }
            return { ok: true, result: normalizeResult({ ...raw, rows }) };
        }
        return { ok: true, result: normalizeResult(raw) };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

async function runCom(filePath, sql) {
    try {
        return { ok: true, result: normalizeResult(await runHarness(['select', filePath, sql])) };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

const QUERIES = [
    ['LIKE Access star wildcard', "SELECT id FROM sql_corpus WHERE txt LIKE 'A*' ORDER BY id"],
    ['LIKE character range', "SELECT id FROM sql_corpus WHERE txt LIKE '[A-Z]*' ORDER BY id"],
    ['LIKE negated class', "SELECT id FROM sql_corpus WHERE txt LIKE '[!A]*' ORDER BY id"],
    ['LIKE digit wildcard', "SELECT id FROM sql_corpus WHERE txt LIKE 'A#*' ORDER BY id"],
    ['case-insensitive equality', "SELECT id FROM sql_corpus WHERE txt = 'alpha' ORDER BY id"],
    ['NULL ordering ascending', 'SELECT id, num_value FROM sql_corpus ORDER BY num_value'],
    ['NULL ordering descending', 'SELECT id, num_value FROM sql_corpus ORDER BY num_value DESC'],
    ['DateAdd day', "SELECT id, DateAdd('d', 1, event_date) AS shifted FROM sql_corpus WHERE event_date IS NOT NULL ORDER BY id"],
    ['DateDiff day', "SELECT id, DateDiff('d', event_date, #01/20/2024#) AS days FROM sql_corpus WHERE event_date IS NOT NULL ORDER BY id"],
    ['DatePart intervals', "SELECT DatePart('yyyy', event_date) AS year_part, DatePart('q', event_date) AS quarter_part, DatePart('ww', event_date) AS week_part, DatePart('n', event_date) AS minute_part, DatePart('s', event_date) AS second_part FROM sql_corpus WHERE id = 1"],
    ['ampersand concatenation', "SELECT id, txt & '-' & id AS combined FROM sql_corpus ORDER BY id"],
    ['plus operator semantics', "SELECT id, txt + '-' + id AS plus_value FROM sql_corpus ORDER BY id"],
    ['TRANSFORM/PIVOT', "TRANSFORM Sum(amount) SELECT year_value FROM pivot_data GROUP BY year_value PIVOT region IN ('E','W')"],
];

async function main() {
    if (process.platform !== 'win32') {
        skip('DAO COM is available only on Windows.');
        return;
    }
    if (process.env.ACCESS_COM_VALIDATE !== '1') {
        skip('set ACCESS_COM_VALIDATE=1 to run the opt-in Windows check.');
        return;
    }
    const capabilities = await runHarness(['capabilities']);
    if (!capabilities.dao) {
        skip(capabilities.error || 'no DAO DBEngine COM class is installed.');
        return;
    }

    const externalFile = process.env.ACCESS_SQL_FILE ? path.resolve(process.env.ACCESS_SQL_FILE) : undefined;
    const tempDir = externalFile ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-sql-'));
    const filePath = externalFile ?? path.join(tempDir, 'sql-corpus.accdb');
    try {
        if (!externalFile) {
            await runHarness(['create-db', filePath, 'accdb2007']);
            await runHarness(['apply-ddl', filePath, 'CREATE TABLE sql_corpus (id COUNTER, txt TEXT(50), num_value LONG, amount DOUBLE, event_date DATETIME, CONSTRAINT pk_sql_corpus PRIMARY KEY (id))']);
            await runHarness(['apply-ddl', filePath, 'CREATE TABLE pivot_data (year_value LONG, region TEXT(10), amount DOUBLE)']);
            const corpusRows = [
                "('Alpha-1', 10, 1.25, #01/15/2024 13:30:00#)",
                "('beta', NULL, 2.5, #01/20/2024 00:00:00#)",
                "('A_100', 0, NULL, NULL)",
                "('Zed', 5, 4.75, #02/29/2024 23:59:59#)",
                "(NULL, 20, 0.5, #03/01/2024 01:02:03#)",
            ];
            for (const row of corpusRows) {
                await runHarness(['apply-ddl', filePath, `INSERT INTO sql_corpus (txt, num_value, amount, event_date) VALUES ${row};`]);
            }
            for (const row of [
                "(2024, 'E', 10)",
                "(2024, 'W', 3)",
                "(2025, 'E', 5)",
                "(2025, 'W', 7)",
            ]) {
                await runHarness(['apply-ddl', filePath, `INSERT INTO pivot_data (year_value, region, amount) VALUES ${row};`]);
            }
        }

        const connection = new AccessConnection({
            host: '',
            database: filePath,
            user: '',
            options: { readOnly: true },
        });
        await connection.connect();
        try {
            const selectedQueries = process.env.ACCESS_SQL_ONLY
                ? QUERIES.filter(([name]) => name === process.env.ACCESS_SQL_ONLY)
                : QUERIES;
            for (const [name, sql] of selectedQueries) {
                const [com, ts] = await Promise.all([runCom(filePath, sql), runTs(connection, sql)]);
                assert.equal(ts.ok, com.ok, `${name}: COM=${com.error || 'ok'} TS=${ts.error || 'ok'}`);
                if (com.ok && ts.ok) {
                    try {
                        assert.deepEqual(ts.result, com.result);
                    } catch (error) {
                        console.error(JSON.stringify({
                            name,
                            sql,
                            translated: translateAccessSql(sql),
                            com: com.result,
                            ts: ts.result,
                        }, null, 2));
                        throw error;
                    }
                }
                console.log(`ACCESS SQL cross-check passed: ${name}`);
            }
        } finally {
            await connection.close();
        }
    } finally {
        if (tempDir && process.env.ACCESS_SQL_KEEP_TEMP !== '1') {
            await fs.rm(tempDir, { recursive: true, force: true });
        } else if (tempDir) {
            console.log(`ACCESS SQL cross-check kept temporary corpus: ${tempDir}`);
        }
    }
    const count = process.env.ACCESS_SQL_ONLY ? 1 : QUERIES.length;
    console.log(`ACCESS SQL cross-check passed: ${count} semantic cases.`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
});
