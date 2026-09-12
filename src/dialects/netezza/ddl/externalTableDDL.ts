/**
 * DDL Generator - External Table DDL Generation
 */

import { buildNetezzaExternalTableDdl } from '@justybase/designer-core';
import type { ExternalTableInfo } from './types';
import { executeQueryHelper } from './helpers';
import { getExternalColumns } from './metadata';
import type { NzConnection } from '../../../types';

/**
 * Build external table DDL from metadata
 */
export function buildExternalTableDDLFromCache(
    database: string,
    schema: string,
    tableName: string,
    extInfo: ExternalTableInfo,
    columns: ColumnInfo[]
): string {
    return buildNetezzaExternalTableDdl(database, schema, tableName, extInfo, columns);
}

import type { ColumnInfo } from './types';

/**
 * Generate DDL code for creating an external table in Netezza
 */
export async function generateExternalTableDDL(
    connection: NzConnection,
    database: string,
    schema: string,
    tableName: string
): Promise<string> {
    interface ExternalTableRow {
        SCHEMA: string;
        TABLENAME: string;
        EXTOBJNAME: string;
        OBJID: number;
        DELIM: string;
        ENCODING: string;
        TIMESTYLE: string;
        REMOTESOURCE: string;
        SKIPROWS: number;
        MAXERRORS: number;
        ESCAPE: string;
        LOGDIR: string;
        DECIMALDELIM: string;
        QUOTEDVALUE: string;
        NULLVALUE: string;
        CRINSTRING: boolean | number | string;
        TRUNCSTRING: boolean | number | string;
        CTRLCHARS: boolean | number | string;
        IGNOREZERO: boolean | number | string;
        TIMEEXTRAZEROS: boolean | number | string;
        Y2BASE: number;
        FILLRECORD: boolean | number | string;
        COMPRESS: boolean | number | string;
        INCLUDEHEADER: boolean | number | string;
        LFINSTRING: boolean | number | string;
        DATESTYLE: string;
        DATEDELIM: string;
        TIMEDELIM: string;
        BOOLSTYLE: string;
        FORMAT: string;
        SOCKETBUFSIZE: number;
        RECORDDELIM: string;
        MAXROWS: number;
        REQUIREQUOTES: boolean | number | string;
        RECORDLENGTH: string;
        DATETIMEDELIM: string;
        REJECTFILE: string;
    }
    // Get external table properties
    const sql = `
        SELECT 
            E1.SCHEMA,
            E1.TABLENAME,
            E2.EXTOBJNAME,
            E2.OBJID::INT,
            E1.DELIM,
            E1.ENCODING,
            E1.TIMESTYLE,
            E1.REMOTESOURCE,
            E1.SKIPROWS,
            E1.MAXERRORS,
            E1.ESCAPE,
            E1.LOGDIR,
            E1.DECIMALDELIM,
            E1.QUOTEDVALUE,
            E1.NULLVALUE,
            E1.CRINSTRING,
            E1.TRUNCSTRING,
            E1.CTRLCHARS,
            E1.IGNOREZERO,
            E1.TIMEEXTRAZEROS,
            E1.Y2BASE,
            E1.FILLRECORD,
            E1.COMPRESS,
            E1.INCLUDEHEADER,
            E1.LFINSTRING,
            E1.DATESTYLE,
            E1.DATEDELIM,
            E1.TIMEDELIM,
            E1.BOOLSTYLE,
            E1.FORMAT,
            E1.SOCKETBUFSIZE,
            E1.RECORDDELIM,
            E1.MAXROWS,
            E1.REQUIREQUOTES,
            E1.RECORDLENGTH,
            E1.DATETIMEDELIM,
            E1.REJECTFILE
        FROM 
            ${database.toUpperCase()}.._V_EXTERNAL E1
            JOIN ${database.toUpperCase()}.._V_EXTOBJECT E2 ON E1.RELID = E2.OBJID
        WHERE 
            E1.DATABASE = '${database.toUpperCase()}'
            AND E1.SCHEMA = '${schema.toUpperCase()}'
            AND E1.TABLENAME = '${tableName.toUpperCase()}'
    `;

    const rows = await executeQueryHelper<ExternalTableRow>(connection, sql);

    if (rows.length === 0) {
        throw new Error(`External table ${database}.${schema}.${tableName} not found`);
    }

    const parseBool = (val: boolean | number | string | null | undefined): boolean | null => {
        if (val === null || val === undefined) return null;
        if (typeof val === 'boolean') return val;
        if (typeof val === 'number') return val !== 0;
        const s = String(val).toLowerCase();
        return s === 't' || s === 'true' || s === '1' || s === 'yes' || s === 'on';
    };

    const row = rows[0];
    const extInfo: ExternalTableInfo = {
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
        recordDelim: row.RECORDDELIM
            ? String(row.RECORDDELIM).replace(/\r/g, '\\r').replace(/\n/g, '\\n')
            : null,
        maxRows: row.MAXROWS || null,
        requireQuotes: parseBool(row.REQUIREQUOTES),
        recordLength: row.RECORDLENGTH || null,
        dateTimeDelim: row.DATETIMEDELIM || null,
        rejectFile: row.REJECTFILE || null
    };

    // Get columns
    const columns = await getExternalColumns(connection, database, schema, tableName);

    return buildExternalTableDDLFromCache(database, schema, tableName, extInfo, columns);
}
