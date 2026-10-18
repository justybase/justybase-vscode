import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    buildIndexDefinitionQuery,
    buildObjectTypeQuery,
    buildTriggerDefinitionQuery,
    buildTypeGroupsQuery,
    buildForeignTableColumnOptionsQuery,
    buildForeignTableDefinitionQuery,
} from '../../../../extensions/postgresql/src/postgresqlSystemQueries';
import { postgresqlMetadataProvider } from '../../../../extensions/postgresql/src/postgresqlSchemaProvider';

const manifest = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../../..', 'package.json'), 'utf8'),
) as { contributes: { menus: Record<string, Array<{ command?: string; when?: string }>> } };
const contextMenu = manifest.contributes.menus['view/item/context'] ?? [];

function whensFor(command: string): string[] {
    return contextMenu.filter((entry) => entry.command === command).map((entry) => entry.when ?? '');
}

describe('PostgreSQL tree expansion', () => {
    it('lists materialized views, foreign tables, triggers and indexes as type groups', () => {
        const sql = buildTypeGroupsQuery();
        for (const group of ['MATERIALIZED VIEW', 'FOREIGN TABLE', 'TRIGGER', 'INDEX']) {
            expect(sql).toContain(`'${group}'`);
        }
    });

    it('queries materialized views and foreign tables with their own relkinds', () => {
        expect(buildObjectTypeQuery('MATERIALIZED VIEW')).toContain(`IN ('m')`);
        expect(buildObjectTypeQuery('FOREIGN TABLE')).toContain(`IN ('f')`);
        expect(buildObjectTypeQuery('TABLE')).toContain(`IN ('r', 'p')`);
        expect(buildObjectTypeQuery('VIEW')).toContain(`IN ('v')`);
        expect(buildObjectTypeQuery('TABLE')).not.toContain(`'f'`);
        expect(buildObjectTypeQuery('VIEW')).not.toContain(`'m'`);
    });

    it('queries triggers and indexes from their catalogs', () => {
        const triggerSql = buildObjectTypeQuery('TRIGGER');
        expect(triggerSql).toContain('pg_trigger');
        expect(triggerSql).toContain('NOT t.tgisinternal');
        const indexSql = buildObjectTypeQuery('INDEX');
        expect(indexSql).toContain('pg_index');
        expect(indexSql).toContain('NOT i.indisprimary');
    });

    it('builds single-object definition queries', () => {
        expect(buildIndexDefinitionQuery('public', 'ix')).toContain('pg_get_indexdef');
        expect(buildTriggerDefinitionQuery('public', 'trg')).toContain('pg_get_triggerdef');
        expect(buildForeignTableDefinitionQuery('public', 'ft')).toContain('pg_foreign_table');
        expect(buildForeignTableColumnOptionsQuery('public', 'ft')).toContain('attoptions');
    });

    it('exposes the new object types through the metadata provider', () => {
        expect(postgresqlMetadataProvider.defaultObjectTypes).toEqual(
            expect.arrayContaining(['MATERIALIZED VIEW', 'FOREIGN TABLE', 'TRIGGER', 'INDEX']),
        );
        expect(postgresqlMetadataProvider.defaultColumnObjectTypes).toEqual(
            expect.arrayContaining(['MATERIALIZED VIEW', 'FOREIGN TABLE']),
        );
    });

    it('offers DDL for triggers, indexes and foreign tables', () => {
        const ddlWhens = whensFor('netezza.createDDL');
        expect(ddlWhens.length).toBeGreaterThan(0);
        for (const when of ddlWhens) {
            expect(when).toContain('TRIGGER');
            expect(when).toContain('INDEX');
            expect(when).toContain('FOREIGN TABLE');
        }
    });

    it('offers select and drop for materialized and foreign tables', () => {
        for (const command of ['netezza.copySelectAll', 'netezza.copyDrop']) {
            const whens = whensFor(command);
            expect(whens.length).toBeGreaterThan(0);
            for (const when of whens) {
                expect(when).toContain('MATERIALIZED VIEW');
                expect(when).toContain('FOREIGN TABLE');
            }
        }
    });
});
