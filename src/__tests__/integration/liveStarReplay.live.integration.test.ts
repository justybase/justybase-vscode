/**
 * Live JOIN ranking replay over the AdventureWorksDW and MIS star schemas.
 *
 * Validates that every corpus statement runs on the development Netezza, loads
 * an identifier-only catalog of the whole schema (realistic noise included) and
 * replays every JOIN position in three regimes:
 *
 * - workspace: leave-one-file-out workspace evidence, no catalog;
 * - catalog: cold start, catalog FK + key/name heuristics only;
 * - combined: both, as in a real installation with an open connection.
 *
 * Opt-in: requires `NZ_DEV_PASSWORD` (read-only; no DDL). Set
 * `JOIN_REPLAY_REPORT=<file>` to write the Markdown report and
 * `JOIN_REPLAY_DETAILS=<file>` for per-case JSON (identifiers only).
 * `JOIN_REPLAY_HISTORY=<query-history.msgpack.gz>[:<more>]` additionally
 * replays the extension's own query history (text stays in memory).
 */
import { promises as fs } from 'fs';
import type { NzConnection } from '@justybase/netezza-driver';
import {
    formatJoinRankingReplayReport,
    runJoinRankingReplay,
    summarizeJoinRankingCases,
    summarizeKeystrokes,
    type JoinRankingReplayReport,
} from '../../knowledge/joinRankingReplay';
import { CatalogReplayMetadataProvider, type ReplayCatalog } from '../../knowledge/replayCatalog';
import { SqlParser } from '../../sql/sqlParser';
import { LIVE_STAR_CORPUS, LIVE_STAR_CORPUS_NOW } from '../knowledge/fixtures/liveStarCorpus';
import {
    buildNetezzaLiveDetails,
    createNetezzaLiveConnection,
    netezzaLiveEnabled,
    readRows,
} from './netezzaLiveTestHarness';
import { historyReplayFilesFromEnv, loadHistoryReplayCorpus } from './historyReplayCorpus';
import { loadNetezzaReplayCatalog } from './netezzaReplayCatalog';

jest.unmock('chevrotain');

const describeLive = netezzaLiveEnabled ? describe : describe.skip;

describeLive('live star-schema JOIN ranking replay', () => {
    const details = buildNetezzaLiveDetails();
    const database = details.database.toUpperCase();
    const schema = (details.schema ?? 'ADMIN').toUpperCase();
    let connection: NzConnection;
    let catalog: ReplayCatalog;

    beforeAll(async () => {
        connection = createNetezzaLiveConnection();
        await connection.connect();
        catalog = await loadNetezzaReplayCatalog(connection, database, schema);
    }, 120_000);

    afterAll(async () => {
        await connection?.close();
    });

    it('executes every corpus statement on the live database', async () => {
        const failures: string[] = [];
        for (const file of LIVE_STAR_CORPUS) {
            for (const statement of SqlParser.splitStatements(file.text)) {
                const sql = statement.trim().replace(/;$/u, '');
                if (!sql) continue;
                try {
                    await readRows(connection, `SELECT COUNT(*) FROM (${sql}) Q`);
                } catch (error: unknown) {
                    failures.push(`${file.relPath}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
        expect(failures).toEqual([]);
    }, 300_000);

    it('measures workspace, catalog and combined regimes', async () => {
        const metadataProvider = new CatalogReplayMetadataProvider(catalog, 'netezza');
        const base = {
            databaseKind: 'netezza' as const,
            effectiveDatabase: database,
            effectiveSchema: schema,
            now: LIVE_STAR_CORPUS_NOW,
        };
        const workspace = await runJoinRankingReplay(LIVE_STAR_CORPUS, base);
        const cold = await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...base, metadataProvider, evidence: 'none' });
        const combined = await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...base, metadataProvider });
        const predicates = await runJoinRankingReplay(LIVE_STAR_CORPUS, {
            ...base,
            metadataProvider,
            mode: 'predicate',
        });

        const summary = (label: string, report: JoinRankingReplayReport): string =>
            formatJoinRankingReplayReport(report, `${label} (${catalog.tables.length} catalog tables)`, 200);
        if (process.env.JOIN_REPLAY_REPORT) {
            await fs.writeFile(process.env.JOIN_REPLAY_REPORT, [
                summary('Workspace evidence only', workspace),
                summary('Catalog only (cold start)', cold),
                summary('Catalog + workspace evidence', combined),
                summary('ON conditions, catalog + workspace evidence', predicates),
            ].join('\n'), 'utf8');
        }

        if (process.env.JOIN_REPLAY_DETAILS) {
            await fs.writeFile(
                process.env.JOIN_REPLAY_DETAILS,
                JSON.stringify({ workspace: workspace.details, cold: cold.details, combined: combined.details }),
                'utf8',
            );
        }

        expect(workspace.cases).toBe(cold.cases);
        expect(combined.cases).toBe(cold.cases);
        // Catalog metadata must never cost what workspace evidence found, and
        // together they must offer every target either regime offers.
        expect(combined.tieAwareMrr).toBeGreaterThan(workspace.tieAwareMrr);
        expect(combined.covered).toBeGreaterThanOrEqual(Math.max(workspace.covered, cold.covered));
        expect(predicates.covered).toBe(predicates.cases);
    }, 300_000);

    it('measures columns per clause with catalog types', async () => {
        const metadataProvider = new CatalogReplayMetadataProvider(catalog, 'netezza');
        const base = {
            databaseKind: 'netezza' as const,
            effectiveDatabase: database,
            effectiveSchema: schema,
            now: LIVE_STAR_CORPUS_NOW,
            metadataProvider,
            mode: 'column' as const,
        };
        const lines = ['# Live columns per clause (tie-averaged MRR)', '', '| Clause | Cases | Cold | Learned | Cold, 1 char |', '|---|---|---|---|---|'];
        const cold = await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...base, evidence: 'none' });
        const learned = await runJoinRankingReplay(LIVE_STAR_CORPUS, base);
        const typed = await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...base, evidence: 'none', typed: 1 });
        const clauses = [...new Set(cold.details.map((entry) => entry.clause ?? '?'))].sort();
        const mrr = (report: JoinRankingReplayReport, clause?: string): string => {
            const cases = report.details.filter((entry) => clause === undefined || entry.clause === clause);
            return summarizeJoinRankingCases(cases).tieAwareMrr.toFixed(3);
        };
        for (const clause of [...clauses, undefined]) {
            const count = cold.details.filter((entry) => clause === undefined || entry.clause === clause).length;
            lines.push(`| ${clause ?? 'all'} | ${count} | ${mrr(cold, clause)} | ${mrr(learned, clause)} | ${mrr(typed, clause)} |`);
        }
        const keystrokes = async (evidence: 'none' | 'workspace') => {
            const runs = async (mode: 'column' | 'object', typedCounts: number[]) => Promise.all(typedCounts.map(async (count) => ({
                typed: count,
                report: await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...base, evidence, mode, typed: count }),
            })));
            const single = async (mode: 'target' | 'predicate') => summarizeKeystrokes(
                [{ typed: 0, report: await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...base, evidence, mode }) }],
                { ghost: mode },
            );
            return [
                summarizeKeystrokes(await runs('column', [0, 1, 2, 3])),
                summarizeKeystrokes(await runs('object', [1, 2, 3])),
                await single('target'),
                await single('predicate'),
            ].map((summary) => `${(summary.savedRatio * 100).toFixed(1)}%`);
        };
        lines.push('', '# Live saved keystrokes', '', '| Evidence | Columns | FROM | JOIN target | ON |', '|---|---|---|---|---|');
        lines.push(`| catalog | ${(await keystrokes('none')).join(' | ')} |`);
        lines.push(`| catalog + workspace | ${(await keystrokes('workspace')).join(' | ')} |`);
        if (process.env.JOIN_REPLAY_REPORT) {
            await fs.appendFile(process.env.JOIN_REPLAY_REPORT, `\n${lines.join('\n')}\n`, 'utf8');
        }
        expect(cold.details.some((entry) => entry.clause === 'aggregate')).toBe(true);
    }, 300_000);

    const historyFiles = historyReplayFilesFromEnv();
    (historyFiles.length > 0 ? it : it.skip)('measures the extension query history', async () => {
        const corpus = await loadHistoryReplayCorpus(historyFiles, database);
        const metadataProvider = new CatalogReplayMetadataProvider(catalog, 'netezza');
        const base = {
            databaseKind: 'netezza' as const,
            effectiveDatabase: database,
            effectiveSchema: schema,
            now: new Date().toISOString(),
        };
        const regimes: Array<[string, JoinRankingReplayReport]> = [
            ['History: workspace evidence only', await runJoinRankingReplay(corpus, base)],
            ['History: catalog only', await runJoinRankingReplay(corpus, { ...base, metadataProvider, evidence: 'none' })],
            ['History: catalog + evidence', await runJoinRankingReplay(corpus, { ...base, metadataProvider })],
            ['History: ON conditions', await runJoinRankingReplay(corpus, { ...base, metadataProvider, mode: 'predicate' })],
        ];
        const report = regimes
            .map(([label, result]) => formatJoinRankingReplayReport(result, `${label} (${corpus.length} statements)`, 50))
            .join('\n');
        if (process.env.JOIN_REPLAY_REPORT) {
            await fs.appendFile(process.env.JOIN_REPLAY_REPORT, `\n${report}`, 'utf8');
        }
        expect(regimes[0][1].cases).toBe(regimes[2][1].cases);
    }, 300_000);

    (historyFiles.length > 0 ? it : it.skip)('measures earlier statements of the same worksheet', async () => {
        const corpus = await loadHistoryReplayCorpus(historyFiles, database, { worksheets: true });
        const metadataProvider = new CatalogReplayMetadataProvider(catalog, 'netezza');
        const base = {
            databaseKind: 'netezza' as const,
            effectiveDatabase: database,
            effectiveSchema: schema,
            now: new Date().toISOString(),
            metadataProvider,
        };
        const modes = [
            ['FROM sources, one character', { mode: 'object' as const, typed: 1 }],
            ['Columns after alias.', { mode: 'column' as const }],
            ['Columns after alias., one character', { mode: 'column' as const, typed: 1 }],
            ['JOIN targets', { mode: 'target' as const }],
        ] as const;
        const sections: string[] = [];
        for (const [label, mode] of modes) {
            for (const [regime, evidence] of [
                ['index off', { evidence: 'none' as const }],
                ['index off + worksheet', { evidence: 'none' as const, documentEvidence: true }],
                ['index on', {}],
                ['index on + worksheet', { documentEvidence: true }],
            ] as const) {
                const result = await runJoinRankingReplay(corpus, { ...base, ...mode, ...evidence });
                sections.push(formatJoinRankingReplayReport(
                    result,
                    `Worksheets (${corpus.length}): ${label}, ${regime}`,
                    0,
                ));
            }
        }
        if (process.env.JOIN_REPLAY_REPORT) {
            await fs.appendFile(process.env.JOIN_REPLAY_REPORT, `\n${sections.join('\n')}`, 'utf8');
        }
        expect(corpus.length).toBeGreaterThan(0);
    }, 600_000);
});
