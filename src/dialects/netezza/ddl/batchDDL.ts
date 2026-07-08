import {
    ColumnInfo,
    KeyInfo,
    BatchDDLOptions,
    BatchDDLResult,
    ProcedureInfo,
    ExternalTableInfo
} from './types';
import { executeQueryHelper, createConnectionFromDetails, fixProcReturnType } from '../../../ddl/helpers';
import { buildSchemaFilter, buildDatabaseFilter, escapeSqlIdentifier } from '../../../utils/sqlUtils';
import { NzConnection } from '../../../types';
import { buildTableDDLFromCache } from '../../../ddl/tableDDL';
import { buildViewDDLFromCache } from '../../../ddl/viewDDL';
import { buildProcedureDDLFromCache } from '../../../ddl/procedureDDL';
import { buildExternalTableDDLFromCache } from '../../../ddl/externalTableDDL';
import { buildSynonymDDLFromCache } from '../../../ddl/synonymDDL';
import { mapTableColumnsRows, RawTableColumnsRow } from '../../../metadata/columnMetadataService';

/**
 * Generate DDL for multiple objects in a database
 * OPTIMIZED: Uses bulk queries to fetch all metadata at once instead of per-object queries
 */
export async function generateBatchDDL(options: BatchDDLOptions): Promise<BatchDDLResult> {
    let connection: NzConnection | null = null;
    const errors: string[] = [];
    const ddlParts: string[] = [];
    let objectCount = 0;
    let skipped = 0;

    // Supported object types for DDL generation
    const supportedTypes = ['TABLE', 'VIEW', 'PROCEDURE', 'EXTERNAL TABLE', 'SYNONYM'];

    try {
        // Connect to the target database to ensure we can read all definition/source columns correctly
        connection = await createConnectionFromDetails(options.connectionDetails, options.database);

        const database = options.database.toUpperCase();
        const schemaFilter = options.schema ? options.schema.toUpperCase() : null;

        // Determine which object types to process
        let typesToProcess = options.objectTypes
            ? options.objectTypes.map(t => t.toUpperCase()).filter(t => supportedTypes.includes(t))
            : supportedTypes;

        if (typesToProcess.length === 0) {
            typesToProcess = supportedTypes;
        }

        // Add header
        ddlParts.push(`-- ============================================`);
        ddlParts.push(`-- Batch DDL Export`);
        ddlParts.push(`-- Database: ${database}`);
        if (schemaFilter) {
            ddlParts.push(`-- Schema: ${schemaFilter}`);
        }
        ddlParts.push(`-- Object Types: ${typesToProcess.join(', ')}`);
        ddlParts.push(`-- ============================================`);
        ddlParts.push('');

        // =====================================================
        // BULK FETCH: Fetch all metadata in a few large queries
        // =====================================================

        // Bulk data maps
        const allColumns = new Map<string, ColumnInfo[]>(); // key: "SCHEMA.OBJNAME"
        const allDistribution = new Map<string, string[]>();
        const allOrganize = new Map<string, string[]>();
        const allKeys = new Map<string, Map<string, KeyInfo>>();
        const allComments = new Map<string, string>();

        const processTables = typesToProcess.includes('TABLE');
        const processViews = typesToProcess.includes('VIEW');
        const processExternalTables = typesToProcess.includes('EXTERNAL TABLE');

        // Bulk fetch columns for all tables/views
        if (processTables || processViews || processExternalTables) {
            const schemaClause = buildSchemaFilter(schemaFilter, 'D.SCHEMA');
            const columnsQuery = `
                SELECT 
                    D.SCHEMA,
                    D.OBJNAME,
                    D.OBJTYPE,
                    X.ATTNAME,
                    X.DESCRIPTION,
                    X.FORMAT_TYPE AS FULL_TYPE,
                    X.ATTNOTNULL::BOOL AS ATTNOTNULL,
                    X.COLDEFAULT
                FROM ${escapeSqlIdentifier(database)}.._V_RELATION_COLUMN X
                INNER JOIN ${escapeSqlIdentifier(database)}.._V_OBJECT_DATA D ON X.OBJID = D.OBJID
                WHERE ${buildDatabaseFilter(database, 'D.DBNAME')}
                    AND D.OBJTYPE IN ('TABLE', 'VIEW', 'EXTERNAL TABLE')
                    ${schemaClause}
                ORDER BY D.SCHEMA, D.OBJNAME, X.ATTNUM
            `;
            try {
                interface ColumnRow extends RawTableColumnsRow {
                    SCHEMA: string;
                    OBJNAME: string;
                    OBJTYPE: string;
                }
                const colResults = await executeQueryHelper<ColumnRow>(connection!, columnsQuery);
                const rowsByTable = new Map<string, ColumnRow[]>();

                for (const row of colResults) {
                    const key = `${row.SCHEMA}.${row.OBJNAME}`;
                    if (!rowsByTable.has(key)) {
                        rowsByTable.set(key, []);
                    }
                    rowsByTable.get(key)!.push(row);
                }

                for (const [key, rows] of rowsByTable) {
                    const firstRow = rows[0];
                    const canonicalColumns = mapTableColumnsRows(rows, {
                        database,
                        schema: firstRow.SCHEMA,
                        tableName: firstRow.OBJNAME
                    });

                    allColumns.set(
                        key,
                        canonicalColumns.map(column => ({
                            name: column.columnName,
                            description: column.description || null,
                            fullTypeName: column.dataType,
                            notNull: column.isNotNull,
                            defaultValue: column.defaultValue
                        }))
                    );
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                errors.push(`Error bulk fetching columns: ${msg}`);
            }
        }

        // Bulk fetch distribution info for tables
        if (processTables) {
            const schemaClause = buildSchemaFilter(schemaFilter, 'SCHEMA');
            const distQuery = `
                SELECT SCHEMA, TABLENAME, ATTNAME
                FROM ${escapeSqlIdentifier(database)}.._V_TABLE_DIST_MAP
                WHERE 1=1 ${schemaClause}
                ORDER BY SCHEMA, TABLENAME, DISTSEQNO
            `;
            try {
                interface DistRow { SCHEMA: string; TABLENAME: string; ATTNAME: string; }
                const distResults = await executeQueryHelper<DistRow>(connection!, distQuery);
                for (const row of distResults) {
                    const key = `${row.SCHEMA}.${row.TABLENAME}`;
                    if (!allDistribution.has(key)) {
                        allDistribution.set(key, []);
                    }
                    allDistribution.get(key)!.push(row.ATTNAME);
                }
            } catch {
                // May not be available in all versions
            }
        }

        // Bulk fetch organize info for tables
        if (processTables) {
            const schemaClause = buildSchemaFilter(schemaFilter, 'SCHEMA');
            const orgQuery = `
                SELECT SCHEMA, TABLENAME, ATTNAME
                FROM ${escapeSqlIdentifier(database)}.._V_TABLE_ORGANIZE_COLUMN
                WHERE 1=1 ${schemaClause}
                ORDER BY SCHEMA, TABLENAME, ORGSEQNO
            `;
            try {
                interface OrgRow { SCHEMA: string; TABLENAME: string; ATTNAME: string; }
                const orgResults = await executeQueryHelper<OrgRow>(connection!, orgQuery);
                for (const row of orgResults) {
                    const key = `${row.SCHEMA}.${row.TABLENAME}`;
                    if (!allOrganize.has(key)) {
                        allOrganize.set(key, []);
                    }
                    allOrganize.get(key)!.push(row.ATTNAME);
                }
            } catch {
                // May not be available in all versions
            }
        }

        // Bulk fetch keys info for tables
        if (processTables) {
            const schemaClause = buildSchemaFilter(schemaFilter, 'X.SCHEMA');
            const keysQuery = `
                SELECT 
                    X.SCHEMA, X.RELATION, X.CONSTRAINTNAME, X.CONTYPE,
                    X.ATTNAME, X.PKDATABASE, X.PKSCHEMA, X.PKRELATION, X.PKATTNAME,
                    X.UPDT_TYPE, X.DEL_TYPE
                FROM ${escapeSqlIdentifier(database)}.._V_RELATION_KEYDATA X
                WHERE X.OBJID NOT IN (4,5) ${schemaClause}
                ORDER BY X.SCHEMA, X.RELATION, X.CONSTRAINTNAME, X.CONSEQ
            `;
            try {
                interface KeyRow {
                    SCHEMA: string; RELATION: string; CONSTRAINTNAME: string; CONTYPE: string;
                    ATTNAME: string; PKDATABASE: string; PKSCHEMA: string; PKRELATION: string; PKATTNAME: string;
                    UPDT_TYPE: string; DEL_TYPE: string;
                }
                const keysResults = await executeQueryHelper<KeyRow>(connection!, keysQuery);
                for (const row of keysResults) {
                    const tableKey = `${row.SCHEMA}.${row.RELATION}`;
                    if (!allKeys.has(tableKey)) {
                        allKeys.set(tableKey, new Map<string, KeyInfo>());
                    }
                    const tableKeys = allKeys.get(tableKey)!;
                    const keyName = row.CONSTRAINTNAME;
                    if (!tableKeys.has(keyName)) {
                        const typeCharMap: Record<string, string> = {
                            p: 'PRIMARY KEY',
                            f: 'FOREIGN KEY',
                            u: 'UNIQUE'
                        };
                        tableKeys.set(keyName, {
                            type: typeCharMap[row.CONTYPE] || 'UNKNOWN',
                            typeChar: row.CONTYPE,
                            columns: [],
                            pkDatabase: row.PKDATABASE || null,
                            pkSchema: row.PKSCHEMA || null,
                            pkRelation: row.PKRELATION || null,
                            pkColumns: [],
                            updateType: row.UPDT_TYPE || 'NO ACTION',
                            deleteType: row.DEL_TYPE || 'NO ACTION'
                        });
                    }
                    const keyInfo = tableKeys.get(keyName)!;
                    keyInfo.columns.push(row.ATTNAME);
                    if (row.PKATTNAME) keyInfo.pkColumns.push(row.PKATTNAME);
                }
            } catch {
                // Keys may not exist
            }
        }

        // Bulk fetch table comments
        if (processTables) {
            const schemaClause = buildSchemaFilter(schemaFilter, 'SCHEMA');
            const commentQuery = `
                SELECT SCHEMA, OBJNAME, DESCRIPTION
                FROM ${escapeSqlIdentifier(database)}.._V_OBJECT_DATA
                WHERE ${buildDatabaseFilter(database)} AND OBJTYPE = 'TABLE' AND DESCRIPTION IS NOT NULL ${schemaClause}
            `;
            try {
                interface CommentRow { SCHEMA: string; OBJNAME: string; DESCRIPTION: string; }
                const commentResults = await executeQueryHelper<CommentRow>(connection!, commentQuery);
                for (const row of commentResults) {
                    if (row.DESCRIPTION) {
                        allComments.set(`${row.SCHEMA}.${row.OBJNAME}`, row.DESCRIPTION);
                    }
                }
            } catch {
                // Comments optional
            }
        }

        const allProcedures = new Map<string, ProcedureInfo>();
        const allViews = new Map<string, string>();
        const allSynonyms = new Map<string, { refObjName: string; owner: string; description: string | null }>();
        const allExternalTables = new Map<string, ExternalTableInfo>();

        // Bulk fetch procedures
        if (typesToProcess.includes('PROCEDURE')) {
            const schemaClause = buildSchemaFilter(schemaFilter, 'SCHEMA');
            const procQuery = `
                SELECT 
                    SCHEMA,
                    PROCEDURESOURCE,
                    OBJID::INT,
                    RETURNS,
                    EXECUTEDASOWNER,
                    DESCRIPTION,
                    PROCEDURESIGNATURE,
                    PROCEDURE,
                    ARGUMENTS
                FROM ${escapeSqlIdentifier(database)}.._V_PROCEDURE
                WHERE ${buildDatabaseFilter(database, 'DATABASE')}
                    ${schemaClause}
            `;
            try {
                interface ProcRow {
                    SCHEMA: string;
                    PROCEDURESOURCE: string;
                    OBJID: number;
                    RETURNS: string;
                    EXECUTEDASOWNER: boolean | number | string;
                    DESCRIPTION: string;
                    PROCEDURESIGNATURE: string;
                    PROCEDURE: string;
                    ARGUMENTS: string;
                }
                const procResults = await executeQueryHelper<ProcRow>(connection!, procQuery);
                for (const row of procResults) {
                    const key = `${row.SCHEMA}.${row.PROCEDURESIGNATURE}`;
                    allProcedures.set(key, {
                        schema: row.SCHEMA,
                        procedureSource: row.PROCEDURESOURCE,
                        objId: row.OBJID,
                        returns: fixProcReturnType(row.RETURNS),
                        executeAsOwner: Boolean(row.EXECUTEDASOWNER),
                        description: row.DESCRIPTION || null,
                        procedureSignature: row.PROCEDURESIGNATURE,
                        procedureName: row.PROCEDURE,
                        arguments: row.ARGUMENTS || null
                    });
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                errors.push(`Error bulk fetching procedures: ${msg}`);
            }
        }

        // Bulk fetch views
        if (typesToProcess.includes('VIEW')) {
            const schemaClause = buildSchemaFilter(schemaFilter, 'SCHEMA');
            const viewQuery = `
                SELECT SCHEMA, VIEWNAME, DEFINITION
                FROM ${escapeSqlIdentifier(database)}.._V_VIEW
                WHERE ${buildDatabaseFilter(database, 'DATABASE')}
                    ${schemaClause}
            `;
            try {
                interface ViewRow { SCHEMA: string; VIEWNAME: string; DEFINITION: string; }
                const viewResults = await executeQueryHelper<ViewRow>(connection!, viewQuery);
                for (const row of viewResults) {
                    allViews.set(`${row.SCHEMA}.${row.VIEWNAME}`, row.DEFINITION || '');
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                errors.push(`Error bulk fetching views: ${msg}`);
            }
        }

        // Bulk fetch synonyms
        if (typesToProcess.includes('SYNONYM')) {
            const schemaClause = buildSchemaFilter(schemaFilter, 'SCHEMA');
            const synonymQuery = `
                SELECT SCHEMA, OWNER, SYNONYM_NAME, REFOBJNAME, DESCRIPTION
                FROM ${escapeSqlIdentifier(database)}.._V_SYNONYM
                WHERE ${buildDatabaseFilter(database, 'DATABASE')}
                    ${schemaClause}
            `;
            try {
                interface SynonymRow { SCHEMA: string; OWNER: string; SYNONYM_NAME: string; REFOBJNAME: string; DESCRIPTION: string; }
                const synonymResults = await executeQueryHelper<SynonymRow>(connection!, synonymQuery);
                for (const row of synonymResults) {
                    allSynonyms.set(`${row.SCHEMA}.${row.SYNONYM_NAME}`, {
                        refObjName: row.REFOBJNAME,
                        owner: row.OWNER,
                        description: row.DESCRIPTION || null
                    });
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                errors.push(`Error bulk fetching synonyms: ${msg}`);
            }
        }

        // Bulk fetch external tables
        if (typesToProcess.includes('EXTERNAL TABLE')) {
            const schemaClause = buildSchemaFilter(schemaFilter, 'E1.SCHEMA');
            const extQuery = `
                SELECT 
                    E1.SCHEMA, E1.TABLENAME, E2.EXTOBJNAME, E2.OBJID::INT, E1.DELIM, E1.ENCODING, E1.TIMESTYLE,
                    E1.REMOTESOURCE, E1.SKIPROWS, E1.MAXERRORS, E1.ESCAPE, E1.LOGDIR, E1.DECIMALDELIM,
                    E1.QUOTEDVALUE, E1.NULLVALUE, E1.CRINSTRING, E1.TRUNCSTRING, E1.CTRLCHARS, E1.IGNOREZERO,
                    E1.TIMEEXTRAZEROS, E1.Y2BASE, E1.FILLRECORD, E1.COMPRESS, E1.INCLUDEHEADER, E1.LFINSTRING,
                    E1.DATESTYLE, E1.DATEDELIM, E1.TIMEDELIM, E1.BOOLSTYLE, E1.FORMAT, E1.SOCKETBUFSIZE,
                    E1.RECORDDELIM, E1.MAXROWS, E1.REQUIREQUOTES, E1.RECORDLENGTH, E1.DATETIMEDELIM, E1.REJECTFILE
                FROM ${escapeSqlIdentifier(database)}.._V_EXTERNAL E1
                JOIN ${escapeSqlIdentifier(database)}.._V_EXTOBJECT E2 ON E1.RELID = E2.OBJID
                WHERE ${buildDatabaseFilter(database, 'E1.DATABASE')}
                    ${schemaClause}
            `;
            try {
                interface ExtRow {
                    SCHEMA: string; TABLENAME: string; EXTOBJNAME: string; OBJID: number; DELIM: string;
                    ENCODING: string; TIMESTYLE: string; REMOTESOURCE: string; SKIPROWS: number;
                    MAXERRORS: number; ESCAPE: string; LOGDIR: string; DECIMALDELIM: string;
                    QUOTEDVALUE: string; NULLVALUE: string; CRINSTRING: unknown; TRUNCSTRING: unknown;
                    CTRLCHARS: unknown; IGNOREZERO: unknown; TIMEEXTRAZEROS: unknown; Y2BASE: number; FILLRECORD: unknown;
                    COMPRESS: unknown; INCLUDEHEADER: unknown; LFINSTRING: unknown; DATESTYLE: string; DATEDELIM: string;
                    TIMEDELIM: string; BOOLSTYLE: string; FORMAT: string; SOCKETBUFSIZE: number;
                    RECORDDELIM: string; MAXROWS: number; REQUIREQUOTES: unknown; RECORDLENGTH: string;
                    DATETIMEDELIM: string; REJECTFILE: string;
                }
                const parseBool = (val: unknown): boolean | null => {
                    if (val === null || val === undefined) return null;
                    if (typeof val === 'boolean') return val;
                    if (typeof val === 'number') return val !== 0;
                    const s = String(val).toLowerCase();
                    return s === 't' || s === 'true' || s === '1' || s === 'yes' || s === 'on';
                };
                const extResults = await executeQueryHelper<ExtRow>(connection!, extQuery);
                for (const row of extResults) {
                    allExternalTables.set(`${row.SCHEMA}.${row.TABLENAME}`, {
                        schema: row.SCHEMA,
                        tableName: row.TABLENAME,
                        dataObject: row.EXTOBJNAME || null,
                        delimiter: row.DELIM || null,
                        encoding: row.ENCODING || null,
                        timeStyle: row.TIMESTYLE || null,
                        remoteSource: row.REMOTESOURCE || null,
                        skipRows: row.SKIPROWS || null,
                        maxErrors: row.MAXERRORS || null,
                        escapeChar: row.ESCAPE || null,
                        logDir: row.LOGDIR || null,
                        decimalDelim: row.DECIMALDELIM || null,
                        quotedValue: row.QUOTEDVALUE || null,
                        nullValue: row.NULLVALUE || null,
                        crInString: parseBool(row.CRINSTRING),
                        truncString: parseBool(row.TRUNCSTRING),
                        ctrlChars: parseBool(row.CTRLCHARS),
                        ignoreZero: parseBool(row.IGNOREZERO),
                        timeExtraZeros: parseBool(row.TIMEEXTRAZEROS),
                        y2Base: row.Y2BASE || null,
                        fillRecord: parseBool(row.FILLRECORD),
                        compress: parseBool(row.COMPRESS),
                        includeHeader: parseBool(row.INCLUDEHEADER),
                        lfInString: parseBool(row.LFINSTRING),
                        dateStyle: row.DATESTYLE || null,
                        dateDelim: row.DATEDELIM || null,
                        timeDelim: row.TIMEDELIM || null,
                        boolStyle: row.BOOLSTYLE || null,
                        format: row.FORMAT || null,
                        socketBufSize: row.SOCKETBUFSIZE || null,
                        recordDelim: row.RECORDDELIM ? String(row.RECORDDELIM).replace(/\r/g, '\\r').replace(/\n/g, '\\n') : null,
                        maxRows: row.MAXROWS || null,
                        requireQuotes: parseBool(row.REQUIREQUOTES),
                        recordLength: row.RECORDLENGTH || null,
                        dateTimeDelim: row.DATETIMEDELIM || null,
                        rejectFile: row.REJECTFILE || null
                    });
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                errors.push(`Error bulk fetching external tables: ${msg}`);
            }
        }

        // =====================================================
        // GENERATE DDL using pre-fetched data
        // =====================================================

        // Process each object type
        for (const objType of typesToProcess) {
            let objects: { name: string; schema: string }[] = [];

            try {
                if (objType === 'PROCEDURE') {
                    let query = `SELECT PROCEDURESIGNATURE AS OBJNAME, SCHEMA FROM ${escapeSqlIdentifier(database)}.._V_PROCEDURE WHERE ${buildDatabaseFilter(database, 'DATABASE')}`;
                    query += buildSchemaFilter(schemaFilter, 'SCHEMA');
                    query += ` ORDER BY SCHEMA, PROCEDURESIGNATURE`;
                    const result = await executeQueryHelper<{ OBJNAME: string; SCHEMA: string }>(connection!, query);
                    objects = result.map(r => ({ name: r.OBJNAME, schema: r.SCHEMA }));
                } else {
                    let query = `SELECT OBJNAME, SCHEMA FROM ${escapeSqlIdentifier(database)}.._V_OBJECT_DATA WHERE ${buildDatabaseFilter(database, 'DBNAME')} AND OBJTYPE = '${objType}'`;
                    query += buildSchemaFilter(schemaFilter, 'SCHEMA');
                    query += ` ORDER BY SCHEMA, OBJNAME`;
                    const result = await executeQueryHelper<{ OBJNAME: string; SCHEMA: string }>(connection!, query);
                    objects = result.map(r => ({ name: r.OBJNAME, schema: r.SCHEMA }));
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                errors.push(`Error querying ${objType}s: ${msg}`);
                continue;
            }

            if (objects.length === 0) continue;

            ddlParts.push(`-- ----------------------------------------`);
            ddlParts.push(`-- ${objType}S (${objects.length})`);
            ddlParts.push(`-- ----------------------------------------`);
            ddlParts.push('');

            for (const obj of objects) {
                try {
                    let ddlCode: string;
                    const key = `${obj.schema}.${obj.name}`;

                    switch (objType) {
                        case 'TABLE':
                            ddlCode = buildTableDDLFromCache(
                                database,
                                obj.schema,
                                obj.name,
                                allColumns.get(key) || [],
                                allDistribution.get(key) || [],
                                allOrganize.get(key) || [],
                                allKeys.get(key) || new Map(),
                                allComments.get(key) || null
                            );
                            break;
                        case 'VIEW':
                            ddlCode = buildViewDDLFromCache(
                                database,
                                obj.schema,
                                obj.name,
                                allViews.get(key) || ''
                            );
                            break;
                        case 'PROCEDURE':
                            const procData = allProcedures.get(key);
                            if (procData) {
                                ddlCode = buildProcedureDDLFromCache(database, obj.schema, procData);
                            } else {
                                throw new Error(`Metadata for procedure ${key} not found`);
                            }
                            break;
                        case 'EXTERNAL TABLE':
                            const extData = allExternalTables.get(key);
                            if (extData) {
                                ddlCode = buildExternalTableDDLFromCache(
                                    database,
                                    obj.schema,
                                    obj.name,
                                    extData,
                                    allColumns.get(key) || []
                                );
                            } else {
                                throw new Error(`Metadata for external table ${key} not found`);
                            }
                            break;
                        case 'SYNONYM':
                            const synData = allSynonyms.get(key);
                            if (synData) {
                                ddlCode = buildSynonymDDLFromCache(
                                    database,
                                    obj.name,
                                    synData.refObjName,
                                    synData.owner,
                                    obj.schema,
                                    synData.description
                                );
                            } else {
                                throw new Error(`Metadata for synonym ${key} not found`);
                            }
                            break;
                        default:
                            skipped++;
                            continue;
                    }

                    ddlParts.push(`-- ${objType}: ${database}.${obj.schema}.${obj.name}`);
                    ddlParts.push(ddlCode);
                    ddlParts.push('');
                    objectCount++;
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    errors.push(
                        `Error generating DDL for ${objType} ${database}.${obj.schema}.${obj.name}: ${msg}`
                    );
                    skipped++;
                }
            }
        }

        // Add footer
        ddlParts.push(`-- ============================================`);
        ddlParts.push(`-- End of Batch DDL Export`);
        ddlParts.push(`-- Total objects: ${objectCount}`);
        if (skipped > 0) ddlParts.push(`-- Skipped: ${skipped}`);
        if (errors.length > 0) ddlParts.push(`-- Errors: ${errors.length}`);
        ddlParts.push(`-- ============================================`);

        let finalDDL = ddlParts.join('\n');
        if (errors.length > 0) {
            const errorReport = [
                '-- ============================================',
                '-- ERROR REPORT',
                '-- The following errors occurred during generation:',
                ...errors.map(e => `-- ${e}`),
                '-- ============================================',
                ''
            ].join('\n');
            finalDDL = errorReport + finalDDL;
        }

        return {
            success: true,
            ddlCode: finalDDL,
            objectCount,
            errors,
            skipped
        };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            success: false,
            objectCount: 0,
            errors: [`Batch DDL generation error: ${msg}`],
            skipped: 0
        };
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch {
                // Ignore connection close errors during cleanup
            }
        }
    }
}
