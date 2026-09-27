/**
 * DDL Generator - Synonym DDL Generation
 */

import { buildNetezzaSynonymDdl } from '@justybase/designer-core';
import { executeQueryHelper } from './helpers';
import { NzConnection } from '../../../types';
import {
    buildNetezzaIdentifierEquality,
    createNetezzaCatalogIdentifier,
    formatNetezzaIdentifier,
} from '../metadata/identifierUtils';

/**
 * Build synonym DDL from metadata
 */
export function buildSynonymDDLFromCache(
    database: string,
    synonymName: string,
    refObjName: string,
    owner: string,
    schema: string,
    description: string | null,
    referenceDatabase?: string | null,
    referenceSchema?: string | null
): string {
    return buildNetezzaSynonymDdl(database, schema, synonymName, {
        schema,
        synonymName,
        referenceObjectName: refObjName,
        referenceDatabase,
        referenceSchema,
        owner,
        description,
    });
}

/**
 * Generate DDL code for creating a synonym in Netezza
 */
export async function generateSynonymDDL(
    connection: NzConnection,
    database: string,
    schema: string,
    synonymName: string
): Promise<string> {
    const databaseIdentifier = createNetezzaCatalogIdentifier(database);
    const qualifiedDatabase = formatNetezzaIdentifier(databaseIdentifier);
    const sql = `
        SELECT
            SCHEMA,
            OWNER,
            SYNONYM_NAME,
            REFOBJNAME,
            REFDATABASE,
            REFSCHEMA,
            DESCRIPTION
        FROM ${qualifiedDatabase}.._V_SYNONYM
        WHERE ${buildNetezzaIdentifierEquality('DATABASE', databaseIdentifier)}
            AND ${buildNetezzaIdentifierEquality('SCHEMA', createNetezzaCatalogIdentifier(schema))}
            AND ${buildNetezzaIdentifierEquality('SYNONYM_NAME', createNetezzaCatalogIdentifier(synonymName))}
    `;

    interface SynonymRow {
        SCHEMA: string;
        OWNER: string;
        SYNONYM_NAME: string;
        REFOBJNAME: string;
        REFDATABASE: string | null;
        REFSCHEMA: string | null;
        DESCRIPTION: string;
    }
    const result = await executeQueryHelper<SynonymRow>(connection, sql);
    const rows = result;

    if (rows.length === 0) {
        throw new Error(`Synonym ${database}.${schema}.${synonymName} not found`);
    }

    const row = rows[0];

    return buildSynonymDDLFromCache(
        database,
        synonymName,
        row.REFOBJNAME,
        row.OWNER,
        schema,
        row.DESCRIPTION,
        row.REFDATABASE,
        row.REFSCHEMA
    );
}
