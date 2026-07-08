/**
 * Unit tests for ddl/externalTableDDL.ts - buildExternalTableDDLFromCache function
 */

import { buildExternalTableDDLFromCache } from '../ddl/externalTableDDL';
import { ExternalTableInfo, ColumnInfo } from '../ddl/types';

function makeExtInfo(overrides: Partial<ExternalTableInfo> = {}): ExternalTableInfo {
    return {
        schema: 'ADMIN',
        tableName: 'EXT_SALES',
        dataObject: '/data/sales.csv',
        delimiter: ',',
        encoding: 'internal',
        timeStyle: null,
        remoteSource: null,
        skipRows: null,
        maxErrors: null,
        escapeChar: null,
        logDir: null,
        decimalDelim: null,
        quotedValue: null,
        nullValue: null,
        crInString: null,
        truncString: null,
        ctrlChars: null,
        ignoreZero: null,
        timeExtraZeros: null,
        y2Base: null,
        fillRecord: null,
        compress: null,
        includeHeader: null,
        lfInString: null,
        dateStyle: null,
        dateDelim: null,
        timeDelim: null,
        boolStyle: null,
        format: null,
        socketBufSize: null,
        recordDelim: null,
        maxRows: null,
        requireQuotes: null,
        recordLength: null,
        dateTimeDelim: null,
        rejectFile: null,
        ...overrides
    };
}

function makeColumns(names: string[] = ['ID', 'NAME', 'AMOUNT']): ColumnInfo[] {
    return names.map(name => ({
        name,
        fullTypeName: name === 'AMOUNT' ? 'DECIMAL(18,2)' : name === 'ID' ? 'INTEGER' : 'VARCHAR(100)',
        notNull: name === 'ID',
        defaultValue: null,
        description: null
    }));
}

describe('ddl/externalTableDDL', () => {
    describe('buildExternalTableDDLFromCache', () => {
        it('should generate basic CREATE EXTERNAL TABLE with dataobject and delimiter', () => {
            const ddl = buildExternalTableDDLFromCache('MYDB', 'ADMIN', 'EXT_SALES', makeExtInfo(), makeColumns());

            expect(ddl).toContain('CREATE EXTERNAL TABLE MYDB.ADMIN.EXT_SALES');
            expect(ddl).toContain("DATAOBJECT('/data/sales.csv')");
            expect(ddl).toContain("DELIMITER ','");
            expect(ddl).toContain("ENCODING 'internal'");
        });

        it('should include all column definitions', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo(), makeColumns());

            expect(ddl).toContain('ID INTEGER NOT NULL');
            expect(ddl).toContain('NAME VARCHAR(100)');
            expect(ddl).toContain('AMOUNT DECIMAL(18,2)');
        });

        it('should not include NOT NULL for nullable columns', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo(), makeColumns());

            expect(ddl).not.toContain('NAME VARCHAR(100) NOT NULL');
        });

        it('should omit USING options that are null', () => {
            const extInfo = makeExtInfo({ delimiter: null, encoding: null, dataObject: null });
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', extInfo, makeColumns());

            expect(ddl).not.toContain('DATAOBJECT');
            expect(ddl).not.toContain('DELIMITER');
            expect(ddl).not.toContain('ENCODING');
        });

        it('should include TIMESTYLE when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ timeStyle: '24HOUR' }), makeColumns());
            expect(ddl).toContain("TIMESTYLE '24HOUR'");
        });

        it('should include REMOTESOURCE when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ remoteSource: 'odbc' }), makeColumns());
            expect(ddl).toContain("REMOTESOURCE 'odbc'");
        });

        it('should include MAXERRORS when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ maxErrors: 10 }), makeColumns());
            expect(ddl).toContain('MAXERRORS 10');
        });

        it('should include ESCAPECHAR when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ escapeChar: '\\' }), makeColumns());
            expect(ddl).toContain("ESCAPECHAR '\\'");
        });

        it('should include DECIMALDELIM when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ decimalDelim: '.' }), makeColumns());
            expect(ddl).toContain("DECIMALDELIM '.'");
        });

        it('should include LOGDIR when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ logDir: '/tmp/logs' }), makeColumns());
            expect(ddl).toContain("LOGDIR '/tmp/logs'");
        });

        it('should include QUOTEDVALUE when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ quotedValue: 'double' }), makeColumns());
            expect(ddl).toContain("QUOTEDVALUE 'double'");
        });

        it('should include NULLVALUE when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ nullValue: 'NULL' }), makeColumns());
            expect(ddl).toContain("NULLVALUE 'NULL'");
        });

        it('should include boolean options when set to true', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({
                crInString: true,
                truncString: true,
                includeHeader: true,
                compress: true,
                ctrlChars: false,
                ignoreZero: false,
                fillRecord: false
            }), makeColumns());

            expect(ddl).toContain('CRINSTRING true');
            expect(ddl).toContain('TRUNCSTRING true');
            expect(ddl).toContain('INCLUDEHEADER true');
            expect(ddl).toContain('COMPRESS true');
            expect(ddl).toContain('CTRLCHARS false');
            expect(ddl).toContain('IGNOREZERO false');
            expect(ddl).toContain('FILLRECORD false');
        });

        it('should include DATESTYLE and DATEDELIM when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({
                dateStyle: 'YMD',
                dateDelim: '-'
            }), makeColumns());

            expect(ddl).toContain("DATESTYLE 'YMD'");
            expect(ddl).toContain("DATEDELIM '-'");
        });

        it('should include TIMEDELIM when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ timeDelim: ':' }), makeColumns());
            expect(ddl).toContain("TIMEDELIM ':'");
        });

        it('should include BOOLSTYLE when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ boolStyle: 'T_F' }), makeColumns());
            expect(ddl).toContain("BOOLSTYLE 'T_F'");
        });

        it('should include FORMAT when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ format: 'text' }), makeColumns());
            expect(ddl).toContain("FORMAT 'text'");
        });

        it('should include SOCKETBUFSIZE when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ socketBufSize: 8192 }), makeColumns());
            expect(ddl).toContain('SOCKETBUFSIZE 8192');
        });

        it('should include RECORDDELIM when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ recordDelim: '\\n' }), makeColumns());
            expect(ddl).toContain("RECORDDELIM '\\n'");
        });

        it('should include MAXROWS when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ maxRows: 1000 }), makeColumns());
            expect(ddl).toContain('MAXROWS 1000');
        });

        it('should include REQUIREQUOTES when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ requireQuotes: true }), makeColumns());
            expect(ddl).toContain('REQUIREQUOTES true');
        });

        it('should include RECORDLENGTH when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ recordLength: '1024' }), makeColumns());
            expect(ddl).toContain('RECORDLENGTH 1024');
        });

        it('should include DATETIMEDELIM when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ dateTimeDelim: ' ' }), makeColumns());
            expect(ddl).toContain("DATETIMEDELIM ' '");
        });

        it('should include REJECTFILE when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ rejectFile: '/tmp/rej.txt' }), makeColumns());
            expect(ddl).toContain("REJECTFILE '/tmp/rej.txt'");
        });

        it('should include TIMEEXTRAZEROS when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ timeExtraZeros: true }), makeColumns());
            expect(ddl).toContain('TIMEEXTRAZEROS true');
        });

        it('should include LFINSTRING when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ lfInString: true }), makeColumns());
            expect(ddl).toContain('LFINSTRING true');
        });

        it('should include Y2BASE when provided', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo({ y2Base: 1970 }), makeColumns());
            expect(ddl).toContain('Y2BASE 1970');
        });

        it('should quote identifiers with special characters', () => {
            const ddl = buildExternalTableDDLFromCache('my-db', 'my-schema', 'my-table', makeExtInfo(), makeColumns());

            expect(ddl).toContain('"my-db"."my-schema"."my-table"');
        });

        it('should end with semicolon', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo(), makeColumns());
            expect(ddl.trimEnd().endsWith(';')).toBe(true);
        });

        it('should handle all-null external info (minimal output)', () => {
            const minimalInfo = makeExtInfo({
                dataObject: null,
                delimiter: null,
                encoding: null
            });
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', minimalInfo, makeColumns());

            expect(ddl).toContain('CREATE EXTERNAL TABLE');
            expect(ddl).toContain('USING');
            expect(ddl).toContain(');');
        });

        it('should handle empty columns array', () => {
            const ddl = buildExternalTableDDLFromCache('DB', 'S', 'T', makeExtInfo(), []);
            expect(ddl).toContain('CREATE EXTERNAL TABLE DB.S.T');
            expect(ddl).toContain('USING');
        });
    });
});
