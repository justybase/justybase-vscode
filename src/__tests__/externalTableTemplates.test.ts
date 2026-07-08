import {
    ExternalTableParams,
    externalTableTemplates,
    generateAdvancedExternalTableSQL,
    generateBasicExternalTableSQL,
    getExternalTableTemplateById,
    getExternalTableTemplatesByCategory
} from '../providers/externalTableTemplates';

describe('externalTableTemplates', () => {
    const baseParams: ExternalTableParams = {
        database: 'MY_DB',
        schema: 'PUBLIC',
        tableName: 'EXT_TABLE',
        filePath: '/tmp/data.csv',
        columns: 'id INT, name VARCHAR(100)'
    };

    it('groups templates by category', () => {
        const grouped = getExternalTableTemplatesByCategory();

        expect(grouped.basic.length).toBeGreaterThan(0);
        expect(grouped.advanced.length).toBeGreaterThan(0);
        expect(grouped.basic.length + grouped.advanced.length).toBe(externalTableTemplates.length);
        expect(grouped.basic.every(template => template.category === 'basic')).toBe(true);
        expect(grouped.advanced.every(template => template.category === 'advanced')).toBe(true);
    });

    it('gets template by id and returns undefined for unknown id', () => {
        expect(getExternalTableTemplateById('basic-csv-simple')?.id).toBe('basic-csv-simple');
        expect(getExternalTableTemplateById('missing-template')).toBeUndefined();
    });

    it('generates SQL for all predefined templates', () => {
        for (const template of externalTableTemplates) {
            const sql = template.generate(baseParams);

            expect(sql).toContain('CREATE EXTERNAL TABLE');
            expect(sql).toContain(baseParams.filePath);
            expect(sql).toContain(baseParams.columns);
            expect(sql.length).toBeGreaterThan(40);
        }
    });

    it('escapes quoted identifiers in basic templates', () => {
        const template = getExternalTableTemplateById('basic-csv-simple');

        expect(template).toBeDefined();
        const sql = template!.generate({
            ...baseParams,
            database: 'db"name',
            schema: 'sc"hema',
            tableName: 'ta"ble'
        });

        expect(sql).toContain('"db""name"."sc""hema"."ta""ble"');
    });

    it('generates basic SQL with defaults', () => {
        const sql = generateBasicExternalTableSQL(baseParams);

        expect(sql).toContain("DELIMITER ','");
        expect(sql).toContain('SKIPROWS 0');
        expect(sql).not.toContain('HEADER');
    });

    it('generates basic SQL with explicit header', () => {
        const sql = generateBasicExternalTableSQL({
            ...baseParams,
            withHeader: true,
            skipRows: '1',
            delimiter: ';'
        });

        expect(sql).toContain("DELIMITER ';'");
        expect(sql).toContain('SKIPROWS 1');
        expect(sql).toContain('HEADER');
    });

    it('generates advanced SQL including only supplied options', () => {
        const sql = generateAdvancedExternalTableSQL({
            ...baseParams,
            delimiter: ';',
            skipRows: '2',
            withHeader: true,
            maxErrors: '5',
            noTruncate: true
        });

        expect(sql).toContain("DELIMITER ';'");
        expect(sql).toContain('SKIPROWS 2');
        expect(sql).toContain('HEADER');
        expect(sql).toContain('MAXERRORS 5');
        expect(sql).toContain('NOTRUNCATE');
        expect(sql).not.toContain('DATESTYLE');
        expect(sql).not.toContain('TIMESTYLE');
    });

    it('generates advanced SQL with all optional clauses', () => {
        const sql = generateAdvancedExternalTableSQL({
            ...baseParams,
            recordDelimiter: '\\n',
            delimiter: '|',
            nullValueAs: 'NULL',
            dateStyle: 'YMD',
            timeStyle: '24HR',
            quotedValue: 'YES',
            skipRows: '3',
            withHeader: true,
            batchSize: '10000',
            compression: 'GZIP',
            format: 'CSV',
            quoting: 'DOUBLE',
            escapeChar: '\\',
            maxErrors: '25',
            recordSize: '2048',
            logFile: '/tmp/ext.log',
            noTruncate: true
        });

        expect(sql).toContain("RECORDDELIMITER '\\n'");
        expect(sql).toContain("DELIMITER '|'");
        expect(sql).toContain("NULLVALUEAS 'NULL'");
        expect(sql).toContain("DATESTYLE 'YMD'");
        expect(sql).toContain("TIMESTYLE '24HR'");
        expect(sql).toContain('QUOTEDVALUE YES');
        expect(sql).toContain('BATCHSIZE 10000');
        expect(sql).toContain('COMPRESSION GZIP');
        expect(sql).toContain('FORMAT CSV');
        expect(sql).toContain('QUOTING DOUBLE');
        expect(sql).toContain("ESCAPECHAR '\\'");
        expect(sql).toContain('MAXERRORS 25');
        expect(sql).toContain('RECORDSIZE 2048');
        expect(sql).toContain("LOG '/tmp/ext.log'");
        expect(sql).toContain('NOTRUNCATE');
    });

    it('validates advanced options and throws for invalid numeric values', () => {
        expect(() =>
            generateAdvancedExternalTableSQL({
                ...baseParams,
                maxErrors: 'abc'
            })
        ).toThrow('MAXERRORS must be a non-negative integer.');
    });
});
