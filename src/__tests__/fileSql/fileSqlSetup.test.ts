import {
    buildEditableTableSql,
    buildFileViewSetupSql,
    buildFileWorkspaceViewSetupSql,
    buildSaveEditsSql,
    detectFileDataFormat,
    editableTableName,
    fileSheetViewName,
    fileTableViewName,
    fileTableViewNames,
    parseFileWorkspace,
    requiredDuckDbExtensions,
    serializeFileWorkspace,
    sanitizeViewName,
} from '../../../extensions/duckdb/src/fileSqlSetup';

describe('fileSqlSetup', () => {
    describe('detectFileDataFormat', () => {
        it('detects supported formats case-insensitively', () => {
            expect(detectFileDataFormat('/data/sales.xlsx')).toBe('xlsx');
            expect(detectFileDataFormat('/data/sales.xlsb')).toBe('xlsb');
            expect(detectFileDataFormat('/data/sales.csv')).toBe('csv');
            expect(detectFileDataFormat('/data/sales.TSV')).toBe('tsv');
            expect(detectFileDataFormat('/data/sales.parquet')).toBe('parquet');
            expect(detectFileDataFormat('/data/sales.avro')).toBe('avro');
            expect(detectFileDataFormat('/data/sales.mdb')).toBe('access');
            expect(detectFileDataFormat('/data/sales.ACCDB')).toBe('access');
        });

        it('returns undefined for unknown extensions', () => {
            expect(detectFileDataFormat('/data/sales.txt')).toBeUndefined();
            expect(detectFileDataFormat('/data/sales')).toBeUndefined();
        });
    });

    describe('sanitizeViewName', () => {
        it('strips extension and sanitizes the base name', () => {
            expect(sanitizeViewName('/data/sales 2024.xlsx')).toBe('sales_2024');
            expect(sanitizeViewName('/data/sales.xlsx')).toBe('sales');
            expect(sanitizeViewName('/data/my-file.parquet')).toBe('my_file');
        });

        it('falls back for empty names', () => {
            expect(sanitizeViewName('/.xlsx')).toBe('file');
        });
    });

    it('reuses collision-aware Access table view names', () => {
        expect(Array.from(fileTableViewNames('/data/orders.accdb', ['A-B', 'A_B']).values()))
            .toEqual(['orders__A_B', 'orders__A_B_2']);
    });

    describe('requiredDuckDbExtensions', () => {
        it('requires the excel extension for xlsx files', () => {
            expect(requiredDuckDbExtensions('xlsx')).toEqual(['excel']);
        });

        it('requires avro for avro files', () => {
            expect(requiredDuckDbExtensions('avro')).toEqual(['avro']);
        });

        it('requires nothing for csv/tsv/parquet/xlsb/access', () => {
            expect(requiredDuckDbExtensions('csv')).toEqual([]);
            expect(requiredDuckDbExtensions('tsv')).toEqual([]);
            expect(requiredDuckDbExtensions('parquet')).toEqual([]);
            expect(requiredDuckDbExtensions('xlsb')).toEqual([]);
            expect(requiredDuckDbExtensions('access')).toEqual([]);
        });
    });

    describe('buildFileViewSetupSql', () => {
        it('creates a single view for csv files', () => {
            const result = buildFileViewSetupSql('/data/sales.csv', 'csv');
            expect(result.statements).toHaveLength(1);
            expect(result.statements[0]).toBe(
                'CREATE OR REPLACE VIEW "sales" AS SELECT * FROM read_csv(\'/data/sales.csv\')',
            );
            expect(result.viewName).toBe('sales');
        });

        it('passes the delimiter for tsv files', () => {
            const result = buildFileViewSetupSql('/data/sales.tsv', 'tsv');
            expect(result.statements[0]).toContain(`delim='${'\t'}'`);
        });

        it('creates a view for parquet and avro files', () => {
            expect(buildFileViewSetupSql('/data/sales.parquet', 'parquet').statements[0]).toContain(
                "read_parquet('/data/sales.parquet')",
            );
            expect(buildFileViewSetupSql('/data/sales.avro', 'avro').statements[0]).toContain(
                "read_avro('/data/sales.avro')",
            );
        });

        it('creates per-sheet views plus a first-sheet view for xlsx', () => {
            const result = buildFileViewSetupSql('/data/sales.xlsx', 'xlsx', {
                discoveredSheets: ['Sheet1', 'Data 2024'],
            });
            expect(result.statements).toHaveLength(3);
            expect(result.statements[0]).toBe(
                'CREATE OR REPLACE VIEW "sales__Sheet1" AS SELECT * FROM read_xlsx(\'/data/sales.xlsx\', sheet=\'Sheet1\')',
            );
            expect(result.statements[1]).toBe(
                'CREATE OR REPLACE VIEW "sales__Data_2024" AS SELECT * FROM read_xlsx(\'/data/sales.xlsx\', sheet=\'Data 2024\')',
            );
            expect(result.statements[2]).toBe(
                'CREATE OR REPLACE VIEW "sales" AS SELECT * FROM read_xlsx(\'/data/sales.xlsx\')',
            );
            expect(result.sheetViewNames).toEqual(['sales__Sheet1', 'sales__Data_2024']);
            expect(result.usesPerSheetViews).toBe(true);
        });

        it('creates a single sheet view when a sheet is configured', () => {
            const result = buildFileViewSetupSql('/data/sales.xlsx', 'xlsx', { sheet: 'Data' });
            expect(result.statements).toHaveLength(1);
            expect(result.statements[0]).toContain("sheet='Data'");
            expect(result.usesPerSheetViews).toBe(false);
        });

        it('falls back to the first-sheet view when no sheets are discovered', () => {
            const result = buildFileViewSetupSql('/data/sales.xlsx', 'xlsx', { discoveredSheets: [] });
            expect(result.statements).toHaveLength(1);
            expect(result.statements[0]).toContain('read_xlsx(\'/data/sales.xlsx\')');
            expect(result.usesPerSheetViews).toBe(false);
        });

        it('escapes quotes in sheet names and paths', () => {
            const result = buildFileViewSetupSql("/data/sales.xlsx", 'xlsx', { sheet: "Bob's Data" });
            expect(result.statements[0]).toContain("sheet='Bob''s Data'");
        });

        it('disambiguates sheet names that sanitize to the same view name', () => {
            const result = buildFileViewSetupSql('/data/sales.xlsx', 'xlsx', {
                discoveredSheets: ['A-B', 'A_B'],
            });
            expect(result.sheetViewNames).toEqual(['sales__A_B', 'sales__A_B_2']);
            expect(result.statements[0]).toContain("sheet='A-B'");
            expect(result.statements[1]).toContain('"sales__A_B_2"');
            expect(result.statements[1]).toContain("sheet='A_B'");
        });

        it('creates per-sheet views over converted CSVs for xlsb', () => {
            const result = buildFileViewSetupSql('/data/sales.xlsb', 'xlsb', {
                discoveredSheets: ['Sheet1', 'Data 2024'],
                convertedTo: '/tmp/xlsb/sales.csv',
                sheetCsvPaths: new Map([
                    ['Sheet1', '/tmp/xlsb/sales.csv'],
                    ['Data 2024', '/tmp/xlsb/sales__Data_2024.csv'],
                ]),
            });
            expect(result.statements).toEqual([
                'CREATE OR REPLACE VIEW "sales__Sheet1" AS SELECT * FROM read_csv(\'/tmp/xlsb/sales.csv\')',
                'CREATE OR REPLACE VIEW "sales__Data_2024" AS SELECT * FROM read_csv(\'/tmp/xlsb/sales__Data_2024.csv\')',
                'CREATE OR REPLACE VIEW "sales" AS SELECT * FROM read_csv(\'/tmp/xlsb/sales.csv\')',
            ]);
            expect(result.sheetViewNames).toEqual(['sales__Sheet1', 'sales__Data_2024']);
            expect(result.usesPerSheetViews).toBe(true);
        });

        it('creates a single view for a selected xlsb sheet', () => {
            const result = buildFileViewSetupSql('/data/sales.xlsb', 'xlsb', {
                sheet: 'Data',
                convertedTo: '/tmp/xlsb/sales.csv',
            });
            expect(result.statements).toHaveLength(1);
            expect(result.statements[0]).toBe(
                'CREATE OR REPLACE VIEW "sales" AS SELECT * FROM read_csv(\'/tmp/xlsb/sales.csv\')',
            );
            expect(result.usesPerSheetViews).toBe(false);
        });

        it('throws when the converted CSV for xlsb is missing', () => {
            expect(() => buildFileViewSetupSql('/data/sales.xlsb', 'xlsb')).toThrow(/Missing converted CSV/);
        });

        it('creates one view per Access table and aliases the base view to the first table', () => {
            const result = buildFileViewSetupSql('/data/orders.mdb', 'access', {
                discoveredTables: ['Orders', 'Customers 2024'],
                tableCsvPaths: new Map([
                    ['Orders', '/tmp/file-sql/orders__Orders.csv'],
                    ['Customers 2024', '/tmp/file-sql/orders__Customers_2024.csv'],
                ]),
            });
            expect(result.statements).toEqual([
                'CREATE OR REPLACE VIEW "orders__Orders" AS SELECT * FROM read_csv(\'/tmp/file-sql/orders__Orders.csv\')',
                'CREATE OR REPLACE VIEW "orders__Customers_2024" AS SELECT * FROM read_csv(\'/tmp/file-sql/orders__Customers_2024.csv\')',
                'CREATE OR REPLACE VIEW "orders" AS SELECT * FROM "orders__Orders"',
            ]);
            expect(result.sheetViewNames).toEqual(['orders__Orders', 'orders__Customers_2024']);
            expect(result.usesPerSheetViews).toBe(true);
        });

        it('disambiguates Access table names that sanitize to the same view name', () => {
            const result = buildFileViewSetupSql('/data/orders.accdb', 'access', {
                discoveredTables: ['A-B', 'A_B'],
                tableCsvPaths: new Map([
                    ['A-B', '/tmp/file-sql/orders__A_B.csv'],
                    ['A_B', '/tmp/file-sql/orders__A_B_2.csv'],
                ]),
            });
            expect(result.sheetViewNames).toEqual(['orders__A_B', 'orders__A_B_2']);
        });

        it('throws when an Access file has no readable tables', () => {
            expect(() => buildFileViewSetupSql('/data/empty.accdb', 'access', { discoveredTables: [] }))
                .toThrow(/does not contain any readable tables/);
        });
    });

    describe('multi-file workspace setup', () => {
        it('serializes and parses a versioned, deduplicated workspace', () => {
            const encoded = serializeFileWorkspace(['/data/a.csv', '/data/a.csv', '/data/b.xlsx']);
            expect(parseFileWorkspace(encoded)).toEqual(['/data/a.csv', '/data/b.xlsx']);
            expect(parseFileWorkspace('{"version":2,"files":["/data/a.csv"]}')).toBeUndefined();
        });

        it('creates views named by full paths and all discovered workbook sheets', () => {
            const result = buildFileWorkspaceViewSetupSql([
                { filePath: '/data/a.csv', format: 'csv' },
                { filePath: '/data/b.xlsx', format: 'xlsx', discoveredSheets: ['Orders', 'Returns'] },
            ]);

            expect(result.statements).toEqual([
                'CREATE OR REPLACE VIEW "/data/a.csv" AS SELECT * FROM read_csv(\'/data/a.csv\')',
                'CREATE OR REPLACE VIEW "/data/b.xlsx#sheet=Orders" AS SELECT * FROM read_xlsx(\'/data/b.xlsx\', sheet=\'Orders\')',
                'CREATE OR REPLACE VIEW "/data/b.xlsx#sheet=Returns" AS SELECT * FROM read_xlsx(\'/data/b.xlsx\', sheet=\'Returns\')',
                'CREATE OR REPLACE VIEW "/data/b.xlsx" AS SELECT * FROM read_xlsx(\'/data/b.xlsx\')',
            ]);
            expect(result.viewNames).toEqual(['/data/a.csv', '/data/b.xlsx']);
            expect(result.sheetViewNames).toEqual([
                fileSheetViewName('/data/b.xlsx', 'Orders'),
                fileSheetViewName('/data/b.xlsx', 'Returns'),
            ]);
        });

        it('escapes quotes in full-path and sheet view names', () => {
            const result = buildFileWorkspaceViewSetupSql([
                { filePath: "/data/owner's.xlsx", format: 'xlsx', discoveredSheets: ['Bob"s Data'] },
            ]);
            expect(result.statements[0]).toContain('"/data/owner\'s.xlsx#sheet=Bob""s Data"');
            expect(result.statements[0]).toContain("read_xlsx('/data/owner''s.xlsx', sheet='Bob\"s Data')");
        });

        it('creates xlsb workspace views over converted CSVs', () => {
            const result = buildFileWorkspaceViewSetupSql([
                {
                    filePath: '/data/sales.xlsb',
                    format: 'xlsb',
                    discoveredSheets: ['Sheet1', 'Data 2024'],
                    convertedTo: '/tmp/xlsb/sales.csv',
                    sheetCsvPaths: new Map([
                        ['Sheet1', '/tmp/xlsb/sales.csv'],
                        ['Data 2024', '/tmp/xlsb/sales__Data_2024.csv'],
                    ]),
                },
                { filePath: '/data/a.csv', format: 'csv' },
            ]);

            expect(result.statements).toEqual([
                'CREATE OR REPLACE VIEW "/data/sales.xlsb#sheet=Sheet1" AS SELECT * FROM read_csv(\'/tmp/xlsb/sales.csv\')',
                'CREATE OR REPLACE VIEW "/data/sales.xlsb#sheet=Data 2024" AS SELECT * FROM read_csv(\'/tmp/xlsb/sales__Data_2024.csv\')',
                'CREATE OR REPLACE VIEW "/data/sales.xlsb" AS SELECT * FROM read_csv(\'/tmp/xlsb/sales.csv\')',
                'CREATE OR REPLACE VIEW "/data/a.csv" AS SELECT * FROM read_csv(\'/data/a.csv\')',
            ]);
            expect(result.sheetViewNames).toEqual([
                fileSheetViewName('/data/sales.xlsb', 'Sheet1'),
                fileSheetViewName('/data/sales.xlsb', 'Data 2024'),
            ]);
        });

        it('throws when the converted CSV for an xlsb workspace source is missing', () => {
            expect(() => buildFileWorkspaceViewSetupSql([{ filePath: '/data/sales.xlsb', format: 'xlsb' }]))
                .toThrow(/Missing converted CSV/);
        });

        it('creates #table= workspace views for Access sources (no path view)', () => {
            const result = buildFileWorkspaceViewSetupSql([
                {
                    filePath: '/data/orders.mdb',
                    format: 'access',
                    discoveredTables: ['Orders', 'Customers'],
                    tableCsvPaths: new Map([
                        ['Orders', '/tmp/file-sql/orders__Orders.csv'],
                        ['Customers', '/tmp/file-sql/orders__Customers.csv'],
                    ]),
                },
                { filePath: '/data/a.csv', format: 'csv' },
            ]);

            expect(result.statements).toEqual([
                'CREATE OR REPLACE VIEW "/data/orders.mdb#table=Orders" AS SELECT * FROM read_csv(\'/tmp/file-sql/orders__Orders.csv\')',
                'CREATE OR REPLACE VIEW "/data/orders.mdb#table=Customers" AS SELECT * FROM read_csv(\'/tmp/file-sql/orders__Customers.csv\')',
                'CREATE OR REPLACE VIEW "/data/a.csv" AS SELECT * FROM read_csv(\'/data/a.csv\')',
            ]);
            expect(result.viewNames).toEqual([
                fileTableViewName('/data/orders.mdb', 'Orders'),
                fileTableViewName('/data/orders.mdb', 'Customers'),
                '/data/a.csv',
            ]);
            expect(result.sheetViewNames).toEqual([
                fileTableViewName('/data/orders.mdb', 'Orders'),
                fileTableViewName('/data/orders.mdb', 'Customers'),
            ]);
        });

        it('throws when an Access workspace source has no readable tables', () => {
            expect(() => buildFileWorkspaceViewSetupSql([{ filePath: '/data/empty.mdb', format: 'access' }]))
                .toThrow(/does not contain any readable tables/);
        });
    });

    describe('editable table + save-back SQL', () => {
        it('names the editable table <view>_edit', () => {
            expect(editableTableName('/data/sales.csv')).toBe('sales_edit');
        });

        it('materializes the view into a table', () => {
            expect(buildEditableTableSql('/data/sales.csv')).toBe(
                'CREATE OR REPLACE TABLE "sales_edit" AS SELECT * FROM "sales"',
            );
        });

        it('builds COPY TO for csv with header', () => {
            const built = buildSaveEditsSql('/data/sales.csv', 'csv');
            expect(built.writesToNewFile).toBe(false);
            expect(built.sql).toBe(
                "COPY (SELECT * FROM \"sales_edit\") TO '/data/sales.csv' (FORMAT CSV, HEADER)",
            );
        });

        it('builds COPY TO for tsv with a tab delimiter', () => {
            const built = buildSaveEditsSql('/data/sales.tsv', 'tsv');
            expect(built.sql).toContain(`DELIMITER '${'\t'}'`);
        });

        it('builds COPY TO for parquet and keeps XLSX write-back client-side', () => {
            expect(buildSaveEditsSql('/data/sales.parquet', 'parquet').sql).toContain('(FORMAT PARQUET)');
            expect(() => buildSaveEditsSql('/data/sales.xlsx', 'xlsx')).toThrow(/XlsxUpdater/);
        });

        it('writes avro edits to a new parquet file', () => {
            const built = buildSaveEditsSql('/data/sales.avro', 'avro');
            expect(built.writesToNewFile).toBe(true);
            expect(built.targetPath).toBe('/data/sales_edited.parquet');
            expect(built.sql).toContain("TO '/data/sales_edited.parquet'");
            expect(built.sql).toContain('(FORMAT PARQUET)');
        });

        it('rejects xlsb save-back SQL (handled client-side by XlsbUpdater)', () => {
            expect(() => buildSaveEditsSql('/data/sales.xlsb', 'xlsb')).toThrow(/XlsbUpdater/);
        });

        it('rejects Access save-back SQL (read-only in File SQL mode)', () => {
            expect(() => buildSaveEditsSql('/data/sales.accdb', 'access')).toThrow(/read-only/);
        });
    });
});
