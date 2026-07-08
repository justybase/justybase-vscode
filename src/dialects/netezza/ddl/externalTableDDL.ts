/**
 * DDL Generator - External Table DDL Generation
 */

import { ExternalTableInfo } from './types';
import { executeQueryHelper, quoteNameIfNeeded } from './helpers';
import { getColumns } from './metadata';
import { NzConnection } from '../../../types';

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
    const cleanDatabase = quoteNameIfNeeded(database);
    const cleanSchema = quoteNameIfNeeded(schema);
    const cleanTableName = quoteNameIfNeeded(tableName);

    const ddlLines: string[] = [];
    ddlLines.push(`CREATE EXTERNAL TABLE ${cleanDatabase}.${cleanSchema}.${cleanTableName}`);
    ddlLines.push('(');

    // Add columns
    const columnDefs = columns.map(col => {
        let def = `    ${quoteNameIfNeeded(col.name)} ${col.fullTypeName}`;
        if (col.notNull) {
            def += ' NOT NULL';
        }
        return def;
    });
    ddlLines.push(columnDefs.join(',\n'));
    ddlLines.push(')');

    ddlLines.push('USING');
    ddlLines.push('(');

    // Add external table options
    if (extInfo.dataObject !== null) {
        ddlLines.push(`    DATAOBJECT('${extInfo.dataObject}')`);
    }
    if (extInfo.delimiter !== null) {
        ddlLines.push(`    DELIMITER '${extInfo.delimiter}'`);
    }
    if (extInfo.encoding !== null) {
        ddlLines.push(`    ENCODING '${extInfo.encoding}'`);
    }
    if (extInfo.timeStyle !== null) {
        ddlLines.push(`    TIMESTYLE '${extInfo.timeStyle}'`);
    }
    if (extInfo.remoteSource !== null) {
        ddlLines.push(`    REMOTESOURCE '${extInfo.remoteSource}'`);
    }
    if (extInfo.maxErrors !== null) {
        ddlLines.push(`    MAXERRORS ${extInfo.maxErrors}`);
    }
    if (extInfo.escapeChar !== null) {
        ddlLines.push(`    ESCAPECHAR '${extInfo.escapeChar}'`);
    }
    if (extInfo.decimalDelim !== null) {
        ddlLines.push(`    DECIMALDELIM '${extInfo.decimalDelim}'`);
    }
    if (extInfo.logDir !== null) {
        ddlLines.push(`    LOGDIR '${extInfo.logDir}'`);
    }
    if (extInfo.quotedValue !== null) {
        ddlLines.push(`    QUOTEDVALUE '${extInfo.quotedValue}'`);
    }
    if (extInfo.nullValue !== null) {
        ddlLines.push(`    NULLVALUE '${extInfo.nullValue}'`);
    }
    if (extInfo.crInString !== null) {
        ddlLines.push(`    CRINSTRING ${extInfo.crInString}`);
    }
    if (extInfo.truncString !== null) {
        ddlLines.push(`    TRUNCSTRING ${extInfo.truncString}`);
    }
    if (extInfo.ctrlChars !== null) {
        ddlLines.push(`    CTRLCHARS ${extInfo.ctrlChars}`);
    }
    if (extInfo.ignoreZero !== null) {
        ddlLines.push(`    IGNOREZERO ${extInfo.ignoreZero}`);
    }
    if (extInfo.timeExtraZeros !== null) {
        ddlLines.push(`    TIMEEXTRAZEROS ${extInfo.timeExtraZeros}`);
    }
    if (extInfo.y2Base !== null) {
        ddlLines.push(`    Y2BASE ${extInfo.y2Base}`);
    }
    if (extInfo.fillRecord !== null) {
        ddlLines.push(`    FILLRECORD ${extInfo.fillRecord}`);
    }
    if (extInfo.compress !== null) {
        ddlLines.push(`    COMPRESS ${extInfo.compress}`);
    }
    if (extInfo.includeHeader !== null) {
        ddlLines.push(`    INCLUDEHEADER ${extInfo.includeHeader}`);
    }
    if (extInfo.lfInString !== null) {
        ddlLines.push(`    LFINSTRING ${extInfo.lfInString}`);
    }
    if (extInfo.dateStyle !== null) {
        ddlLines.push(`    DATESTYLE '${extInfo.dateStyle}'`);
    }
    if (extInfo.dateDelim !== null) {
        ddlLines.push(`    DATEDELIM '${extInfo.dateDelim}'`);
    }
    if (extInfo.timeDelim !== null) {
        ddlLines.push(`    TIMEDELIM '${extInfo.timeDelim}'`);
    }
    if (extInfo.boolStyle !== null) {
        ddlLines.push(`    BOOLSTYLE '${extInfo.boolStyle}'`);
    }
    if (extInfo.format !== null) {
        ddlLines.push(`    FORMAT '${extInfo.format}'`);
    }
    if (extInfo.socketBufSize !== null) {
        ddlLines.push(`    SOCKETBUFSIZE ${extInfo.socketBufSize}`);
    }
    if (extInfo.recordDelim !== null) {
        ddlLines.push(`    RECORDDELIM '${extInfo.recordDelim}'`);
    }
    if (extInfo.maxRows !== null) {
        ddlLines.push(`    MAXROWS ${extInfo.maxRows}`);
    }
    if (extInfo.requireQuotes !== null) {
        ddlLines.push(`    REQUIREQUOTES ${extInfo.requireQuotes}`);
    }
    if (extInfo.recordLength !== null) {
        ddlLines.push(`    RECORDLENGTH ${extInfo.recordLength}`);
    }
    if (extInfo.dateTimeDelim !== null) {
        ddlLines.push(`    DATETIMEDELIM '${extInfo.dateTimeDelim}'`);
    }
    if (extInfo.rejectFile !== null) {
        ddlLines.push(`    REJECTFILE '${extInfo.rejectFile}'`);
    }

    ddlLines.push(');');

    return ddlLines.join('\n');
}

import { ColumnInfo } from './types';

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
    const columns = await getColumns(connection, database, schema, tableName);

    return buildExternalTableDDLFromCache(database, schema, tableName, extInfo, columns);
}
