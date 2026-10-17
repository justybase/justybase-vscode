jest.unmock('chevrotain');

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parseSqlStatements } from '../../sqlParser/parsingRuntime';

interface ParserCase {
    id: string;
    dialect: string;
    sql: string;
    expect: { valid: boolean };
    tags?: string[];
    verification: { status: string };
}

const root = path.join(__dirname, 'fixtures', 'sqlConformance');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'snapshot.json'), 'utf8')) as {
    contentHash: string;
    files: Record<string, string>;
};
const cases = Object.keys(snapshot.files).filter(file => file.endsWith('.jsonl')).flatMap(file =>
    fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).filter(Boolean)
        .map(line => JSON.parse(line) as ParserCase),
).filter(testCase => testCase.tags?.includes('multidialect-live-baseline'));

describe('Shared SQL live baseline', () => {
    it('uses a complete, pinned snapshot with intact content hashes', () => {
        const orderedHashes = Object.fromEntries(Object.entries(snapshot.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        expect(createHash('sha256').update(JSON.stringify(orderedHashes)).digest('hex')).toBe(snapshot.contentHash);
        for (const [file, expected] of Object.entries(snapshot.files)) {
            // Git may check out text fixtures with CRLF on Windows.
            const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
            expect(createHash('sha256').update(text).digest('hex')).toBe(expected);
        }
        expect(cases.length).toBeGreaterThan(0);
        expect(new Set(cases.map(testCase => testCase.id)).size).toBe(cases.length);
    });

    it.each(cases)('$id', testCase => {
        expect(testCase.verification.status).toBe('oracleVerified');
        const result = parseSqlStatements({
            sql: testCase.sql.replace(/\{\{cf\}\}/g, 'JB_CF_FIXTURE'),
            databaseKind: testCase.dialect,
        });
        const errors = [...result.lexResult.errors, ...result.actionableParserErrors];
        if (testCase.expect.valid) {
            expect(errors.map(error => error.message)).toEqual([]);
            expect(result.cst).toBeDefined();
        } else {
            expect(errors.length).toBeGreaterThan(0);
        }
    });
});
