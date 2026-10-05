jest.unmock('chevrotain');
import { analyzeNetezzaPerformance, type PerformanceInput, type PerformanceTable } from '../services/analysis/performanceAdvisor';
import type { ObjectReference } from '../services/analysis/sqlAnalysis';
import { NetezzaTuningAdvisor } from '../dialects/netezza/tuning/netezzaTuningAdvisor';
const context: ObjectReference = { database: 'DB', schema: 'PUBLIC', name: 'QUERY', type: 'UNKNOWN' };
const table = (name: string, keys: string[], extra: Partial<PerformanceTable> = {}): PerformanceTable => ({ object: { ...context, name, type: 'TABLE' }, distribution: keys.length ? { kind: 'hash', keys } : { kind: 'unknown' }, ...extra });
const randomTable = (name: string, extra: Partial<PerformanceTable> = {}): PerformanceTable => ({ object: { ...context, name, type: 'TABLE' }, distribution: { kind: 'random' }, ...extra });
const analyze = (sql: string, extra: Partial<PerformanceInput> = {}) => analyzeNetezzaPerformance({ sql, context, ...extra });
const ids = (report: ReturnType<typeof analyze>) => report.recommendations.map(r => r.id);
const step = (operator: string, rows: number, table = '', indent = '', confidence = 100) => `${indent}${operator}${table ? ` table "${table}"` : ''} (cost=0.0..100.0 rows=${rows}.0 width=32.0 conf=${confidence}.0)`;
describe('Netezza performance evidence', () => {
    const sql = 'SELECT A.ID FROM A JOIN B ON A.ID = B.ID';
    test('distribution mismatch with actionable workload-aware evidence', () => {
        const report = analyze(sql, { tables: [table('A',['ID']), table('B',['OTHER'])] });
        expect(ids(report)).toContain('NZPERF001');
        expect(report.recommendations[0].summary).toMatch(/wider workload/);
        expect(report.recommendations[0].evidence.map(e => e.source)).toContain('table_stats');
    });
    test('aligned distribution produces no warning; full composite key required', () => {
        expect(ids(analyze(sql, { tables: [table('A',['ID']),table('B',['ID'])] }))).not.toContain('NZPERF001');
        expect(ids(analyze(sql, { tables: [table('A',['ID','SECOND']),table('B',['ID','SECOND'])] }))).toContain('NZPERF001');
        expect(ids(analyze('SELECT A.ID FROM A JOIN B ON A.ID = B.ID AND A.SECOND = B.SECOND', { tables: [table('A',['ID','SECOND']),table('B',['ID','SECOND'])] }))).not.toContain('NZPERF001');
    });
    test('skew and missing stats only on referenced relevant tables', () => {
        const report = analyze(sql, { tables: [table('A',['ID'], { rows: 2e6, statisticsState: 'missing', skewRatio: 3 }),table('UNRELATED',['ID'], { skewRatio: 100, rows: 1e9, statisticsState: 'missing' })] });
        expect(ids(report)).toEqual(expect.arrayContaining(['NZPERF002','NZPERF003A']));
        expect(report.recommendations.every(r => r.object?.name !== 'UNRELATED')).toBe(true);
        expect(ids(analyze(sql,{ tables:[table('A',[],{ rows: 20, statisticsState:'missing' })] }))).not.toContain('NZPERF003A');
        expect(ids(analyze(sql,{ tables:[table('A',['ID'],{ rows: 2e6, statisticsState:'available' })] }))).not.toContain('NZPERF003A');
    });
    test('large scans, redistribution and sorts use EXPLAIN; small scans suppressed', () => {
        const report = analyze('SELECT ID FROM A ORDER BY ID', { explainPlanText: [step('Sort',2e6),step('Redistribute',2e6,'','  '),step('Sequential Scan',2e6,'A','    ')].join('\n') });
        expect(ids(report)).toEqual(expect.arrayContaining(['NZPERF004','NZPERF009','NZPERF011']));
        expect(ids(analyze(sql,{ explainPlanText:step('Sequential Scan',100,'A') }))).not.toContain('NZPERF004');
    });
    test('cardinality explosion follows existing structured plan edges', () => {
        const report = analyze(sql, { explainPlanText: [step('Hash Join',2e9),step('Sequential Scan',12e6,'A','  '),step('Sequential Scan',10e6,'B','  ')].join('\n') });
        expect(ids(report)).toContain('NZPERF012');
        expect(report.recommendations.find(r => r.id === 'NZPERF012')?.planNodeIds).toHaveLength(3);
    });
    test('zero confidence is its own NZPERF003B signal, not catalog statistics', () => {
        const report = analyze(sql,{ explainPlanText:step('Sequential Scan',2e6,'A','',0) });
        expect(ids(report)).toContain('NZPERF003B');
        expect(ids(report)).not.toContain('NZPERF003A');
        expect(report.recommendations.find(r=>r.id==='NZPERF003B')?.summary).toMatch(/may be missing/);
    });
    test('RANDOM distribution cannot co-locate joins; UNKNOWN skips alignment', () => {
        expect(ids(analyze(sql, { tables: [table('A',['ID']), randomTable('B')] }))).toContain('NZPERF001');
        expect(ids(analyze(sql, { tables: [randomTable('A'), randomTable('B')] }))).toContain('NZPERF001');
        const unknownReport = analyze(sql, { tables: [table('A',['ID']), table('B',[])] });
        expect(ids(unknownReport)).not.toContain('NZPERF001');
        expect(unknownReport.issues.join(' ')).toContain('alignment check was skipped');
    });
    test('cartesian join and conversion use CST locations', () => {
        const report = analyze("SELECT A.ID FROM A CROSS JOIN B WHERE CAST(A.ID AS VARCHAR) = '1'");
        expect(ids(report)).toEqual(expect.arrayContaining(['NZPERF005','NZPERF007']));
        expect(report.recommendations.every(r => r.sqlRange)).toBe(true);
        expect(ids(analyze(sql))).not.toContain('NZPERF007');
    });
    test('mismatched join types use metadata', () => {
        expect(ids(analyze(sql,{ tables:[table('A',[],{ columns:[{name:'ID',type:'INT'}] }),table('B',[],{ columns:[{name:'ID',type:'VARCHAR(10)'}] })] }))).toContain('NZPERF006');
    });
    test('wide SELECT * fires only for the wildcard-projected table', () => {
        const tables = [table('A',[],{ rows:2e6,columns:Array.from({length:84},(_,i)=>({name:`C${i}`})) })];
        expect(ids(analyze('SELECT * FROM A',{tables}))).toContain('NZPERF008');
        expect(ids(analyze('SELECT COUNT(*) FROM A',{tables}))).not.toContain('NZPERF008');
        expect(ids(analyze('SELECT * FROM A'))).not.toContain('NZPERF008');
        const report = analyze('SELECT A.* FROM A JOIN B ON A.ID = B.ID', { tables: [...tables, table('B',[],{ rows:2e6,columns:Array.from({length:84},(_,i)=>({name:`C${i}`})) })] });
        expect(report.recommendations.filter(r => r.id === 'NZPERF008').map(r => r.object?.name)).toEqual(['A']);
    });
    test.each(['SELECT DISTINCT ID FROM A','SELECT ID FROM A GROUP BY ID','SELECT ID FROM A ORDER BY ID'])('expensive patterns require plan evidence: %s', sql => {
        expect(ids(analyze(sql))).not.toContain('NZPERF009');
        expect(ids(analyze(sql,{ explainPlanText:step('Aggregate',2e6) }))).toContain('NZPERF009');
    });
    test('UNION differs from UNION ALL without suggesting semantic changes', () => {
        expect(ids(analyze('SELECT ID FROM A UNION SELECT ID FROM B'))).toContain('NZPERF010');
        expect(ids(analyze('SELECT ID FROM A UNION ALL SELECT ID FROM B'))).not.toContain('NZPERF010');
    });
    test('incomplete metadata and unknown plan preserve useful partial results', () => {
        const report = analyze('SELECT * FROM A CROSS JOIN B',{explainPlanText:'version-specific unstructured output',issues:['EXPLAIN incomplete']});
        expect(report.issues).toEqual(expect.arrayContaining(['EXPLAIN incomplete']));
        expect(report.plan?.rawPlan).toContain('version-specific');
        expect(ids(report)).toContain('NZPERF007');
        expect(ids(report)).not.toContain('NZPERF001');
    });
    test('existing Netezza advisor owns structured analysis', () => {
        expect(ids(new NetezzaTuningAdvisor().analyzePerformance({sql:'SELECT * FROM A CROSS JOIN B',context}))).toContain('NZPERF007');
    });
});
