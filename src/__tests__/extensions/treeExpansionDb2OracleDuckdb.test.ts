import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    buildObjectTypeQuery,
    buildTypeGroupsQuery,
} from '../../../extensions/db2/src/db2SystemQueries';
import {
    buildObjectTypeQuery as buildOracleObjectTypeQuery,
    buildTypeGroupsQuery as buildOracleTypeGroupsQuery,
    mapObjectTypeToDbmsMetadataType,
    ORACLE_DEFAULT_COLUMN_OBJECT_TYPES,
    ORACLE_DEFAULT_OBJECT_TYPES,
} from '../../../extensions/oracle/src/oracleSystemQueries';
import {
    buildObjectTypeQuery as buildDuckDbObjectTypeQuery,
    buildTypeGroupsQuery as buildDuckDbTypeGroupsQuery,
} from '../../../extensions/duckdb/src/duckdbSystemQueries';
import { db2MetadataProvider } from '../../../extensions/db2/src/db2SchemaProvider';
import { duckdbMetadataProvider } from '../../../extensions/duckdb/src/duckdbSchemaProvider';

const manifest = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../..', 'package.json'), 'utf8'),
) as { contributes: { menus: Record<string, Array<{ command?: string; when?: string }>> } };
const contextMenu = manifest.contributes.menus['view/item/context'] ?? [];

function whensFor(command: string): string[] {
    return contextMenu.filter((entry) => entry.command === command).map((entry) => entry.when ?? '');
}

describe('Db2 tree expansion', () => {
    it('lists sequences, indexes, triggers, MQTs and tablespaces as type groups', () => {
        const sql = buildTypeGroupsQuery();
        for (const group of ['MATERIALIZED QUERY TABLE', 'SEQUENCE', 'INDEX', 'TRIGGER', 'TABLESPACE']) {
            expect(sql).toContain(`SELECT '${group}' AS OBJTYPE`);
        }
    });

    it('queries sequences, indexes, triggers and tablespaces from their catalogs', () => {
        expect(buildObjectTypeQuery('SEQUENCE')).toContain('SYSCAT.SEQUENCES');
        expect(buildObjectTypeQuery('INDEX')).toContain('SYSCAT.INDEXES');
        expect(buildObjectTypeQuery('TRIGGER')).toContain('SYSCAT.TRIGGERS');
        expect(buildObjectTypeQuery('TABLESPACE')).toContain('SYSCAT.TABLESPACES');
        expect(buildObjectTypeQuery('MATERIALIZED QUERY TABLE')).toContain(`'S'`);
    });

    it('exposes the new object types through the metadata provider', () => {
        expect(db2MetadataProvider.defaultObjectTypes).toEqual(
            expect.arrayContaining(['MATERIALIZED QUERY TABLE', 'SEQUENCE', 'INDEX', 'TRIGGER', 'TABLESPACE']),
        );
        expect(db2MetadataProvider.defaultColumnObjectTypes).toContain('MATERIALIZED QUERY TABLE');
    });

    it('offers DDL for triggers, indexes and sequences', () => {
        const ddlWhens = whensFor('netezza.createDDL');
        expect(ddlWhens.length).toBeGreaterThan(0);
        for (const when of ddlWhens) {
            expect(when).toContain('TRIGGER');
            expect(when).toContain('INDEX');
        }
    });
});

describe('Oracle tree expansion', () => {
    it('lists materialized views and indexes as type groups', () => {
        expect(ORACLE_DEFAULT_OBJECT_TYPES).toContain('MATERIALIZED VIEW');
        expect(ORACLE_DEFAULT_OBJECT_TYPES).toContain('INDEX');
        expect(ORACLE_DEFAULT_COLUMN_OBJECT_TYPES).toContain('MATERIALIZED VIEW');
    });

    it('resolves materialized views through the table-like query', () => {
        expect(buildOracleObjectTypeQuery('MATERIALIZED VIEW')).toContain('MATERIALIZED VIEW');
    });

    it('maps materialized views to the DBMS_METADATA type', () => {
        expect(mapObjectTypeToDbmsMetadataType('MATERIALIZED VIEW')).toBe('MATERIALIZED_VIEW');
        expect(mapObjectTypeToDbmsMetadataType('PACKAGE BODY')).toBe('PACKAGE_BODY');
    });

    it('keeps the Oracle type groups query in sync with defaults', () => {
        const sql = buildOracleTypeGroupsQuery();
        for (const group of ORACLE_DEFAULT_OBJECT_TYPES) {
            expect(sql).toContain(`'${group}'`);
        }
    });
});

describe('DuckDB tree expansion', () => {
    it('lists indexes as a type group backed by duckdb_indexes()', () => {
        expect(buildDuckDbTypeGroupsQuery()).toContain(`'INDEX'`);
        expect(buildDuckDbObjectTypeQuery('', 'INDEX')).toContain('duckdb_indexes()');
    });

    it('exposes indexes through the metadata provider', () => {
        expect(duckdbMetadataProvider.defaultObjectTypes).toContain('INDEX');
    });
});
