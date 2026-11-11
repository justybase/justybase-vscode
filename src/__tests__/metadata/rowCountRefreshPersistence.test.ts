/**
 * Regression guard: a partial catalog refresh must not erase the
 * `_V_TABLE.RELTUPLES` estimate that the schema tree and suggestions show.
 *
 * Every refresh path used to treat the incoming row as authoritative, so a
 * refresh from a query without `RELTUPLES` (generic type-group query, mirrored
 * system catalog pass, view refresh) silently removed `~4k rows` from the tree
 * until another refresh happened to restore it.
 */
import { mergeTableLikeObjectsForSchema } from '../../metadata/helpers';
import { replaceTableObjectTypeForDatabase } from '../../metadata/cache/tableObjectMutation';
import type { TableMetadata } from '../../metadata/types';
import type { MetadataCachePort } from '../../metadata/cache/metadataCachePort';

function table(name: string, overrides: Partial<TableMetadata> = {}): TableMetadata {
    return {
        OBJNAME: name,
        TABLENAME: name,
        SCHEMA: 'ADMIN',
        label: name,
        objType: 'TABLE',
        kind: 6,
        ...overrides,
    };
}

describe('estimated row count survives catalog refreshes', () => {
    it('keeps the cached estimate when the refreshed type group has no RELTUPLES', () => {
        const existing = [table('DIMDATE', { rowCount: 4213 }), table('DIMACCOUNT', { rowCount: 99 })];
        const refreshed = [table('DIMDATE'), table('DIMACCOUNT')];

        const merged = mergeTableLikeObjectsForSchema(existing, refreshed, 'TABLE');

        expect(merged.find(row => row.OBJNAME === 'DIMDATE')?.rowCount).toBe(4213);
        expect(merged.find(row => row.OBJNAME === 'DIMACCOUNT')?.rowCount).toBe(99);
    });

    it('replaces the estimate when the refresh reports a new value', () => {
        const existing = [table('DIMDATE', { rowCount: 4213 })];
        const refreshed = [table('DIMDATE', { rowCount: 4300 })];

        const merged = mergeTableLikeObjectsForSchema(existing, refreshed, 'TABLE');

        expect(merged).toHaveLength(1);
        expect(merged[0].rowCount).toBe(4300);
    });

    it('keeps estimates for other object types in the same schema layer', () => {
        const existing = [
            table('DIMDATE', { rowCount: 4213 }),
            table('V_DIMDATE', { objType: 'VIEW', kind: 18 }),
        ];
        const refreshed = [table('V_DIMDATE', { objType: 'VIEW', kind: 18 })];

        const merged = mergeTableLikeObjectsForSchema(existing, refreshed, 'VIEW');

        expect(merged.find(row => row.OBJNAME === 'DIMDATE')?.rowCount).toBe(4213);
    });

    it('keeps the estimate when a type-group refresh replaces every row', () => {
        const stored = new Map<string, TableMetadata[]>([
            ['DB.ADMIN', [table('DIMDATE', { rowCount: 4213 })]],
            ['DB..', [table('DIMDATE', { rowCount: 4213 })]],
        ]);
        const cache = {
            getTables: (_connection: string, key: string) => stored.get(key),
            getTablesAllSchemas: () => stored.get('DB..'),
            setTables: (_connection: string, key: string, rows: TableMetadata[]) => {
                stored.set(key, rows);
            },
            markObjectsCatalogLoaded: () => undefined,
        } as unknown as MetadataCachePort;

        replaceTableObjectTypeForDatabase(
            cache,
            'CONN',
            'DB',
            'TABLE',
            [table('DIMDATE')],
        );

        expect(stored.get('DB.ADMIN')?.[0].rowCount).toBe(4213);
    });
});
