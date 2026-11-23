import * as path from 'node:path';
import { createRequire } from 'node:module';
import { AccessConnection } from '../../extensions/access/src/accessConnection';
import type { DatabaseConnectionConfig } from '../contracts/database';

const FIXTURES = path.join(__dirname, 'fixtures', 'access');
const accessRequire = createRequire(path.join(__dirname, '../../extensions/access/package.json'));
const available = (() => {
    try { accessRequire.resolve('@duckdb/node-api'); return true; } catch { return false; }
})();

function config(database: string, readOnly: boolean): DatabaseConnectionConfig {
    return { host: '', database, user: '', options: { readOnly } };
}

const FILES = [
    'accessLike.mdb',
    'sample2007.accdb',
    'sample2003.mdb',
    'sample_polish.accdb',
    'complex.accdb',
    'functionsV2003.mdb',
    'size97.mdb',
];

(available ? describe : describe.skip)('Access mirror fixture smoke', () => {
    it.each(FILES)('opens %s and answers a count for every table', async file => {
        const connection = new AccessConnection(config(path.join(FIXTURES, file), true));
        await connection.connect();
        try {
            const reader = await connection.createCommand('SELECT * FROM _access_metadata.tables').executeReader();
            const tables: string[] = [];
            try {
                while (await reader.read()) tables.push(String(reader.getValue(0)));
            } finally {
                await reader.close();
            }
            expect(tables.length).toBeGreaterThan(0);
            for (const table of tables) {
                const quoted = table.replace(/"/g, '""');
                const countReader = await connection
                    .createCommand(`SELECT COUNT(*) FROM "${quoted}"`)
                    .executeReader();
                try {
                    expect(await countReader.read()).toBe(true);
                } finally {
                    await countReader.close();
                }
            }
        } finally {
            await connection.close();
        }
    });
});
