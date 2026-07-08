/**
 * DDL Generator - Synonym DDL Generation
 */

import { executeQueryHelper, quoteNameIfNeeded } from './helpers';
import { NzConnection } from '../../../types';

/**
 * Quote a multi-part identifier (DB.SCHEMA.TABLE) properly.
 * Splits by dots and quotes each part individually.
 */
function quoteMultiPartRef(refObjName: string): string {
    if (!refObjName) return refObjName;
    return refObjName.split('.')
        .map(part => quoteNameIfNeeded(part))
        .join('.');
}

/**
 * Build synonym DDL from metadata
 */
export function buildSynonymDDLFromCache(
    database: string,
    synonymName: string,
    refObjName: string,
    owner: string,
    schema: string,
    description: string | null
): string {
    const cleanDatabase = quoteNameIfNeeded(database);
    const ownerSchema = quoteNameIfNeeded(owner || schema);
    const cleanSynonymName = quoteNameIfNeeded(synonymName);
    const cleanRefObj = quoteMultiPartRef(refObjName);

    const ddlLines: string[] = [];
    ddlLines.push(`CREATE SYNONYM ${cleanDatabase}.${ownerSchema}.${cleanSynonymName} FOR ${cleanRefObj};`);

    if (description) {
        const cleanComment = description.replace(/'/g, "''");
        ddlLines.push(`COMMENT ON SYNONYM ${cleanSynonymName} IS '${cleanComment}';`);
    }

    return ddlLines.join('\n');
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
    const sql = `
        SELECT
            SCHEMA,
            OWNER,
            SYNONYM_NAME,
            REFOBJNAME,
            DESCRIPTION
        FROM ${database.toUpperCase()}.._V_SYNONYM
        WHERE DATABASE = '${database.toUpperCase()}'
            AND SCHEMA = '${schema.toUpperCase()}'
            AND SYNONYM_NAME = '${synonymName.toUpperCase()}'
    `;

    interface SynonymRow {
        SCHEMA: string;
        OWNER: string;
        SYNONYM_NAME: string;
        REFOBJNAME: string;
        DESCRIPTION: string;
    }
    const result = await executeQueryHelper<SynonymRow>(connection, sql);
    const rows = result;

    if (rows.length === 0) {
        throw new Error(`Synonym ${database}.${schema}.${synonymName} not found`);
    }

    const row = rows[0];
    const resolvedRefObjName = await resolveNetezzaSynonymTarget(
        connection, database, row.REFOBJNAME
    );

    return buildSynonymDDLFromCache(
        database,
        synonymName,
        resolvedRefObjName,
        row.OWNER,
        schema,
        row.DESCRIPTION
    );
}

/**
 * Resolve a synonym reference to a fully qualified name.
 * If REFOBJNAME is already fully qualified (contains dots), returns it as-is.
 * Otherwise, looks up the target object in _V_OBJECT_DATA to find its database and schema.
 */
async function resolveNetezzaSynonymTarget(
    connection: NzConnection,
    synonymDatabase: string,
    refObjName: string
): Promise<string> {
    const trimmedRef = refObjName.trim();
    if (trimmedRef.includes('.')) {
        return trimmedRef;
    }

    const upperRef = trimmedRef.toUpperCase();

    try {
        const target = await findTargetInDatabase(connection, synonymDatabase, upperRef);
        if (target) {
            return `${target.DBNAME}.${target.SCHEMA}.${target.OBJNAME}`;
        }

        const databases = await findTargetAcrossDatabases(connection, synonymDatabase, upperRef);
        if (databases.length > 0) {
            const best = databases[0];
            return `${best.DBNAME}.${best.SCHEMA}.${best.OBJNAME}`;
        }
    } catch {
        // If lookup fails, fall back to the original REFOBJNAME value
    }

    return trimmedRef;
}

interface TargetObject {
    DBNAME: string;
    SCHEMA: string;
    OBJNAME: string;
}

async function findTargetInDatabase(
    connection: NzConnection,
    database: string,
    objName: string
): Promise<TargetObject | undefined> {
    const sql = `
        SELECT DBNAME, SCHEMA, OBJNAME
        FROM ${database.toUpperCase()}.._V_OBJECT_DATA
        WHERE UPPER(OBJNAME) = '${objName}'
            AND OBJTYPE IN ('TABLE', 'VIEW', 'EXTERNAL TABLE')
        LIMIT 1
    `;
    const results = await executeQueryHelper<TargetObject>(connection, sql);
    return results.length > 0 ? results[0] : undefined;
}

async function findTargetAcrossDatabases(
    connection: NzConnection,
    synonymDatabase: string,
    objName: string
): Promise<TargetObject[]> {
    const dbListSql = `SELECT DATABASE FROM _V_DATABASE WHERE DATABASE != '${synonymDatabase.toUpperCase()}'`;
    let dbs: { DATABASE: string }[];
    try {
        dbs = await executeQueryHelper<{ DATABASE: string }>(connection, dbListSql);
    } catch {
        return [];
    }

    const results: TargetObject[] = [];
    for (const db of dbs) {
        try {
            const target = await findTargetInDatabase(connection, db.DATABASE, objName);
            if (target) {
                results.push(target);
                break;
            }
        } catch {
                // Skip databases where lookup fails
            }
    }

    return results;
}
