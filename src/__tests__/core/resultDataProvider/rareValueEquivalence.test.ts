import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteResultStore } from '../../../core/resultDataProvider/sqliteResultStore';
import type { DiskGroupStatsResult } from '../../../core/resultDataProvider/types';
import { buildDiskGroupDataset, type AnalysisColumn } from '../../../../media/resultPanel/analytical/diskAdapter';
import { computeGroupStatsSync } from '../../../../media/resultPanel/analytical/computeGroupStats';
import type { AnalyticalGroupColumnRef } from '../../../../media/resultPanel/analytical/types';

function isNodeSqliteAvailable(): boolean {
    try {
        require('node:sqlite');
        return true;
    } catch {
        return false;
    }
}

const describeIfSqlite = isNodeSqliteAvailable() ? describe : describe.skip;

const COLUMNS: AnalysisColumn[] = [
    { index: 0, name: 'region', role: 'dimension' },
    { index: 1, name: 'code', role: 'dimension' },
];
const GROUP: AnalyticalGroupColumnRef[] = [{ index: 0, name: 'region' }];

/** Shared codes appear in every group; Z9 (twice) belongs to G3 alone; Y1 (once) to G1 alone. */
function buildRows(): unknown[][] {
    const rows: unknown[][] = [];
    const shared = ['S1', 'S2', 'S3', 'S4'];
    for (let i = 0; i < 120; i++) {
        const region = ['G1', 'G2', 'G3'][i % 3];
        let code = shared[i % shared.length];
        if (region === 'G3' && (i === 2 || i === 5)) code = 'Z9';
        if (region === 'G1' && i === 3) code = 'Y1';
        rows.push([region, code]);
    }
    return rows;
}

describeIfSqlite('RARE_VALUE on disk equals the in-memory engine', () => {
    const tempPaths: string[] = [];
    let store: SqliteResultStore | undefined;
    let rows: unknown[][];

    beforeEach(() => {
        rows = buildRows();
        const dbPath = path.join(os.tmpdir(), `justybase-rare-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
        tempPaths.push(dbPath);
        store = SqliteResultStore.create([{ name: 'region', type: 'VARCHAR' }, { name: 'code', type: 'VARCHAR' }], 1000, dbPath);
        store.insertRows(rows);
        store.finalizeBulkInsert();
    });

    afterEach(() => {
        store?.dispose();
        store = undefined;
        for (const tempPath of tempPaths.splice(0)) {
            try {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } catch {
                // ignore cleanup failures
            }
        }
    });

    it('reports the same rare values per group on both paths, and none for unlisted-owner or shared values', () => {
        const memory = computeGroupStatsSync({ columns: COLUMNS.map(c => ({ ...c })), rows, groupColumns: GROUP });
        const batch: DiskGroupStatsResult = store!.queryGroupStats({
            groupColumns: [0],
            statColumns: [1],
            limit: 100,
            rareColumns: [1],
        });
        const disk = buildDiskGroupDataset({ columns: COLUMNS, groupColumns: GROUP, batches: [batch] });

        const rareOf = (dataset: typeof memory, label: string) => {
            const group = dataset.groups.find(item => item.values[0] === label);
            return group?.columns.find(column => column.columnIndex === 1)?.rare ?? null;
        };
        expect(rareOf(disk, 'G3')).toEqual({ total: 1, examples: ['Z9'] });
        expect(rareOf(disk, 'G1')).toEqual({ total: 1, examples: ['Y1'] });
        expect(rareOf(disk, 'G2')).toBeNull();

        for (const label of ['G1', 'G2', 'G3']) {
            expect(rareOf(disk, label)).toEqual(rareOf(memory, label));
        }
    });
});
