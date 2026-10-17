/**
 * Local-only loader for the shared JustyBase.SqlConformance corpus.
 *
 * SQL conformance tests are explicit developer tests. They read the corpus
 * directly from JUSTYBASE_SQL_CONFORMANCE_PATH and never fall back to
 * committed fixtures: this repository does not vendor the corpus.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SQL_CONFORMANCE_REQUIRED_MESSAGE =
    'JUSTYBASE_SQL_CONFORMANCE_PATH is required for local SQL conformance tests.';

export interface SqlConformanceCase {
    id: string;
    dialect: string;
    sql: string;
    appliesTo?: string[];
    contract?: string;
    category?: string;
    tags?: string[];
    cursorMarker?: string;
    metadataFixture?: string;
    verification?: { status?: string };
    expect: { valid?: boolean; [key: string]: unknown };
    [key: string]: unknown;
}

export interface SqlConformanceMetadataFixture {
    databases: {
        name: string;
        schemas: {
            name: string;
            tables: { name: string; columns: { name: string; type: string }[] }[];
        }[];
    }[];
    executionContext: { serverVersionNum?: number; [key: string]: unknown };
    [key: string]: unknown;
}

export function resolveSqlConformanceRoot(): string {
    const configured = process.env.JUSTYBASE_SQL_CONFORMANCE_PATH;
    if (!configured || configured.trim().length === 0) {
        throw new Error(SQL_CONFORMANCE_REQUIRED_MESSAGE);
    }
    const full = path.resolve(configured);
    if (!fs.existsSync(path.join(full, 'dialects'))) {
        throw new Error(
            `JUSTYBASE_SQL_CONFORMANCE_PATH does not contain a SQL conformance corpus (missing dialects/): ${full}`,
        );
    }
    return full;
}

function collectJsonlFiles(directory: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) out.push(...collectJsonlFiles(full));
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
    return out.sort();
}

/** Load every JSONL case under <root>/dialects (deterministic file order). */
export function loadSqlConformanceCases(root: string): SqlConformanceCase[] {
    const cases: SqlConformanceCase[] = [];
    for (const file of collectJsonlFiles(path.join(root, 'dialects'))) {
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            if (!line.trim()) continue;
            cases.push(JSON.parse(line) as SqlConformanceCase);
        }
    }
    return cases;
}

function isPostgresqlCase(testCase: SqlConformanceCase): boolean {
    return testCase.dialect === 'postgresql'
        || (testCase.dialect === 'common' && (testCase.appliesTo ?? []).includes('postgresql'));
}

/** Mirror of the former committed export: postgresql + applicable common cases, sorted by id. */
export function selectPostgresqlCases(allCases: SqlConformanceCase[]): SqlConformanceCase[] {
    const selected = allCases.filter(isPostgresqlCase);
    selected.sort((a, b) => a.id.localeCompare(b.id));
    return selected;
}

export function assertConformanceCasesSane(cases: SqlConformanceCase[]): void {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map(testCase => testCase.id)).size).toBe(cases.length);
}

const metadataFixtureCache = new Map<string, SqlConformanceMetadataFixture>();

export function loadSqlConformanceMetadataFixture(root: string, id: string): SqlConformanceMetadataFixture {
    const cached = metadataFixtureCache.get(root + '\0' + id);
    if (cached) return cached;
    const file = path.join(root, 'fixtures', 'metadata', id + '.json');
    if (!fs.existsSync(file)) {
        throw new Error(`SQL conformance metadata fixture not found in the corpus: ${id}`);
    }
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8')) as SqlConformanceMetadataFixture;
    metadataFixtureCache.set(root + '\0' + id, fixture);
    return fixture;
}
